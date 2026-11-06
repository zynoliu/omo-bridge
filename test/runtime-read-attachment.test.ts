// The write transport holds exactly one session open, and the host's auto-title generation dies when
// that attachment moves in the window after a turn settles. Reads must therefore never move it: a
// read of another session goes through a second connection, and a read of the session the write side
// already holds reuses that attachment instead of attaching again (which would steal it mid-run).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type BridgeRuntime } from "../src/runtime";
import { FakeSenpiHost } from "./senpi/fake-host";

const PASSWORD = "read-attachment-password";
const BASIC_USERNAME = "opencode";

let host: FakeSenpiHost;
let runtime: BridgeRuntime;
let base: string;
let root: string;
let sessions: readonly Record<string, unknown>[];

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-read-attachment-"));
  const transcript = (text: string): string =>
    `${JSON.stringify({ type: "message", id: "m1", timestamp: 1_700_000_000_000, message: { role: "user", content: [{ type: "text", text }] } })}\n`;
  const first = join(root, "first.jsonl");
  const second = join(root, "second.jsonl");
  writeFileSync(first, transcript("first session"));
  writeFileSync(second, transcript("second session"));
  sessions = [
    { sessionId: "rpc-1", durableSessionId: "durable-1", sessionPath: first, cwd: root, status: "open", attachments: 1 },
    { sessionId: "rpc-2", durableSessionId: "durable-2", sessionPath: second, cwd: root, status: "open", attachments: 1 },
  ];
  host = FakeSenpiHost.start({ sessions });
  runtime = await createRuntime({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OMO_BRIDGE_PORT: "0",
    OMO_BRIDGE_PASSWORD: PASSWORD,
    OMO_BRIDGE_STATE_DIR: join(root, "state"),
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

test("a read of another session leaves the write attachment on the session it holds", async () => {
  const write = runtime.transport;
  expect(write).toBeDefined();
  await write?.openSession({ sessionPath: String(sessions[0]?.sessionPath), retainOnDisconnect: true });
  expect(write?.sessionId).toBe("rpc-1");

  const response = await fetch(`${base}/api/session/rpc-2/message`, { headers: auth() });
  expect(response.status).toBe(200);

  // The read attached the second session somewhere, but not on the connection the next prompt uses.
  expect(write?.sessionId).toBe("rpc-1");
});

test("a read of the held session reuses its attachment instead of moving it", async () => {
  const write = runtime.transport;
  const opens = (): unknown[] =>
    host.connections.flatMap((connection) =>
      connection.frames.filter((frame) => frame.type === "open_session").map((frame) => frame.sessionPath),
    );
  const before = opens().length;

  const response = await fetch(`${base}/api/session/rpc-1/message`, { headers: auth() });
  expect(response.status).toBe(200);

  expect(opens().length).toBe(before);
  expect(write?.sessionId).toBe("rpc-1");
});
