import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventBus, type BridgeEvent } from "../../src/http/events";
import { BASIC_USERNAME } from "../../src/http/server";
import { createRuntime, type BridgeRuntime } from "../../src/runtime";
import { FakeSenpiHost } from "../senpi/fake-host";

// The streaming client holds exactly one routing id, and the pinned RpcClient drops every frame
// tagged with another one. A read of a session the transport is not attached to therefore has to
// happen without moving that attachment, or the running turn goes silent mid-stream.

const PASSWORD = "sibling-password";
const SESSION_ID = "durable-a";
const SIBLING_ID = "durable-b";
const ALPHA_ANSWER = "ALPHA TRANSCRIPT";
const BETA_ANSWER = "BETA ANSWER";
const COLLECT_TIMEOUT_MS = 2_000;

let root: string;
let alphaPath: string;
let betaPath: string;
let host: FakeSenpiHost;
let runtime: BridgeRuntime;
let base: string;

function userEntry(id: string, timestamp: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
  };
}

function assistantEntry(id: string, timestamp: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
    },
  };
}

function noticeEntry(id: string): Record<string, unknown> {
  return {
    type: "model_change",
    id,
    parentId: null,
    timestamp: "2026-11-05T00:00:02.000Z",
    provider: "anthropic",
    modelId: "claude-sonnet-4",
  };
}

function runtimeEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    OMO_BRIDGE_PORT: "0",
    OMO_BRIDGE_PASSWORD: PASSWORD,
    OMO_BRIDGE_STATE_DIR: join(root, "state"),
    OMO_BRIDGE_SENPI_SOCKET: host.socketPath,
    OMO_BRIDGE_KEY_ROOT: host.dir,
  };
}

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

async function messagesOf(sessionID: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${base}/api/session/${sessionID}/message?limit=20&order=desc`, { headers: auth() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

function assistantText(items: Array<Record<string, unknown>>): string | undefined {
  const assistant = items.find((message) => message.type === "assistant");
  const content = (assistant?.content ?? []) as Array<Record<string, unknown>>;
  return content.find((part) => part.type === "text")?.text as string | undefined;
}

function userText(items: Array<Record<string, unknown>>): string | undefined {
  return items.find((message) => message.type === "user")?.text as string | undefined;
}

/**
 * Collect `count` events of the listed types, bounded: a stream the read has silenced ends with a
 * partial (or empty) list instead of hanging the test, so the failure names the missing frames.
 */
async function collectEvents(types: string[], count: number): Promise<BridgeEvent[]> {
  const subscription = eventBus.subscribe({ types });
  const reader = subscription.stream.getReader();
  const seen: BridgeEvent[] = [];
  const timer = setTimeout(() => {
    void reader.cancel();
  }, COLLECT_TIMEOUT_MS);
  try {
    while (seen.length < count) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      seen.push(value);
    }
  } finally {
    clearTimeout(timer);
    subscription.close();
  }
  return seen;
}

function deltaOf(event: BridgeEvent): unknown {
  return (event.data as Record<string, unknown>).delta;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-sibling-"));
  alphaPath = join(root, "alpha.jsonl");
  betaPath = join(root, "beta.jsonl");
  host = FakeSenpiHost.start({
    sessions: [
      { sessionId: "rpc-a", durableSessionId: SESSION_ID, sessionPath: alphaPath, cwd: root, status: "open", attachments: 1 },
      { sessionId: "rpc-b", durableSessionId: SIBLING_ID, sessionPath: betaPath, cwd: root, status: "open", attachments: 1 },
    ],
    transcripts: {
      [alphaPath]: [
        userEntry("alpha-user", "2026-11-05T00:00:00.000Z", "alpha question"),
        assistantEntry("alpha-assistant", "2026-11-05T00:00:01.000Z", ALPHA_ANSWER),
      ],
      [betaPath]: [
        userEntry("beta-user", "2026-11-05T00:00:00.000Z", "beta question"),
        assistantEntry("beta-assistant", "2026-11-05T00:00:01.000Z", BETA_ANSWER),
      ],
      [join(root, "state", "model-catalog.jsonl")]: [noticeEntry("notice-catalog")],
    },
  });
  runtime = await createRuntime(runtimeEnv());
  base = `http://127.0.0.1:${runtime.server.port}`;
});

afterEach(async () => {
  await runtime.close();
  host.stop();
  rmSync(root, { recursive: true, force: true });
});

describe("a read of a sibling session during a running turn", () => {
  test("leaves the running session's deltas and execution event intact", async () => {
    const prompt = await fetch(`${base}/api/session/${SESSION_ID}/prompt`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ delivery: "queue", parts: [{ type: "text", text: "run the turn" }] }),
    });
    expect(prompt.status).toBe(200);

    const deltas = collectEvents(["session.text.delta"], 2);
    const execution = collectEvents(["session.execution.started", "session.execution.succeeded"], 2);

    host.emit({
      type: "agent_start",
      sessionId: "rpc-a",
    });
    host.emit({
      type: "message_start",
      sessionId: "rpc-a",
      message: { role: "assistant", id: "msg_a", provider: "anthropic", model: "claude-sonnet-4", content: [] },
    });
    const usage = { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
    host.emit({
      type: "message_update",
      sessionId: "rpc-a",
      usage,
      assistantMessageEvent: { type: "text_delta", delta: "FIRST", contentIndex: 0 },
    });

    const sibling = await messagesOf(SIBLING_ID);
    expect(assistantText(sibling)).toBe(BETA_ANSWER);
    expect(userText(sibling)).toBe("beta question");
    expect(sibling.some((message) => message.text === "alpha question")).toBe(false);

    host.emit({
      type: "message_update",
      sessionId: "rpc-a",
      usage,
      assistantMessageEvent: { type: "text_delta", delta: "SECOND", contentIndex: 0 },
    });
    host.emit({ type: "message_end", sessionId: "rpc-a", message: { role: "assistant", id: "msg_a" } });
    host.emit({ type: "agent_end", sessionId: "rpc-a", messages: [], willRetry: false });

    const streamed = await deltas;
    const terminal = await execution;
    expect({
      deltas: streamed.map(deltaOf),
      execution: terminal.map((event) => event.type),
    }).toEqual({
      deltas: ["FIRST", "SECOND"],
      execution: ["session.execution.started", "session.execution.succeeded"],
    });
    for (const event of terminal) {
      expect((event.data as Record<string, unknown>).sessionID).toBe(SESSION_ID);
    }

    // The streaming connection never left rpc-a: only the reader opened the sibling transcript.
    const streamingConnection = host.connections[0];
    expect(streamingConnection).toBeDefined();
    const openedPaths = (streamingConnection?.frames ?? [])
      .filter((frame) => frame.type === "open_session")
      .map((frame) => frame.sessionPath);
    expect(openedPaths).not.toContain(betaPath);
    expect(openedPaths).toContain(alphaPath);

    expect(assistantText(await messagesOf(SESSION_ID))).toBe(ALPHA_ANSWER);
  });
});
