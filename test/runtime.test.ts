import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASIC_USERNAME } from "../src/http/server";
import { createRuntime, type BridgeRuntime } from "../src/runtime";
import { FakeSenpiHost } from "./senpi/fake-host";

// Composition test: createRuntime is the seam that installs the http handlers' transports. The inbox
// family must be installed here; a test that calls setSessionInboxTransport itself proves nothing
// about the running bridge, which is exactly how the 503 reached the real surface.

const PASSWORD = "runtime-password";
const SESSION_ID = "durable-1";

let host: FakeSenpiHost;
let runtime: BridgeRuntime;
let base: string;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-runtime-"));
  host = FakeSenpiHost.start();
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

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

describe("runtime composition", () => {
  test("the inbox family is wired by createRuntime and serves the host's queue", async () => {
    const response = await fetch(`${base}/api/session/${SESSION_ID}/inbox`, { headers: auth() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((item) => [item.id, item.text, item.delivery])).toEqual([
      ["msg_queued_1", "run the full test suite", "queue"],
      ["msg_queued_2", "also check the diff", "steer"],
    ]);
  });

  test("interrupt is served by the same transport instead of the 503 fallback", async () => {
    const response = await fetch(`${base}/api/session/${SESSION_ID}/interrupt`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ interrupted: true });
    expect(host.framesOfType("abort").at(-1)?.frame.intent).toBe("stop");
  });
});
