import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASIC_USERNAME } from "../src/http/server";
import { createEventBus } from "../src/http/events";
import { forgetInboxAdmission, rememberInboxAdmission } from "../src/http/handlers/inbox";
import { SessionMap } from "../src/model/session-map";
import { rememberSessionAlias, resetSessionAliases } from "../src/model/session-map";
import { createFrameDispatch, createRuntime, resolveFrameSessionID, type BridgeRuntime } from "../src/runtime";
import type { SenpiSessionSummary } from "../src/senpi/transport";
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

type StreamedEvent = { type: string; data: Record<string, unknown> };

/** Reads the bridge's real SSE surface, so a handler that publishes to the wrong bus fails here. */
async function openEventStream(): Promise<{
  next: (type: string) => Promise<StreamedEvent>;
  close: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/event`, { headers: auth(), signal: controller.signal });
  if (response.body === null) throw new Error("the event route answered no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const next = async (type: string): Promise<StreamedEvent> => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
        if (line === undefined) continue;
        const event = JSON.parse(line.slice("data: ".length)) as StreamedEvent;
        if (event.type === type) return event;
        continue;
      }
      const read = await Promise.race([reader.read(), Bun.sleep(5_000).then(() => "timeout" as const)]);
      if (read === "timeout") break;
      if (read.done === true) throw new Error(`the event stream closed before ${type}`);
      buffer += decoder.decode(read.value, { stream: true });
    }
    throw new Error(`no ${type} event arrived within 5000ms`);
  };

  return {
    next,
    close() {
      controller.abort();
      void reader.cancel().catch(() => undefined);
    },
  };
}

describe("frame session resolution", () => {
  const CLIENT_ID = "ses_tui_client_filed";
  const DURABLE_ID = "01a1afdb-9d55-793e-8e91-60face8a7d4c";

  function mapWithSession(dir: string): SessionMap {
    const map = SessionMap.open({ stateDir: dir, agentDir: dir, warn: () => {} });
    map.upsert({
      sessionId: "rpc-2",
      durableSessionId: DURABLE_ID,
      sessionPath: join(dir, `2026-11-06T07-56-07-893Z_${DURABLE_ID}.jsonl`),
      cwd: dir,
      status: "open",
    } as unknown as SenpiSessionSummary);
    map.upsert({
      sessionId: "rpc-2",
      durableSessionId: CLIENT_ID,
      sessionPath: join(dir, `2026-11-06T07-56-07-893Z_${DURABLE_ID}.jsonl`),
      cwd: dir,
      status: "open",
    } as unknown as SenpiSessionSummary);
    return map;
  }

  test("a frame stamped with the host's durable id answers the client's session id", () => {
    const dir = mkdtempSync(join(tmpdir(), "frame-resolution-"));
    try {
      const map = mapWithSession(dir);
      expect(resolveFrameSessionID(map, DURABLE_ID)).toBe(CLIENT_ID);
      expect(resolveFrameSessionID(map, CLIENT_ID)).toBe(CLIENT_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session filed only under its transcript id resolves to itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "frame-resolution-"));
    try {
      const map = SessionMap.open({ stateDir: dir, agentDir: dir, warn: () => {} });
      map.upsert({
        sessionId: "rpc-3",
        durableSessionId: DURABLE_ID,
        sessionPath: join(dir, `2026-11-06T07-56-07-893Z_${DURABLE_ID}.jsonl`),
        cwd: dir,
        status: "open",
      } as unknown as SenpiSessionSummary);
      expect(resolveFrameSessionID(map, DURABLE_ID)).toBe(DURABLE_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The map is paged and a prompt can be admitted before the host row carries a transcript path, so
  // the admission's own pairing has to answer frames on its own.
  test("an admission alias answers a frame even when the map only knows the host id", () => {
    const dir = mkdtempSync(join(tmpdir(), "frame-alias-"));
    try {
      const map = SessionMap.open({ stateDir: dir, agentDir: dir, warn: () => {} });
      map.upsert({
        sessionId: "rpc-9",
        durableSessionId: DURABLE_ID,
        cwd: dir,
        status: "open",
      } as unknown as SenpiSessionSummary);
      rememberSessionAlias(DURABLE_ID, CLIENT_ID);
      rememberSessionAlias("rpc-9", CLIENT_ID);

      expect(resolveFrameSessionID(map, DURABLE_ID)).toBe(CLIENT_ID);
      expect(resolveFrameSessionID(map, "rpc-9")).toBe(CLIENT_ID);
    } finally {
      resetSessionAliases();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

  test("a prompt is announced under the client's id and its delivery clears that same id", async () => {
    const stream = await openEventStream();
    try {
      await stream.next("server.connected");
      const prompt = await fetch(`${base}/api/session/${SESSION_ID}/prompt`, {
        method: "POST",
        headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({ id: "msg_runtime_1", text: "你好" }),
      });
      expect(prompt.status).toBe(200);

      const enqueued = await stream.next("session.inbox.enqueued");
      expect(enqueued.data).toEqual({
        sessionID: SESSION_ID,
        inboxID: "msg_runtime_1",
        item: { type: "user", payload: { text: "你好" }, delivery: "queue" },
      });

      // The host reports the delivered input on its own frame stream; the bridge must forward it as
      // the event the TUI leaves its optimistic pending row on.
      host.emit({
        type: "message_start",
        message: {
          role: "user",
          clientMessageId: "msg_runtime_1",
          content: [{ type: "text", text: "你好" }],
          timestamp: Date.now(),
        },
      });
      const delivered = await stream.next("session.inbox.delivered");
      expect(delivered.data).toEqual({ sessionID: SESSION_ID, inboxID: "msg_runtime_1" });
    } finally {
      stream.close();
    }
  });

  // The TUI addresses the session it minted (`ses_tui_*`); the host names the transcript by its own
  // durable id. The fake host scopes its event stream to the attached routing id, so the divergence
  // is driven through the dispatch seam the real host's frames enter.
  test("a delivery is published under the session the client prompted with", async () => {
    const bus = createEventBus();
    const dispatch = createFrameDispatch({
      bus,
      resolveSessionID: (id) => id,
      defaultSessionID: () => "durable-host-session",
    });
    rememberInboxAdmission("msg_dispatch_1", "ses_tui_client");
    const subscription = bus.subscribe({});
    const reader = subscription.stream.getReader();
    try {
      dispatch.handle({
        type: "message_start",
        sessionId: "durable-host-session",
        message: { role: "user", clientMessageId: "msg_dispatch_1", content: [] },
      });

      const read = await reader.read();
      expect(read.value?.type).toBe("session.inbox.delivered");
      expect(read.value?.data).toEqual({ sessionID: "ses_tui_client", inboxID: "msg_dispatch_1" });
    } finally {
      forgetInboxAdmission("msg_dispatch_1");
      void reader.cancel();
      subscription.close();
    }
  });
});
