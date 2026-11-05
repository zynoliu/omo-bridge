import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventBus, type BridgeEvent } from "../../src/http/events";
import { BASIC_USERNAME } from "../../src/http/server";
import { createRuntime, type BridgeRuntime } from "../../src/runtime";
import { FakeSenpiHost } from "../senpi/fake-host";

const PASSWORD = "restart-password";
const SESSION_ID = "durable-restart";
const ANSWER = "MSGCHECK";

let root: string;
let sessionPath: string;
let transcript: Record<string, unknown>[];
let host: FakeSenpiHost;
let runtime: BridgeRuntime;
let base: string;

function userEntry(): Record<string, unknown> {
  const timestamp = "2026-11-05T00:00:00.000Z";
  return {
    type: "message",
    id: "entry-user",
    parentId: null,
    timestamp,
    message: { role: "user", content: "say MSGCHECK", timestamp: Date.parse(timestamp) },
  };
}

function assistantEntry(): Record<string, unknown> {
  const timestamp = "2026-11-05T00:00:01.000Z";
  return {
    type: "message",
    id: "entry-assistant",
    parentId: "entry-user",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: ANSWER }],
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
  return { type: "model_change", id, parentId: null, timestamp: "2026-11-05T00:00:02.000Z", provider: "anthropic", modelId: "claude-sonnet-4" };
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

async function messages(): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${base}/api/session/${SESSION_ID}/message?limit=20&order=desc`, { headers: auth() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<Record<string, unknown>> };
  return body.data;
}

function assistantText(items: Array<Record<string, unknown>>): string | undefined {
  const assistant = items.find((message) => message.type === "assistant");
  const content = (assistant?.content ?? []) as Array<Record<string, unknown>>;
  return content.find((part) => part.type === "text")?.text as string | undefined;
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-restart-"));
  sessionPath = join(root, "alpha.jsonl");
  transcript = [userEntry(), assistantEntry()];
  host = FakeSenpiHost.start({
    sessions: [
      { sessionId: "rpc-alpha", durableSessionId: SESSION_ID, sessionPath, cwd: root, status: "open", attachments: 1 },
    ],
    transcripts: {
      [sessionPath]: transcript,
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

describe("session messages across a restart", () => {
  test("a completed turn answers with the assistant text block, not the attached catalog notices", async () => {
    const data = await messages();
    expect(assistantText(data)).toBe(ANSWER);
    expect(data.some((message) => message.type === "user")).toBe(true);
    expect(data.filter((message) => message.type === "assistant")).toHaveLength(1);
  });

  test("closing and reopening the runtime over the same state still answers with the conversation", async () => {
    expect(assistantText(await messages())).toBe(ANSWER);

    await runtime.close();
    runtime = await createRuntime(runtimeEnv());
    base = `http://127.0.0.1:${runtime.server.port}`;

    const again = await messages();
    expect(assistantText(again)).toBe(ANSWER);
    expect(again.filter((message) => message.type === "assistant")).toHaveLength(1);
    expect(new Set(again.map((message) => message.id)).size).toBe(again.length);
  });

  test("a message read during a running turn leaves the attachment and the stream alone", async () => {
    transcript.length = 0;
    const prompt = await fetch(`${base}/api/session/${SESSION_ID}/prompt`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ delivery: "queue", parts: [{ type: "text", text: "say MSGCHECK" }] }),
    });
    expect(prompt.status).toBe(200);
    const opensAfterPrompt = host.framesOfType("open_session").length;

    const subscription = eventBus.subscribe({ types: ["session.text.delta"] });
    const reader = subscription.stream.getReader();
    const deltas = (async () => {
      const seen: BridgeEvent[] = [];
      while (seen.length < 2) {
        const { done, value } = await reader.read();
        if (done || value === undefined) break;
        seen.push(value);
      }
      return seen;
    })();

    host.emit({
      type: "message_start",
      message: { role: "assistant", id: "msg_run", provider: "anthropic", model: "claude-sonnet-4", content: [] },
    });
    const usage = { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
    for (const delta of ["MSG", "CHECK"]) {
      host.emit({
        type: "message_update",
        usage,
        assistantMessageEvent: { type: "text_delta", delta, contentIndex: 0 },
      });
    }

    const midRun = await messages();
    expect(host.framesOfType("open_session").length).toBe(opensAfterPrompt);
    expect(midRun.some((message) => message.type === "assistant")).toBe(false);

    const events = await deltas;
    expect(events.map((event) => (event.data as Record<string, unknown>).delta)).toEqual(["MSG", "CHECK"]);
    subscription.close();

    host.emit({ type: "message_end", message: { role: "assistant", id: "msg_run" } });
    host.emit({ type: "agent_end", messages: [], willRetry: false });
    transcript.push(assistantEntry());

    const after = await messages();
    expect(host.framesOfType("open_session").length).toBe(opensAfterPrompt);
    expect(assistantText(after)).toBe(ANSWER);
  });
});
