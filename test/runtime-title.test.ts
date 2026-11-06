// The host's own auto-title is closed for every session the extension has seeded with context, so the
// bridge names such a session itself. This drives one real turn through the bridge and reads the title
// it publishes, with the summarization turn answered by the fake host.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type BridgeRuntime } from "../src/runtime";
import { TITLE_WORKER_FILE } from "../src/titles";
import { FakeSenpiHost } from "./senpi/fake-host";

const PASSWORD = "title-password";
const BASIC_USERNAME = "opencode";
const CLIENT_ID = "durable-1";

let host: FakeSenpiHost;
let runtime: BridgeRuntime;
let base: string;
let root: string;

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

function userEntry(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "m1",
    timestamp: 1_700_000_000_000,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantEntry(text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "m2",
    timestamp: 1_700_000_001_000,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-title-"));
  const userPath = join(root, "user.jsonl");
  writeFileSync(userPath, `${JSON.stringify(userEntry("fix the read attachment churn"))}\n`);
  const stateDir = join(root, "state");
  const workerPath = join(stateDir, TITLE_WORKER_FILE);
  host = FakeSenpiHost.start({
    autoFinishTurns: true,
    sessions: [
      { sessionId: "rpc-1", durableSessionId: CLIENT_ID, sessionPath: userPath, cwd: root, status: "open", attachments: 1 },
      { sessionId: "rpc-2", durableSessionId: "durable-worker", sessionPath: workerPath, cwd: stateDir, status: "open", attachments: 0 },
    ],
    transcripts: {
      [workerPath]: [assistantEntry("Read attachment churn")],
    },
  });
  runtime = await createRuntime({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OMO_BRIDGE_PORT: "0",
    OMO_BRIDGE_PASSWORD: PASSWORD,
    OMO_BRIDGE_STATE_DIR: stateDir,
    OMO_BRIDGE_SENPI_SOCKET: host.socketPath,
    OMO_BRIDGE_KEY_ROOT: host.dir,
  });
  base = `http://127.0.0.1:${runtime.server.port}`;
});

afterAll(async () => {
  await runtime.close();
  host.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a settled turn names an unnamed session through a summarization turn", async () => {
  const controller = new AbortController();
  const events = await fetch(`${base}/api/event`, { headers: auth(), signal: controller.signal });
  const reader = events.body?.getReader();
  expect(reader).toBeDefined();
  const decoder = new TextDecoder();
  const renamed = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no session.renamed within 5s")), 5_000);
    void (async () => {
      let buffer = "";
      for (;;) {
        const chunk = await reader?.read();
        if (chunk === undefined || chunk.done === true) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (const block of buffer.split("\n\n")) {
          const line = block.split("\n").find((entry) => entry.startsWith("data: "));
          if (line === undefined) continue;
          const payload = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (payload.type !== "session.renamed") continue;
          clearTimeout(timer);
          resolve(payload.data as Record<string, unknown>);
          return;
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      }
    })().catch(reject);
  });

  const response = await fetch(`${base}/api/session/${CLIENT_ID}/prompt`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "fix the read attachment churn" }] }),
  });
  expect(response.status).toBe(200);

  const event = await renamed;
  controller.abort();
  expect(event.sessionID).toBe(CLIENT_ID);
  expect(event.title).toBe("Read attachment churn");
  expect(runtime.sessionMap.get(CLIENT_ID)?.name).toBe("Read attachment churn");
});
