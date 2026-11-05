import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RpcTransportGoneError } from "@code-yeongyu/senpi";
import { SenpiTransportError, mapSenpiError } from "../../src/senpi/errors";
import { handleSessionInboxList, setSessionInboxTransport } from "../../src/http/handlers/inbox";
import { loadAttachClient } from "../../src/senpi/raw";
import { SenpiTransport } from "../../src/senpi/transport";
import { FakeSenpiHost } from "./fake-host";

const repoRoot = join(import.meta.dir, "..", "..");

/**
 * The stdout spy must run in a fresh process: every test file shares one module registry, so an
 * in-process import of the transport would be a cache hit and assert nothing. That child pays Bun's
 * startup plus the transport's import graph (measured: ~1.1 s on an idle machine, past 5 s while the
 * machine is loaded), so it runs while this file is evaluated instead of inside a test body. The
 * assertion is about import-time stdout, not about how fast the machine can import the graph; the
 * deadline below only bounds a child that never exits.
 */
const IMPORT_SPY_DEADLINE_MS = 60_000;

type ImportSpyRun = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

async function runImportSpy(): Promise<ImportSpyRun> {
  const child = Bun.spawn([process.execPath, join("test", "senpi", "no-ui-request-spy.ts")], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), IMPORT_SPY_DEADLINE_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(deadline);
  }
}

const importSpy = await runImportSpy().then(
  (run): { readonly run: ImportSpyRun } => ({ run }),
  (error: unknown): { readonly error: unknown } => ({ error }),
);

// Compile-time: the facade must expose all four queue/idle methods; a missing one fails this Pick.
const facadeSurface: Pick<
  SenpiTransport,
  "getPendingInputs" | "getCommands" | "setSessionName" | "waitForIdle"
> = SenpiTransport.prototype;
void facadeSurface;

describe("error mapping", () => {
  test("a missing private socket maps to socket_missing, and no ENOENT escapes the process", async () => {
    const escaped: unknown[] = [];
    const record = (error: unknown): void => {
      escaped.push(error);
    };
    process.on("unhandledRejection", record);
    process.on("uncaughtException", record);
    try {
      const transport = new SenpiTransport({ socketPath: join(repoRoot, ".nonexistent-senpi.sock"), keyRoot: repoRoot });
      const error = await transport.connect().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SenpiTransportError);
      expect((error as SenpiTransportError).code).toBe("socket_missing");
      await transport.dispose();
      // One tick drains a late socket error; there is nothing to wait for when none was emitted.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", record);
      process.off("uncaughtException", record);
    }
    expect(escaped).toEqual([]);
  });

  test("a host authentication refusal maps to auth_failed", async () => {
    const host = FakeSenpiHost.start({ rejectAuth: true });
    try {
      const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
      const error = await transport.connect().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SenpiTransportError);
      expect((error as SenpiTransportError).code).toBe("auth_failed");
      await transport.dispose();
    } finally {
      host.stop();
    }
  });

  test("a host refusal for a session it does not hold maps to session_not_found", () => {
    // RpcCommandError carries the wire `error` as the message and `errorCode` when errorData is present.
    expect(mapSenpiError(Object.assign(new Error("unknown_session"), { errorCode: "unknown_session" })).code).toBe(
      "session_not_found",
    );
    // RpcSessionRegistryError carries the code on `code`; older wire payloads carry only the error string.
    expect(mapSenpiError(Object.assign(new Error("unknown_session"), { code: "unknown_session" })).code).toBe(
      "session_not_found",
    );
    expect(mapSenpiError(new Error("unknown_session")).code).toBe("session_not_found");
    expect(mapSenpiError(new Error("unknown_session: ses_1")).code).toBe("command_failed");
  });

  test("a lost transport maps to transport_gone", async () => {
    expect(mapSenpiError(new RpcTransportGoneError()).code).toBe("transport_gone");

    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      const gone = new Promise<SenpiTransportError>((resolve) => transport.onDisconnect(resolve));
      host.stop();
      const error = await gone;
      expect(error.code).toBe("transport_gone");
    } finally {
      await transport.dispose();
    }
  });
});

describe("client declaration", () => {
  test("the first set_client_info frame declares interactive_user and question", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      expect(host.connections).toHaveLength(2);
      for (const connection of host.connections) {
        expect(connection.frames[0]?.type).toBe("get_protocol_info");
        expect(connection.frames[1]?.type).toBe("set_client_info");
        const declared = connection.frames[1]?.capabilities as string[];
        expect(declared).toContain("interactive_user");
        expect(declared).toContain("question");
      }

      await transport.openSession({ cwd: host.dir });
      const openFrame = host.framesOfType("open_session")[0]?.frame;
      expect(openFrame?.retain_on_disconnect).toBe(true);
      expect(openFrame?.cwd).toBe(host.dir);
    } finally {
      await transport.dispose();
      host.stop();
    }
  });

  test("abort with intent stop without interactive_user maps to stop_requires_interactive_client", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir, capabilities: [] });
    try {
      await transport.connect();
      const error = await transport.abort({ intent: "stop" }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SenpiTransportError);
      expect((error as SenpiTransportError).code).toBe("stop_requires_interactive_client");
      expect(host.framesOfType("abort")[0]?.frame.intent).toBe("stop");
    } finally {
      await transport.dispose();
      host.stop();
    }
  });
});

describe("run boundary", () => {
  test("streaming follows the attached session's agent_start and agent_end", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      const opened = await transport.openSession({ cwd: host.dir });
      expect(transport.streaming).toBe(false);

      const started = new Promise<void>((resolve) => {
        const off = transport.onEvent((event) => {
          if (event.type !== "agent_start") return;
          off();
          resolve();
        });
      });
      host.emit({ type: "agent_start", sessionId: opened.sessionId });
      await started;
      expect(transport.streaming).toBe(true);

      const ended = new Promise<void>((resolve) => {
        const off = transport.onEvent((event) => {
          if (event.type !== "agent_end") return;
          off();
          resolve();
        });
      });
      host.emit({ type: "agent_end", sessionId: opened.sessionId });
      await ended;
      expect(transport.streaming).toBe(false);

      await transport.prompt("start another turn");
      expect(transport.streaming).toBe(true);
    } finally {
      await transport.dispose();
      host.stop();
    }
  });
});

describe("queue and idle facade", () => {
  test("exposes the four methods at runtime", () => {
    const transport = new SenpiTransport({ socketPath: join(repoRoot, "x.sock"), keyRoot: repoRoot });
    expect(typeof transport.getPendingInputs).toBe("function");
    expect(typeof transport.getCommands).toBe("function");
    expect(typeof transport.setSessionName).toBe("function");
    expect(typeof transport.waitForIdle).toBe("function");
  });

  test("answers the host's pending-input ledger and command surface", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      await transport.openSession({ cwd: host.dir });

      const pending = await transport.getPendingInputs();
      expect(pending?.inputs.map((input) => input.clientMessageId)).toEqual(["msg_queued_1", "msg_queued_2"]);

      const commands = await transport.getCommands();
      expect(commands.map((command) => command.name)).toEqual(["fix-tests"]);

      await transport.setSessionName("Renamed by the facade");
      expect(host.framesOfType("set_session_name")[0]?.frame.name).toBe("Renamed by the facade");
    } finally {
      await transport.dispose();
      host.stop();
    }
  });

  test("the inbox handler lists two enqueued inputs through the real transport", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    setSessionInboxTransport(transport);
    try {
      await transport.connect();
      await transport.openSession({ cwd: host.dir });

      const response = await handleSessionInboxList(
        new Request("http://bridge.test/api/session/durable-1/inbox"),
        new URL("http://bridge.test/api/session/durable-1/inbox"),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: Array<Record<string, unknown>> };
      expect(body.data.map((item) => [item.id, item.sessionID, item.text, item.delivery])).toEqual([
        ["msg_queued_1", "durable-1", "run the full test suite", "queue"],
        ["msg_queued_2", "durable-1", "also check the diff", "steer"],
      ]);
    } finally {
      setSessionInboxTransport(undefined);
      await transport.dispose();
      host.stop();
    }
  });

  test("waitForIdle resolves within 100ms of the turn ending", async () => {
    const host = FakeSenpiHost.start();
    const transport = new SenpiTransport({ socketPath: host.socketPath, keyRoot: host.dir });
    try {
      await transport.connect();
      const idle = transport.waitForIdle(2_000);
      const started = Date.now();
      host.finishTurn();
      await idle;
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      await transport.dispose();
      host.stop();
    }
  });

  test("the new calls refuse a transport that never connected", async () => {
    const transport = new SenpiTransport({ socketPath: join(repoRoot, "x.sock"), keyRoot: repoRoot });
    for (const call of [
      () => transport.getPendingInputs(),
      () => transport.getCommands(),
      () => transport.setSessionName("x"),
      () => transport.waitForIdle(1),
    ]) {
      const error = await call().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SenpiTransportError);
      expect((error as SenpiTransportError).code).toBe("not_connected");
    }
  });
});

describe("module surface", () => {
  test("AttachClient is reachable from the resolved package root", async () => {
    const AttachClient = await loadAttachClient();
    expect(typeof AttachClient).toBe("function");
  });

  test("importing the transport emits no extension_ui_request on stdout", () => {
    if ("error" in importSpy) throw importSpy.error;
    const { exitCode, stdout, stderr } = importSpy.run;
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const parsed = JSON.parse(stdout.trim()) as { offending: string[]; hasTransport: boolean };
    expect(parsed.offending).toEqual([]);
    expect(parsed.hasTransport).toBe(true);
  });
});
