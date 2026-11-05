import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SenpiTransport } from "../../src/senpi/transport";

const integrationEnabled = process.env.OMO_BRIDGE_INTEGRATION === "1";

const HOST_INTERNAL_ENV = [
  "BUN_BE_BUN",
  "SENPI_RPC_INTERNAL_KEY_STDIN",
  "SENPI_RPC_HOST_PUBLIC_SOCKET",
  "SENPI_RPC_HOST_INSTANCE_ID",
  "SENPI_RPC_HOST_GENERATION",
  "SENPI_RPC_HOST_WATCH_FD",
  "SENPI_RPC_HOST_WATCH_PPID",
  "SENPI_RPC_HOST_SCRATCH_DIR",
  "SENPI_RPC_HOST_CLEANUP_PATHS",
  "SENPI_RPC_CLIENT_CAPABILITIES",
  "OMO_RPC_CLIENT_CAPABILITIES",
];

function privateHostEnv(agentDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (HOST_INTERNAL_ENV.includes(key)) continue;
    env[key] = value;
  }
  env.OMO_CODING_AGENT_DIR = agentDir;
  return env;
}

function waitForLine(stream: ReadableStream<Uint8Array>, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const timer = setTimeout(() => {
      void reader.cancel();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${pattern}`));
    }, timeoutMs);
    const settle = (line: string) => {
      clearTimeout(timer);
      void reader.cancel();
      resolve(line);
    };
    const pump = async (): Promise<void> => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (pattern.test(line)) {
            settle(line);
            return;
          }
        }
      }
    };
    void pump().catch((error: unknown) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

describe("private host integration", () => {
  test.skipIf(!integrationEnabled)("connect, open session, list, state, dispose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omo-bridge-it-"));
    const agentDir = join(dir, "agent");
    const socketPath = join(dir, "senpi.sock");
    const omoBin = process.env.OMO_BIN ?? "omo";
    const host = Bun.spawn(
      [omoBin, "--mode", "rpc", "--listen", `unix://${socketPath}`, "--multi-session"],
      { cwd: dir, env: privateHostEnv(agentDir), stdout: "pipe", stderr: "pipe" },
    );
    const transport = new SenpiTransport({ socketPath, keyRoot: agentDir });
    void new Response(host.stdout)
      .text()
      .catch(() => undefined);

    try {
      await waitForLine(host.stderr, /senpi rpc listening on/, 20000);
      expect(existsSync(socketPath)).toBe(true);

      await transport.connect();
      const opened = await transport.openSession({ cwd: dir, retainOnDisconnect: true });
      expect(opened.sessionId.length).toBeGreaterThan(0);
      expect(transport.sessionId).toBe(opened.sessionId);

      const sessions = await transport.listSessions();
      const listed = sessions.find((session) => session.sessionId === opened.sessionId);
      expect(listed).toBeDefined();
      expect(listed?.cwd).toBe(dir);

      const state = await transport.getState();
      expect(typeof state).toBe("object");

      await transport.dispose();
    } finally {
      await transport.dispose().catch(() => undefined);
      host.kill();
      await host.exited;
      if (existsSync(socketPath)) rmSync(socketPath, { force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
