import { afterEach, describe, expect, jest, test } from "bun:test";

import type { OpenCodeEvent } from "@opencode/client";

import { createClientConnection, defaultIdleTimeout } from "../../client/src/solid/connection.ts";
import { HostEventProjector } from "../src/host-projection.ts";
import { BridgeIdScheme } from "../src/id-scheme.ts";

const location = { directory: "/work" };
const SESSION = "ses_durable";
const ROUTING = "rpc-1";
const NOW = 1_000;
const scheme = new BridgeIdScheme();

/** The id the projector mints for a message the host named, so an assertion reads as an identity. */
const named = (hostID: string) => scheme.hostMessageID(SESSION, hostID, NOW);
/** The id the projector mints for a session-tree entry the host appended. */
const entry = (entryID: string) => scheme.messageID({ sessionID: SESSION, entryID: entryID }, NOW);

function projector(): HostEventProjector {
  return new HostEventProjector({ location: location, now: () => NOW, ids: scheme });
}

function types(events: readonly OpenCodeEvent[]): string[] {
  return events.map((event) => event.type);
}

function only<Type extends OpenCodeEvent["type"]>(events: readonly OpenCodeEvent[], type: Type): Extract<OpenCodeEvent, { type: Type }> {
  const found = events.find((event): event is Extract<OpenCodeEvent, { type: Type }> => event.type === type);
  if (found === undefined) throw new Error("no " + type + " event in " + JSON.stringify(types(events)));
  return found;
}

function announced(): HostEventProjector {
  const subject = projector();
  subject.project({
    type: "session_status",
    subscriptionId: "sub-1",
    seq: 0,
    sessionId: ROUTING,
    durableSessionId: SESSION,
    status: "running",
  });
  return subject;
}

async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 40; tick += 1) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("event cluster: turn steps", () => {
  test("turn_start opens a step with the message identity and declared bridge agent/model", () => {
    const subject = announced();
    const events = subject.project({ type: "turn_start", sessionId: ROUTING, messageId: "msg-t1", startedAtMs: 900 });
    expect(types(events)).toEqual(["session.step.started"]);
    expect(only(events, "session.step.started").data).toEqual({
      sessionID: SESSION,
      assistantMessageID: named("msg-t1"),
      agent: "bridge",
      model: { id: "bridge", providerID: "bridge" },
      started: 900,
    });
  });

  test("turn_start takes the frame's agent and model when the host sends them", () => {
    const subject = announced();
    const events = subject.project({
      type: "turn_start",
      sessionId: ROUTING,
      agent: "build",
      model: { id: "gpt-5", providerID: "openai" },
    });
    expect(only(events, "session.step.started").data).toMatchObject({
      agent: "build",
      model: { id: "gpt-5", providerID: "openai" },
    });
  });

  test("turn_end closes the open text block and reports the finish, cost and tokens", () => {
    const subject = announced();
    subject.project({ type: "turn_start", sessionId: ROUTING, messageId: "msg-t1" });
    subject.project({
      type: "message_update",
      sessionId: ROUTING,
      assistantMessageEvent: { type: "text_delta", delta: "done" },
    });
    const events = subject.project({
      type: "turn_end",
      sessionId: ROUTING,
      stopReason: "tool_use",
      cost: 0.25,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 3 } },
    });
    expect(types(events)).toEqual(["session.text.ended", "session.step.ended", "session.execution.succeeded"]);
    expect(only(events, "session.text.ended").data).toMatchObject({ assistantMessageID: named("msg-t1"), text: "done" });
    expect(only(events, "session.step.ended").data).toEqual({
      sessionID: SESSION,
      assistantMessageID: named("msg-t1"),
      finish: "tool-calls",
      rawFinish: "tool_use",
      cost: 0.25,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 3 } },
    });
  });

  test("a turn_end whose assistant message stopped normally closes the execution as succeeded", () => {
    const subject = announced();
    const events = subject.project({
      type: "turn_end",
      sessionId: ROUTING,
      message: { id: "msg-t2", role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
      toolResults: [],
    });
    expect(types(events)).toEqual(["session.step.ended", "session.execution.succeeded"]);
    expect(only(events, "session.execution.succeeded").data).toEqual({ sessionID: SESSION });
    expect(only(events, "session.step.ended").data).toMatchObject({ assistantMessageID: named("msg-t2"), finish: "stop" });
  });

  test("a turn_end whose assistant message was aborted closes the execution as interrupted", () => {
    const subject = announced();
    const events = subject.project({
      type: "turn_end",
      sessionId: ROUTING,
      message: { id: "msg-t3", role: "assistant", stopReason: "aborted", content: [] },
      toolResults: [],
    });
    expect(types(events)).toEqual(["session.step.ended", "session.execution.interrupted"]);
    expect(only(events, "session.execution.interrupted").data).toEqual({ sessionID: SESSION, reason: "user" });
    expect(types(events)).not.toContain("session.execution.succeeded");
  });
});

describe("event cluster: compaction", () => {
  test("compaction_start and compaction_end project started, one delta and the ended summary", () => {
    const subject = announced();
    expect(types(subject.project({ type: "compaction_start", sessionId: ROUTING, reason: "threshold" }))).toEqual([
      "session.compaction.started",
    ]);
    const ended = subject.project({
      type: "compaction_end",
      sessionId: ROUTING,
      reason: "threshold",
      result: { summary: "Condensed twelve messages" },
      aborted: false,
      willRetry: false,
    });
    expect(types(ended)).toEqual(["session.compaction.delta", "session.compaction.ended"]);
    expect(only(ended, "session.compaction.delta").data).toEqual({ sessionID: SESSION, text: "Condensed twelve messages" });
    expect(only(ended, "session.compaction.ended").data).toMatchObject({
      sessionID: SESSION,
      reason: "auto",
      text: "Condensed twelve messages",
    });
  });

  test("an aborted compaction ends as failed rather than claiming a summary", () => {
    const subject = announced();
    const events = subject.project({
      type: "compaction_end",
      sessionId: ROUTING,
      reason: "manual",
      result: null,
      aborted: true,
    });
    expect(types(events)).toEqual(["session.compaction.failed"]);
    expect(only(events, "session.compaction.failed").data).toMatchObject({
      reason: "manual",
      error: { type: "compaction_aborted" },
    });
  });
});

describe("event cluster: message updates", () => {
  test("assistantMessageEvent deltas drive the reasoning and text block events", () => {
    const subject = announced();
    subject.project({ type: "turn_start", sessionId: ROUTING, messageId: "msg-m1" });
    const thinking = subject.project({
      type: "message_update",
      sessionId: ROUTING,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan " },
    });
    expect(types(thinking)).toEqual(["session.reasoning.started", "session.reasoning.delta"]);
    expect(only(thinking, "session.reasoning.delta").data).toMatchObject({ assistantMessageID: named("msg-m1"), delta: "plan " });

    const text = subject.project({
      type: "message_update",
      sessionId: ROUTING,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" },
    });
    expect(types(text)).toEqual(["session.text.started", "session.text.delta"]);
    const appended = subject.project({
      type: "message_update",
      sessionId: ROUTING,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" },
    });
    expect(types(appended)).toEqual(["session.text.delta"]);
    expect(only(appended, "session.text.delta").data.delta).toBe("lo");
  });

  test("the host message_end closes the open blocks with the assembled content", () => {
    const subject = announced();
    subject.project({ type: "turn_start", sessionId: ROUTING, messageId: "msg-m2" });
    subject.project({ type: "message_update", sessionId: ROUTING, assistantMessageEvent: { type: "thinking_delta", delta: "why" } });
    subject.project({ type: "message_update", sessionId: ROUTING, assistantMessageEvent: { type: "text_delta", delta: "Hello" } });
    const ended = subject.project({
      type: "message_end",
      sessionId: ROUTING,
      message: {
        id: "msg-m2",
        role: "assistant",
        content: [
          { type: "reasoning", text: "why" },
          { type: "text", text: "Hello world" },
        ],
      },
    });
    expect(types(ended)).toEqual(["session.reasoning.ended", "session.text.ended"]);
    expect(only(ended, "session.text.ended").data).toMatchObject({ assistantMessageID: named("msg-m2"), text: "Hello world" });
  });

  test("an unprojected assistant event kind is counted and does not stop the stream", () => {
    const subject = announced();
    expect(
      subject.project({
        type: "message_update",
        sessionId: ROUTING,
        assistantMessageEvent: { type: "toolcall_delta", delta: '{"pa' },
      }),
    ).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("assistantMessageEvent kind not projected: toolcall_delta");
    const next = subject.project({
      type: "message_update",
      sessionId: ROUTING,
      assistantMessageEvent: { type: "text_delta", delta: "after" },
    });
    expect(types(next)).toEqual(["session.text.started", "session.text.delta"]);
  });
});

describe("event cluster: content updates from entries", () => {
  test("entry_appended replaces the open block and takes the message id from the entry", () => {
    const subject = announced();
    subject.project({ type: "turn_start", sessionId: ROUTING, messageId: "msg-e0" });
    subject.project({ type: "message_update", sessionId: ROUTING, assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    const events = subject.project({
      type: "entry_appended",
      sessionId: ROUTING,
      entry: { id: "entry-1", parentId: "entry-0", message: { id: "msg-e1", role: "assistant", content: [{ type: "text", text: "Hello world" }] } },
    });
    expect(types(events)).toEqual(["session.message.content.updated", "session.text.ended"]);
    expect(only(events, "session.text.ended").data).toMatchObject({ assistantMessageID: entry("entry-1"), text: "Hello world" });
  });

  test("entry_appended opens a block when the part was never streamed", () => {
    const subject = announced();
    const events = subject.project({
      type: "entry_appended",
      sessionId: ROUTING,
      entry: {
        id: "entry-2",
        message: {
          id: "msg-e2",
          role: "assistant",
          content: [
            { type: "reasoning", text: "because" },
            { type: "text", text: "answer" },
          ],
        },
      },
    });
    expect(types(events)).toEqual([
      "session.message.content.updated",
      "session.reasoning.started",
      "session.reasoning.ended",
      "session.text.started",
      "session.text.ended",
    ]);
    expect(only(events, "session.text.ended").data).toMatchObject({ assistantMessageID: entry("entry-2"), text: "answer" });
  });

  test("an assistant entry publishes session.message.content.updated with the host message id and its parts", () => {
    const subject = announced();
    const events = subject.project({
      type: "entry_appended",
      sessionId: ROUTING,
      entry: {
        id: "entry-3",
        message: {
          id: "msg-e3",
          role: "assistant",
          content: [
            { type: "reasoning", text: "because" },
            { type: "text", text: "answer" },
            { type: "toolCall", id: "call-1", name: "bash" },
          ],
        },
      },
    });
    expect(only(events, "session.message.content.updated").data).toEqual({
      sessionID: SESSION,
      messageID: entry("entry-3"),
      content: [
        { type: "reasoning", text: "because" },
        { type: "text", text: "answer" },
      ],
    });
    expect(types(events)).toContain("session.text.ended");
  });

  test("a non-assistant entry publishes no content update", () => {
    const subject = announced();
    const events = subject.project({
      type: "entry_appended",
      sessionId: ROUTING,
      entry: { id: "entry-4", message: { id: "msg-e4", role: "user", content: [{ type: "text", text: "hello" }] } },
    });
    expect(types(events)).not.toContain("session.message.content.updated");
  });
});

describe("event cluster: extension events and surfaces", () => {
  test("extension_event travels on the rpc channel with its documented session", () => {
    const subject = announced();
    const events = subject.project({
      type: "extension_event",
      name: "agent_custom",
      sessionId: ROUTING,
      data: { note: "extension owned" },
    });
    expect(types(events)).toEqual(["agent.custom.agent_custom", "rpc.extension.agent_custom"]);
    expect(events[0]?.data).toEqual({
      name: "agent_custom",
      sessionId: ROUTING,
      sessionID: SESSION,
      payload: { note: "extension owned" },
    });
    expect(events[1]?.data).toEqual({ name: "agent_custom", sessionID: SESSION, payload: { note: "extension owned" } });
    expect(events[0]?.metadata).toMatchObject({ eventName: "agent_custom", sessionId: ROUTING });
  });

  test("an extension_event naming an unknown session is not attached and mints no session", () => {
    const subject = projector();
    const events = subject.project({ type: "extension_event", name: "wake", sessionId: "rpc-9", data: {} });
    expect(types(events)).toEqual(["agent.custom.wake", "rpc.extension.wake"]);
    expect(events[0]?.data).toEqual({ name: "wake", sessionId: "rpc-9", payload: {} });
    expect(events[1]?.data).toEqual({ name: "wake", payload: {} });
    expect(subject.project({ kind: "agent_idle", sequence: 0 })).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("frame carries no sessionId and there is no single session to route it to");
  });

  test("loaded_surfaces_changed publishes mcp.tools.changed before the mcp.status.changed substitute", () => {
    const subject = announced();
    const events = subject.project({ type: "loaded_surfaces_changed", sessionId: ROUTING, server: "files" });
    expect(types(events)).toEqual(["mcp.tools.changed", "mcp.status.changed"]);
    expect(only(events, "mcp.tools.changed").data).toEqual({ server: "files" });
    expect(only(events, "mcp.status.changed").data).toEqual({ server: "files" });
  });
});

describe("event cluster: inbox", () => {
  test("queue_update projects enqueued, delivery.changed and delivered for the same text", () => {
    const subject = announced();
    const opened = subject.project({ type: "queue_update", sessionId: ROUTING, steering: ["fix the test"], followUp: ["then commit"] });
    expect(types(opened)).toEqual(["session.inbox.enqueued", "session.inbox.enqueued"]);
    expect(only(opened, "session.inbox.enqueued").data).toMatchObject({
      sessionID: SESSION,
      item: { type: "user", payload: { text: "fix the test" }, delivery: "steer" },
    });
    const follow = opened[1]?.data as { readonly item: { readonly delivery: string }; readonly inboxID: string };
    expect(follow.item.delivery).toBe("queue");

    const moved = subject.project({ type: "queue_update", sessionId: ROUTING, steering: ["fix the test", "then commit"], followUp: [] });
    expect(types(moved)).toEqual(["session.inbox.delivery.changed"]);
    expect(only(moved, "session.inbox.delivery.changed").data).toMatchObject({ inboxID: follow.inboxID, delivery: "steer" });

    const drained = subject.project({ type: "queue_update", sessionId: ROUTING, steering: ["fix the test"], followUp: [] });
    expect(types(drained)).toEqual(["session.inbox.delivered"]);
  });

  test("pending_input_update carries cancellation and delivery changes", () => {
    const subject = announced();
    const opened = subject.project({ type: "queue_update", sessionId: ROUTING, steering: [], followUp: ["later"] });
    const id = String((opened[0]?.data as { readonly inboxID: string }).inboxID);
    const cancelled = subject.project({ type: "pending_input_update", sessionId: ROUTING, changes: [{ type: "cancelled", text: "later" }] });
    expect(types(cancelled)).toEqual(["session.inbox.cancelled"]);
    expect(only(cancelled, "session.inbox.cancelled").data.inboxID).toBe(id);

    const changed = subject.project({
      type: "pending_input_update",
      sessionId: ROUTING,
      changes: [{ type: "delivery_changed", inboxID: id, delivery: "steer" }],
    });
    expect(types(changed)).toEqual(["session.inbox.delivery.changed"]);
    expect(only(changed, "session.inbox.delivery.changed").data).toMatchObject({ inboxID: id, delivery: "steer" });
  });

  test("an unknown pending-input change kind is counted, never thrown", () => {
    const subject = announced();
    expect(
      subject.project({ type: "pending_input_update", sessionId: ROUTING, changes: [{ type: "teleported", inboxID: "msg_x" }] }),
    ).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("pending_input_update change kind not projected: teleported");
  });
});

describe("event cluster: tool execution", () => {
  test("tool_execution_start opens the input and the running call", () => {
    const subject = announced();
    subject.project({ type: "turn_start", sessionId: ROUTING, messageId: "msg-tool" });
    const events = subject.project({
      type: "tool_execution_start",
      sessionId: ROUTING,
      toolCallId: "call-host-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(types(events)).toEqual(["session.tool.input.started", "session.tool.input.ended", "session.tool.called"]);
    expect(only(events, "session.tool.input.started").data).toMatchObject({ id: "call-host-1", name: "bash" });
    expect(only(events, "session.tool.input.ended").data).toMatchObject({ id: "call-host-1", text: '{"command":"ls"}' });
    expect(only(events, "session.tool.called").data).toEqual({
      sessionID: SESSION,
      assistantMessageID: named("msg-tool"),
      id: "call-host-1",
      input: { command: "ls" },
      executed: false,
    });
  });

  test("tool_execution_update projects the partial output as tool progress", () => {
    const subject = announced();
    const events = subject.project({
      type: "tool_execution_update",
      sessionId: ROUTING,
      toolCallId: "call-host-1",
      partialResult: { content: [{ type: "text", text: "a.txt" }] },
    });
    expect(types(events)).toEqual(["session.tool.progress"]);
    expect(only(events, "session.tool.progress").data).toMatchObject({ id: "call-host-1", metadata: { partial: "a.txt" } });
  });

  test("tool_execution_end picks success or failed from isError", () => {
    const subject = announced();
    const ok = subject.project({
      type: "tool_execution_end",
      sessionId: ROUTING,
      toolCallId: "call-host-1",
      isError: false,
      result: { content: [{ type: "text", text: "a.txt" }] },
    });
    expect(types(ok)).toEqual(["session.tool.success"]);
    expect(only(ok, "session.tool.success").data).toMatchObject({
      id: "call-host-1",
      content: [{ type: "text", text: "a.txt" }],
      executed: true,
    });

    const failed = subject.project({
      type: "tool_execution_end",
      sessionId: ROUTING,
      toolCallId: "call-host-2",
      isError: true,
      result: { content: [{ type: "text", text: "ENOENT /work/missing.txt" }] },
    });
    expect(types(failed)).toEqual(["session.tool.failed"]);
    expect(only(failed, "session.tool.failed").data).toMatchObject({
      id: "call-host-2",
      error: { type: "tool_error", message: "ENOENT /work/missing.txt" },
      executed: true,
    });
  });

  test("a declared tool_result carrying isError projects tool.failed, not tool.success", () => {
    const subject = announced();
    subject.project({ kind: "prompt_started", sessionId: ROUTING, sequence: 0, messageId: "msg-1" });
    const failed = subject.project({
      kind: "tool_result",
      sessionId: ROUTING,
      sequence: 1,
      callId: "call-2",
      isError: true,
      result: "Error: ENOENT /work/missing.txt",
    });
    expect(types(failed)).toEqual(["session.tool.failed"]);
    expect(only(failed, "session.tool.failed").data.error).toEqual({
      type: "tool_error",
      message: "Error: ENOENT /work/missing.txt",
    });

    const ok = subject.project({ kind: "tool_result", sessionId: ROUTING, sequence: 2, callId: "call-3", result: "file body" });
    expect(types(ok)).toEqual(["session.tool.success"]);
  });
});

describe("event cluster: unknown records", () => {
  test("an unknown host frame type is counted and the stream stays usable", () => {
    const subject = announced();
    expect(subject.project({ type: "never.shipped.record", sessionId: ROUTING })).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("host frame type not projected: never.shipped.record");
    expect(types(subject.project({ type: "turn_start", sessionId: ROUTING }))).toEqual(["session.step.started"]);
  });
});

describe("event cluster: keepalive and idle watchdog", () => {
  test("a silent stream ends at the client's 45 s idle watchdog", async () => {
    jest.useFakeTimers();
    const api = {
      event: {
        subscribe: (options?: { readonly signal?: AbortSignal }) => {
          async function* events() {
            yield { id: "e1", type: "server.connected", data: {} };
            await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
          }
          return { [Symbol.asyncIterator]: events };
        },
      },
    };
    const connection = createClientConnection(api as never, { onEvent: () => {}, log: {} });
    await drainMicrotasks();
    expect(connection.status()).toBe("connected");
    expect(defaultIdleTimeout).toBe(45_000);

    jest.advanceTimersByTime(44_000);
    await drainMicrotasks();
    expect(connection.internal.history().some((event) => event.data.status === "disconnected")).toBe(false);

    jest.advanceTimersByTime(2_000);
    await drainMicrotasks();
    const disconnected = connection.internal.history().find((event) => event.data.status === "disconnected");
    expect(disconnected?.data.error).toContain("Event stream stalled");
  });
});
