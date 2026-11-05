import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SENPI_DIR = process.env.OMO_BRIDGE_CONTRACTS_SENPI_DIR ?? join(REPO_ROOT, "contracts", "senpi");
const BIN = process.env.OMO_BRIDGE_OMO_BIN ?? "/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo";
const CALL_TIMEOUT_MS = 60_000;

type Frame = Record<string, unknown>;
type Call = { endpoint: string; request: Frame; response: Frame };

function hostEnv(agentDir: string): Record<string, string> {
  const keys = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "SHELL"];
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  env.LANG ??= "en_US.UTF-8";
  env.OMO_CODING_AGENT_DIR = agentDir;
  return env;
}

function scrub(value: Frame, root: string): Frame {
  const variants = [`/private${root}`, root];
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return variants.reduce((text, variant) => text.split(variant).join("<tmp>"), node);
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Frame = {};
      for (const [key, inner] of Object.entries(node)) out[key] = walk(inner);
      return out;
    }
    return node;
  };
  return walk(value) as Frame;
}

type Host = {
  pid: number;
  call: (endpoint: string, request: Frame) => Promise<Frame>;
  stop: () => Promise<number>;
};

function startHost(cwd: string, agentDir: string): Host {
  const proc = Bun.spawn([BIN, "--mode", "rpc", "--multi-session"], {
    cwd,
    env: hostEnv(agentDir),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const records: Frame[] = [];
  const waiters: Array<{ match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  const stderrChunks: string[] = [];

  void (async () => {
    const reader = proc.stdout.getReader();
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line.trim()) continue;
        let frame: Frame;
        try {
          frame = JSON.parse(line) as Frame;
        } catch {
          continue;
        }
        records.push(frame);
        for (const waiter of [...waiters]) {
          if (!waiter.match(frame)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(frame);
        }
      }
    }
  })();

  void (async () => {
    const reader = proc.stderr.getReader();
    const errDecoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      stderrChunks.push(errDecoder.decode(value, { stream: true }));
    }
  })();

  let nextId = 0;
  async function call(endpoint: string, request: Frame): Promise<Frame> {
    if (request.id === undefined) {
      nextId += 1;
      request.id = `req-${nextId}`;
    }
    const response = new Promise<Frame>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const tail = stderrChunks.join("").trim().slice(-800);
        rejectPromise(new Error(`${endpoint}: no response within ${CALL_TIMEOUT_MS}ms (stderr: ${tail || "empty"})`));
      }, CALL_TIMEOUT_MS);
      waiters.push({
        match: (frame) => frame.type === "response" && frame.id === request.id,
        resolve: (frame) => {
          clearTimeout(timer);
          resolvePromise(frame);
        },
      });
    });
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    proc.stdin.flush();
    const frame = await response;
    if (frame.success !== true) {
      throw new Error(`${endpoint}: host refused the command: ${JSON.stringify(frame).slice(0, 500)}`);
    }
    return frame;
  }

  async function stop(): Promise<number> {
    finished = true;
    try {
      proc.stdin.end();
    } catch {}
    const exited = proc.exited;
    proc.kill();
    const winner = await Promise.race([exited, Bun.sleep(5000).then(() => "timeout" as const)]);
    if (winner === "timeout") proc.kill(9);
    return await proc.exited;
  }

  return { pid: proc.pid, call, stop };
}

export async function record(): Promise<{ frames: number; calls: Call[]; serverVersion: string; pid: number; exitCode: number }> {
  const root = mkdtempSync(join(tmpdir(), "omo-bridge-record-"));
  const cwd = join(root, "cwd");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });

  const host = startHost(cwd, agentDir);
  const calls: Call[] = [];
  let stopped = false;
  try {
    const info = await host.call("get_protocol_info", { id: "1", type: "get_protocol_info" });
    calls.push({ endpoint: "get_protocol_info", request: { id: "1", type: "get_protocol_info" }, response: info });
    const data = (info.data ?? {}) as Frame;
    const serverVersion = String(data.engineVersion ?? data.serverVersion ?? "unknown");

    await recordCall(host, calls, "list_sessions", { id: "2", type: "list_sessions" });
    const opened = await recordCall(host, calls, "open_session", { id: "3", type: "open_session", cwd });
    const sessionId = (opened.data as Frame | undefined)?.sessionId;
    if (typeof sessionId !== "string") throw new Error("open_session returned no sessionId");
    await recordCall(host, calls, "get_state", { id: "4", type: "get_state", sessionId });
    await recordCall(host, calls, "get_entries", { id: "5", type: "get_entries", sessionId });
    await recordCall(host, calls, "close_session", { id: "6", type: "close_session", sessionId });

    const lines: string[] = [];
    for (const call of calls) {
      lines.push(JSON.stringify({ frame: scrub(call.request, root), role: "request", endpoint: call.endpoint, source: "live" }));
      lines.push(
        JSON.stringify({
          frame: scrub(call.response, root),
          role: "response",
          endpoint: call.endpoint,
          source: "live",
          recordedWith: `omo host (engine ${serverVersion})`,
        }),
      );
    }
    const exitCode = await host.stop();
    stopped = true;
    mkdirSync(SENPI_DIR, { recursive: true });
    writeFileSync(join(SENPI_DIR, "live.jsonl"), `${lines.join("\n")}\n`);
    return { frames: lines.length, calls, serverVersion, pid: host.pid, exitCode };
  } finally {
    if (!stopped) await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

async function recordCall(host: Host, calls: Call[], endpoint: string, request: Frame): Promise<Frame> {
  const response = await host.call(endpoint, request);
  calls.push({ endpoint, request, response });
  return response;
}

if (import.meta.main) {
  try {
    const { frames, calls, serverVersion, pid, exitCode } = await record();
    console.log(`senpi: recorded ${frames} frames from ${calls.length} commands (engine ${serverVersion})`);
    console.log(`senpi: host pid ${pid} exited with ${exitCode}`);
  } catch (error) {
    console.error(`senpi: recording failed: ${(error as Error).message}`);
    process.exit(1);
  }
}
