import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import {
  BRIDGE_STATE_FILE,
  BRIDGE_STATE_MODE,
  LauncherError,
  assertPrivateSocket,
  defaultAgentDir,
  parseLaunchSpecDocument,
  resolveAgentDir,
  sanitizeHostEnvironment,
  start,
  stop,
  type CommandResult,
  type RunCommand,
  type StartedBridge,
} from "../src/launcher";
import { BASIC_USERNAME, createServer } from "../src/http/server";
import { probeModelAvailability, type BridgeRuntime } from "../src/runtime";
import { SenpiTransportError } from "../src/senpi/errors";
import type { SenpiTransport } from "../src/senpi/transport";

const repoRoot = join(import.meta.dir, "..");
const PASSWORD = "launcher-password";
const AGENT_DIR = "/tmp/omo-bridge-launcher-agent";

const SESSIONS = [
  {
    sessionId: "rpc-1",
    durableSessionId: "durable-1",
    sessionPath: join(tmpdir(), "launcher-session.jsonl"),
    cwd: tmpdir(),
    name: "Launcher session",
    status: "open",
    attachments: 1,
  },
];

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
type FakeTransport = ReturnType<typeof createFakeTransport>;

function deferred<T>(): Deferred<T> {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function createFakeTransport(): {
  transport: SenpiTransport;
  opened: Array<Record<string, unknown> | undefined>;
  aborts: Array<Record<string, unknown> | undefined>;
  connectCalls: () => number;
  setConnectGate: (gate: Promise<void>) => void;
  emitDisconnect: (error: unknown) => void;
} {
  const disconnectListeners = new Set<(error: unknown) => void>();
  const opened: Array<Record<string, unknown> | undefined> = [];
  const aborts: Array<Record<string, unknown> | undefined> = [];
  let gate: Promise<void> | undefined;
  let connects = 0;

  const transport = {
    sessionId: "rpc-1" as string | undefined,
    async connect(): Promise<void> {
      connects += 1;
      if (gate !== undefined) await gate;
    },
    async openSession(options?: Record<string, unknown>): Promise<{ sessionId: string }> {
      opened.push(options);
      return { sessionId: "rpc-1" };
    },
    onDisconnect(listener: (error: unknown) => void): () => void {
      disconnectListeners.add(listener);
      return () => {
        disconnectListeners.delete(listener);
      };
    },
    async dispose(): Promise<void> {},
    async listSessions(): Promise<typeof SESSIONS> {
      return SESSIONS;
    },
    async getState(): Promise<unknown> {
      return { sessionId: "rpc-1", isStreaming: false };
    },
    async getEntries(): Promise<unknown> {
      return { entries: [], leafId: null };
    },
    async getMessages(): Promise<unknown[]> {
      return [];
    },
    async prompt(): Promise<unknown> {
      return { disposition: "started" };
    },
    async steer(): Promise<unknown> {
      return {};
    },
    async followUp(): Promise<unknown> {
      return {};
    },
    async setSessionName(): Promise<void> {},
    async abort(options?: Record<string, unknown>): Promise<unknown> {
      aborts.push(options);
      return { stopped: true };
    },
    async getPendingInputs(): Promise<unknown> {
      return {
        inputs: [
          {
            clientMessageId: "msg_launcher_1",
            text: "queued through the proxy",
            requestedMode: "steer",
            state: "queued",
          },
        ],
      };
    },
    raw: { request: async (): Promise<unknown> => ({}) },
  };

  return {
    transport: transport as unknown as SenpiTransport,
    opened,
    aborts,
    connectCalls: () => connects,
    setConnectGate: (next: Promise<void>) => {
      gate = next;
    },
    emitDisconnect: (error: unknown) => {
      for (const listener of [...disconnectListeners]) listener(error);
    },
  };
}

function fakeRuntime(transport: SenpiTransport | undefined, env: NodeJS.ProcessEnv): BridgeRuntime {
  const config = resolveConfig(env);
  const server = createServer(config);
  return {
    config,
    server,
    transport,
    sessionMap: {} as BridgeRuntime["sessionMap"],
    close: async () => {
      await server.stop(true);
    },
  };
}

function baseEnv(stateDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OMO_BRIDGE_PORT: "0",
    OMO_BRIDGE_PASSWORD: PASSWORD,
    OMO_BRIDGE_STATE_DIR: stateDir,
    OMO_CODING_AGENT_DIR: AGENT_DIR,
    ...extra,
  };
}

function ensureRunCommand(stateDir: string): { calls: string[][]; runCommand: RunCommand } {
  const calls: string[][] = [];
  const runCommand: RunCommand = async (argv, _env, _timeout) => {
    calls.push([...argv]);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ action: "start", socket: join(stateDir, "senpi.sock"), pid: 4242 }),
      stderr: "",
    };
  };
  return { calls, runCommand };
}

function basicAuth(password: string = PASSWORD): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${password}`, "utf8").toString("base64")}` };
}

function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const temporaryDirectories: string[] = [];
const startedBridges: StartedBridge[] = [];

function tempStateDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-bridge-launcher-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function launch(options: Parameters<typeof start>[0]): Promise<StartedBridge> {
  const started = await start(options);
  startedBridges.push(started);
  return started;
}

afterEach(async () => {
  for (const started of startedBridges.splice(0)) await started.stop().catch(() => undefined);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("launch spec", () => {
  test("the shipped launch spec declares OMO_NATIVE and exactly one extension", () => {
    const specPath = join(repoRoot, "launch-spec.json");
    const document = parseLaunchSpecDocument(readFileSync(specPath, "utf8"), specPath);
    expect(document.spec_version).toBe(1);
    expect(document.core.multi_session).toBe(true);
    expect(document.core.extensions).toHaveLength(1);
    expect(document.env).toEqual({ OMO_NATIVE: "1" });
  });
});

describe("private host agent directory", () => {
  const isolatedHome = "/tmp/omo-bridge-isolated-home";
  const realAgentDir = (): string => join(userInfo().homedir, ".omo", "agent");

  test("defaults to the real user's ~/.omo/agent even under an isolated HOME", () => {
    expect(defaultAgentDir()).toBe(realAgentDir());
    expect(resolveAgentDir({})).toBe(realAgentDir());
    expect(resolveAgentDir({ HOME: isolatedHome })).toBe(realAgentDir());
  });

  test("OMO_BRIDGE_AGENT_DIR overrides every other setting and reaches the host and runtime", async () => {
    const stateDir = tempStateDir();
    const override = join(stateDir, "agent-override");
    let hostEnv: Record<string, string> | undefined;
    let runtimeEnv: NodeJS.ProcessEnv | undefined;

    const started = await launch({
      env: {
        PATH: process.env.PATH,
        HOME: isolatedHome,
        OMO_BRIDGE_PORT: "0",
        OMO_BRIDGE_PASSWORD: PASSWORD,
        OMO_BRIDGE_STATE_DIR: stateDir,
        OMO_CODING_AGENT_DIR: join(stateDir, "wrong-agent"),
        OMO_BRIDGE_AGENT_DIR: override,
      },
      deps: {
        runCommand: async (_argv, env) => {
          hostEnv = env;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ action: "start", socket: join(stateDir, "senpi.sock"), pid: 4242 }),
            stderr: "",
          } satisfies CommandResult;
        },
        createRuntime: async (env) => {
          runtimeEnv = env;
          return fakeRuntime(undefined, env);
        },
      },
    });

    expect(hostEnv?.OMO_CODING_AGENT_DIR).toBe(override);
    expect(runtimeEnv?.OMO_BRIDGE_KEY_ROOT).toBe(override);
    expect(started.agentDir).toBe(override);
  });

  test("the private host gets the real agent dir when nothing overrides it", async () => {
    const stateDir = tempStateDir();
    let hostEnv: Record<string, string> | undefined;

    await launch({
      env: {
        PATH: process.env.PATH,
        HOME: isolatedHome,
        OMO_BRIDGE_PORT: "0",
        OMO_BRIDGE_PASSWORD: PASSWORD,
        OMO_BRIDGE_STATE_DIR: stateDir,
      },
      deps: {
        runCommand: async (_argv, env) => {
          hostEnv = env;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ action: "start", socket: join(stateDir, "senpi.sock"), pid: 4242 }),
            stderr: "",
          } satisfies CommandResult;
        },
        createRuntime: async (env) => fakeRuntime(undefined, env),
      },
    });

    expect(hostEnv?.OMO_CODING_AGENT_DIR).toBe(realAgentDir());
  });

  test("the shared daemon socket is still refused", () => {
    const shared = join(homedir(), ".omo", "agent", "rpc", "rpc.sock");
    expect(() => assertPrivateSocket(shared)).toThrow(LauncherError);
    expect(() => assertPrivateSocket(shared)).toThrow("shared senpi socket");
    expect(() => assertPrivateSocket(shared, tempStateDir())).toThrow("shared senpi socket");
  });
});

describe("model catalog probe", () => {
  const model = (provider: string, id: string) => ({ provider, id, contextWindow: 200_000, reasoning: false });

  test("a fake host with zero models logs the counts and warns about OMO_BRIDGE_AGENT_DIR", async () => {
    const logged: string[] = [];
    const warned: string[] = [];

    const report = await probeModelAvailability(
      { getAvailableModels: async () => [] },
      { log: (message) => logged.push(message), warn: (message) => warned.push(message) },
    );

    expect(report).toEqual({ models: 0, providers: 0 });
    expect(logged).toEqual(["omo-bridge: models=0 providers=0"]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("OMO_BRIDGE_AGENT_DIR");
  });

  test("a populated catalog counts models and distinct providers without a warning", async () => {
    const logged: string[] = [];
    const warned: string[] = [];

    const report = await probeModelAvailability(
      { getAvailableModels: async () => [model("kimi", "k2"), model("kimi", "k3"), model("ollama", "qwen")] },
      { log: (message) => logged.push(message), warn: (message) => warned.push(message) },
    );

    expect(report).toEqual({ models: 3, providers: 2 });
    expect(logged).toEqual(["omo-bridge: models=3 providers=2"]);
    expect(warned).toHaveLength(0);
  });
});

describe("start", () => {
  test("the installed proxy serves the inbox family instead of the 503 fallback", async () => {
    const stateDir = tempStateDir();
    const { runCommand } = ensureRunCommand(stateDir);
    const fake = createFakeTransport();

    const started = await launch({
      env: baseEnv(stateDir),
      deps: {
        runCommand,
        createRuntime: async (env) => fakeRuntime(fake.transport, env),
      },
    });

    const url = `http://127.0.0.1:${started.runtime.server.port}`;
    const inbox = await fetch(`${url}/api/session/durable-1/inbox`, { headers: basicAuth() });
    expect(inbox.status).toBe(200);
    const body = (await inbox.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((item) => [item.id, item.text, item.delivery])).toEqual([
      ["msg_launcher_1", "queued through the proxy", "steer"],
    ]);

    const interrupted = await fetch(`${url}/api/session/durable-1/interrupt`, {
      method: "POST",
      headers: { ...basicAuth(), "content-type": "application/json" },
      body: "{}",
    });
    expect(interrupted.status).toBe(200);
    expect(await interrupted.json()).toEqual({ interrupted: true });
    expect(fake.aborts).toEqual([{ intent: "stop" }]);
  });

  test("a stale bridge.json from a dead pid is replaced with this process's record", async () => {
    const stateDir = tempStateDir();
    const stateFile = join(stateDir, BRIDGE_STATE_FILE);
    writeFileSync(
      stateFile,
      JSON.stringify({
        url: "http://127.0.0.1:9",
        pid: 999_999,
        password: "stale-password",
        socket: join(stateDir, "senpi.sock"),
      }),
      { mode: BRIDGE_STATE_MODE },
    );
    const { calls, runCommand } = ensureRunCommand(stateDir);

    const started = await launch({
      env: baseEnv(stateDir),
      deps: {
        isPidAlive: () => false,
        runCommand,
        createRuntime: async (env) => fakeRuntime(undefined, env),
      },
    });

    const recorded = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    expect(recorded.pid).toBe(process.pid);
    expect(recorded.password).toBe(PASSWORD);
    expect(recorded.socket).toBe(join(stateDir, "senpi.sock"));
    expect(String(recorded.url)).toStartWith("http://127.0.0.1:");
    expect(statSync(stateFile).mode & 0o777).toBe(BRIDGE_STATE_MODE);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("ensure");
    expect(started.state.pid).toBe(process.pid);
  });

  test("hosts are started with a sanitized environment and the bridge's key root", async () => {
    const stateDir = tempStateDir();
    let hostEnv: Record<string, string> | undefined;
    let runtimeEnv: NodeJS.ProcessEnv | undefined;

    await launch({
      env: baseEnv(stateDir, {
        BUN_BE_BUN: "1",
        SENPI_RPC_INTERNAL_KEY_STDIN: "1",
        SENPI_RPC_HOST_WATCH_PPID: "42",
        SENPI_RPC_HOST_INSTANCE_ID: "host-instance",
        PI_SESSION_ID: "session-id",
        PI_MODEL: "model-x",
      }),
      deps: {
        runCommand: async (_argv, env) => {
          hostEnv = env;
          return {
            exitCode: 0,
            stdout: JSON.stringify({ action: "start", socket: join(stateDir, "senpi.sock"), pid: 4242 }),
            stderr: "",
          } satisfies CommandResult;
        },
        createRuntime: async (env) => {
          runtimeEnv = env;
          return fakeRuntime(undefined, env);
        },
      },
    });

    expect(hostEnv).toBeDefined();
    for (const key of [
      "BUN_BE_BUN",
      "SENPI_RPC_INTERNAL_KEY_STDIN",
      "SENPI_RPC_HOST_WATCH_PPID",
      "SENPI_RPC_HOST_INSTANCE_ID",
      "PI_SESSION_ID",
      "PI_MODEL",
    ]) {
      expect(hostEnv).not.toHaveProperty(key);
    }
    expect(hostEnv?.PATH).toBe(process.env.PATH);
    expect(hostEnv?.OMO_CODING_AGENT_DIR).toBe(AGENT_DIR);

    expect(runtimeEnv?.OMO_BRIDGE_KEY_ROOT).toBe(AGENT_DIR);
    expect(runtimeEnv?.OMO_BRIDGE_SENPI_SOCKET).toBe(join(stateDir, "senpi.sock"));
    expect(runtimeEnv?.OMO_BRIDGE_PASSWORD).toBe(PASSWORD);

    const sanitized = sanitizeHostEnvironment({
      PATH: "/bin",
      BUN_BE_BUN: "1",
      SENPI_RPC_INTERNAL_KEY_STDIN: "1",
      SENPI_RPC_HOST_SCRATCH_DIR: "/scratch",
    });
    expect(sanitized).toEqual({ PATH: "/bin" });
  });
});

describe("stop", () => {
  test("ends the recorded pid and asks the host to stop only the recorded private socket", async () => {
    const stateDir = tempStateDir();
    const socketPath = join(stateDir, "senpi.sock");
    const stateFile = join(stateDir, BRIDGE_STATE_FILE);
    const listener = Bun.listen<undefined>({
      unix: socketPath,
      socket: {
        open() {},
        data() {},
        close() {},
      },
    });
    const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const calls: string[][] = [];

    writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://127.0.0.1:9", pid: sleeper.pid, password: PASSWORD, socket: socketPath }),
      { mode: BRIDGE_STATE_MODE },
    );

    try {
      const report = await stop({
        env: baseEnv(stateDir),
        deps: {
          runCommand: async (argv) => {
            calls.push([...argv]);
            listener.stop(true);
            return { exitCode: 0, stdout: JSON.stringify({ action: "stopped", socket: socketPath }), stderr: "" };
          },
        },
      });

      expect(report.stopped).toBe(true);
      expect(report.pid).toBe(sleeper.pid);
      expect(report.socket).toBe(socketPath);
      expect(await settledWithin(sleeper.exited, 5_000)).toBe(true);
      expect(existsSync(stateFile)).toBe(false);
      expect(statSync(socketPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(["omo", "host", "stop", "--socket", socketPath, "--json"]);
      expect(calls.flat().some((value) => value.includes(join(".omo", "agent", "rpc")))).toBe(false);
    } finally {
      listener.stop(true);
      if (alive(sleeper.pid)) sleeper.kill();
    }
  });

  test("refuses a record that names the shared daemon socket", async () => {
    const stateDir = tempStateDir();
    const sharedSocket = join(homedir(), ".omo", "agent", "rpc", "rpc.sock");
    const stateFile = join(stateDir, BRIDGE_STATE_FILE);
    const sleeper = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const calls: string[][] = [];

    writeFileSync(
      stateFile,
      JSON.stringify({ url: "http://127.0.0.1:9", pid: sleeper.pid, password: PASSWORD, socket: sharedSocket }),
      { mode: BRIDGE_STATE_MODE },
    );

    try {
      const error = await stop({
        env: baseEnv(stateDir),
        deps: {
          runCommand: async (argv) => {
            calls.push([...argv]);
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
        },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(LauncherError);
      expect((error as Error).message).toContain("shared senpi socket");
      expect(calls).toHaveLength(0);
      expect(alive(sleeper.pid)).toBe(true);
      expect(existsSync(stateFile)).toBe(true);
    } finally {
      if (alive(sleeper.pid)) sleeper.kill();
    }
  });
});

describe("session recovery", () => {
  test("a transport_gone transition answers 503 until the host is reattached and the session reopened", async () => {
    const stateDir = tempStateDir();
    const fake = createFakeTransport();
    const gate = deferred<void>();
    fake.setConnectGate(gate.promise);

    const started = await launch({
      env: baseEnv(stateDir),
      deps: {
        runCommand: ensureRunCommand(stateDir).runCommand,
        reconnectDelaysMs: [0],
        createRuntime: async (env) => fakeRuntime(fake.transport, env),
      },
    });

    const base = started.state.url;
    const getSessions = (): Promise<Response> =>
      fetch(`${base}/api/session`, { headers: basicAuth() });

    expect((await getSessions()).status).toBe(200);
    expect(started.recovery?.state).toBe("attached");

    await started.transport?.openSession({ sessionPath: "/sessions/restored.jsonl" });

    fake.emitDisconnect(new SenpiTransportError("transport_gone", "private host went away"));

    expect(started.recovery?.state).toBe("detached");
    const reattached = started.recovery?.waitForState("attached", 5_000);
    expect(reattached).toBeDefined();
    const degraded = await getSessions();
    expect(degraded.status).toBe(503);
    const body = (await degraded.json()) as Record<string, unknown>;
    expect(body._tag).toBe("ServiceUnavailableError");

    gate.resolve();
    await reattached;

    expect(started.recovery?.state).toBe("attached");
    expect(fake.connectCalls()).toBe(1);
    expect(started.recovery?.attempts).toBe(1);
    expect(fake.opened.at(-1)).toEqual({ sessionPath: "/sessions/restored.jsonl", retainOnDisconnect: true });

    const healed = await getSessions();
    expect(healed.status).toBe(200);
    const sessions = (await healed.json()) as { data?: Array<Record<string, unknown>> };
    expect(sessions.data?.[0]?.id).toBe("durable-1");
  });
});
