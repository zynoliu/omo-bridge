import { afterEach, describe, expect, jest, test } from "bun:test";

import type { OpenCodeEvent } from "@opencode/client";
import { Result, Schema, SchemaParser } from "../../schema/node_modules/effect/dist/index.js";
import { EventManifest } from "../../schema/src/event-manifest.ts";

import { createBridgeOpencodeApi } from "../src/opencode-api.ts";
import { BridgeData } from "../src/data.ts";
import { createEventSurface } from "../src/event-surface.ts";
import { HostEventProjector } from "../src/host-projection.ts";
import { BridgeIdScheme } from "../src/id-scheme.ts";
import { createSessionSurface } from "../src/opencode-surface.ts";
import { createPartSurface } from "../src/part-surface.ts";

const location = { directory: "/work" };

/** The client's own definition for one event type, decoded on its encoded side (the wire shape). */
function clientAccepts(event: { readonly type: string; readonly data: unknown }): boolean {
  const definition = EventManifest.Server.get(event.type);
  if (definition === undefined) return false;
  return Result.isSuccess(SchemaParser.decodeUnknownResult(Schema.toEncoded(definition.data))(event.data));
}

function projector(): HostEventProjector {
  return new HostEventProjector({ location: location, now: () => 1_000 });
}

function types(events: readonly OpenCodeEvent[]): string[] {
  return events.map((event) => event.type);
}

function only<Type extends OpenCodeEvent["type"]>(events: readonly OpenCodeEvent[], type: Type): Extract<OpenCodeEvent, { type: Type }> {
  const found = events.find((event): event is Extract<OpenCodeEvent, { type: Type }> => event.type === type);
  if (found === undefined) throw new Error("no " + type + " event in " + JSON.stringify(types(events)));
  return found;
}

function idOrdinals(ids: readonly string[]): number[] {
  return ids.map((id) => Number(id.replace("bridge-", "")));
}

const statusFrame = (overrides: Record<string, unknown> = {}) => ({
  type: "session_status",
  subscriptionId: "sub-1",
  seq: 0,
  sessionId: "rpc-1",
  durableSessionId: "ses_durable",
  kind: "interactive",
  cwd: "/work",
  status: "idle",
  ...overrides,
});

/* The stream's abort listener, generator finally and unsubscribe all run as microtasks, so the queue
   is drained a bounded number of times instead of waiting on a timer. */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

afterEach(() => {
  jest.useRealTimers();
});

describe("host event projection: session lifecycle", () => {
  test("session_status announces the durable session once and reports status changes after", () => {
    const subject = projector();
    const first = subject.project(statusFrame({ seq: 0, status: "idle" }));
    expect(types(first)).toEqual(["session.created", "session.status"]);
    expect(only(first, "session.created").data.sessionID).toBe("ses_durable");
    expect(only(first, "session.status").data).toEqual({ sessionID: "ses_durable", status: { type: "idle" } });

    const running = subject.project(statusFrame({ seq: 1, status: "running" }));
    expect(types(running)).toEqual(["session.status"]);
    expect(only(running, "session.status").data.status).toEqual({ type: "busy" });
  });

  /* Regression: this frame used to build its status event first and emit it second, so the created
     event carried the later id and a subscriber saw bridge-2 before bridge-1. */
  test("session_status numbers the events it emits in the order it emits them", () => {
    const subject = projector();
    const events = subject.project(statusFrame({ seq: 0 }));
    expect(types(events)).toEqual(["session.created", "session.status"]);
    expect(events.map((event) => event.id)).toEqual(["bridge-1", "bridge-2"]);
  });

  test("session_closed deletes only when the session directory is gone", () => {
    const subject = projector();
    subject.project(statusFrame({ seq: 0 }));
    const parked = subject.project({ type: "session_closed", sessionId: "rpc-1", reason: "client_close" });
    expect(types(parked)).toEqual(["session.status"]);

    const removed = subject.project({ type: "session_closed", sessionId: "rpc-1", reason: "session_dir_removed" });
    expect(types(removed)).toEqual(["session.deleted"]);
    expect(only(removed, "session.deleted").data.sessionID).toBe("ses_durable");
  });

  test("session_opened announces a session the subscription never reported", () => {
    const subject = projector();
    const events = subject.project({ type: "session_opened", sessionId: "rpc-2", durableSessionId: "ses_two", cwd: "/work" });
    expect(types(events)).toEqual(["session.created"]);
    expect(only(events, "session.created").data).toMatchObject({ sessionID: "ses_two", slug: "ses_two", version: "bridge" });
  });

  test("a stream frame that arrives before the routing pair is announced under the durable id", () => {
    const subject = projector();
    const early = subject.project({ kind: "prompt_started", sessionId: "rpc-7", messageId: "msg_7", sequence: 0 });
    expect(types(early)).toEqual(["session.execution.started"]);

    const status = subject.project({
      type: "session_status",
      subscriptionId: "sub-9",
      seq: 0,
      sessionId: "rpc-7",
      durableSessionId: "ses_seven",
      status: "running",
    });
    expect(types(status)).toEqual(["session.created", "session.status"]);
    expect(only(status, "session.created").data.sessionID).toBe("ses_seven");

    const next = subject.project({ kind: "partial", sessionId: "rpc-7", sequence: 1, text: "hi" });
    expect(only(next, "session.text.delta").data).toMatchObject({ sessionID: "ses_seven", assistantMessageID: "msg_7" });

    const again = subject.project({
      type: "session_status",
      subscriptionId: "sub-9",
      seq: 1,
      sessionId: "rpc-7",
      durableSessionId: "ses_seven",
      status: "idle",
    });
    expect(types(again)).toEqual(["session.status"]);
  });

  test("an extension event is projected on the rpc channel without minting a session", () => {
    const subject = projector();
    const events = subject.project({ type: "extension_event", name: "wake_source_state", sessionId: "rpc-9", data: { on: true } });
    expect(types(events)).toEqual(["agent.custom.wake_source_state", "rpc.extension.wake_source_state"]);
    expect(events[0]?.data).toEqual({ name: "wake_source_state", sessionId: "rpc-9", payload: { on: true } });
    expect(events[1]?.data).toEqual({ name: "wake_source_state", payload: { on: true } });
    /* The unknown routing id announced nothing, so a later session-less frame still has no session. */
    expect(subject.project({ kind: "agent_idle", sequence: 0 })).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("frame carries no sessionId and there is no single session to route it to");
  });
});

describe("host event projection: message and part updates", () => {
  test("prompt, partial and message_end project execution and block updates", () => {
    const subject = projector();
    const started = subject.project({ kind: "prompt_started", sessionId: "ses_durable", messageId: "msg_1", sequence: 0 });
    expect(types(started)).toEqual(["session.execution.started"]);

    const partial = subject.project({ kind: "partial", sessionId: "ses_durable", messageId: "msg_1", sequence: 1, text: "Hel", thinking: "plan" });
    expect(types(partial)).toEqual(["session.reasoning.started", "session.reasoning.delta", "session.text.started", "session.text.delta"]);
    expect(only(partial, "session.reasoning.delta").data.delta).toBe("plan");
    expect(only(partial, "session.text.delta").data).toEqual({
      sessionID: "ses_durable",
      assistantMessageID: "msg_1",
      ordinal: 1,
      delta: "Hel",
    });

    const extended = subject.project({ kind: "partial", sessionId: "ses_durable", sequence: 2, text: "Hello" });
    expect(types(extended)).toEqual(["session.text.delta"]);
    expect(only(extended, "session.text.delta").data.delta).toBe("lo");

    const ended = subject.project({ kind: "message_end", sessionId: "ses_durable", sequence: 3, text: "Hello" });
    expect(types(ended)).toEqual(["session.reasoning.ended", "session.text.ended"]);
    expect(only(ended, "session.text.ended").data.text).toBe("Hello");
  });

  test("a rewritten partial closes the block and opens a new one", () => {
    const subject = projector();
    subject.project({ kind: "prompt_started", sessionId: "ses_durable", sequence: 0 });
    subject.project({ kind: "partial", sessionId: "ses_durable", sequence: 1, text: "draft" });
    const rewritten = subject.project({ kind: "partial", sessionId: "ses_durable", sequence: 2, text: "final" });
    expect(types(rewritten)).toEqual(["session.text.ended", "session.text.started", "session.text.delta"]);
    expect(only(rewritten, "session.text.started").data.ordinal).toBe(2);
    expect(only(rewritten, "session.text.delta").data.delta).toBe("final");
  });

  test("tool_call and tool_result project the tool lifecycle", () => {
    const subject = projector();
    subject.project({ kind: "prompt_started", sessionId: "ses_durable", messageId: "msg_1", sequence: 0 });
    const called = subject.project({ kind: "tool_call", sessionId: "ses_durable", sequence: 1, callId: "call-1", arguments: '{"command":"ls"}' });
    expect(only(called, "session.tool.called").data).toEqual({
      sessionID: "ses_durable",
      assistantMessageID: "msg_1",
      id: "call-1",
      input: { command: "ls" },
      executed: false,
    });

    const succeeded = subject.project({ kind: "tool_result", sessionId: "ses_durable", sequence: 2, callId: "call-1", result: "file.txt" });
    expect(only(succeeded, "session.tool.success").data.content).toEqual([{ type: "text", text: "file.txt" }]);
  });

  test("unparseable tool arguments keep the raw text in metadata and an empty input", () => {
    const subject = projector();
    const called = subject.project({ kind: "tool_call", sessionId: "ses_durable", sequence: 0, callId: "call-2", arguments: "{not json" });
    expect(only(called, "session.tool.called").data.input).toEqual({});
    expect(only(called, "session.tool.called").metadata).toMatchObject({ rawArguments: "{not json" });
  });

  test("agent_idle projects the idle event", () => {
    const subject = projector();
    const events = subject.project({ kind: "agent_idle", sessionId: "ses_durable", sequence: 4 });
    expect(types(events)).toEqual(["session.idle"]);
    expect(only(events, "session.idle").data.sessionID).toBe("ses_durable");
  });

  test("auto_retry_start schedules a retry and auto_retry_end reports its outcome", () => {
    const subject = projector();
    subject.project({ kind: "prompt_started", sessionId: "ses_durable", messageId: "msg_1", sequence: 0 });
    const retry = subject.project({
      kind: "auto_retry_start",
      sessionId: "ses_durable",
      sequence: 1,
      attempt: 2,
      delayMs: 2_000,
      errorMessage: "529 overloaded",
    });
    expect(only(retry, "session.retry.scheduled").data).toEqual({
      sessionID: "ses_durable",
      assistantMessageID: "msg_1",
      attempt: 2,
      at: 3_000,
      error: { type: "auto_retry", message: "529 overloaded" },
    });

    const recovered = subject.project({ kind: "auto_retry_end", sessionId: "ses_durable", sequence: 2, success: true, attempt: 2 });
    expect(only(recovered, "session.status").data.status).toEqual({ type: "busy" });

    const failed = subject.project({ kind: "auto_retry_end", sessionId: "ses_durable", sequence: 3, success: false, attempt: 3, finalError: "exhausted" });
    expect(only(failed, "session.execution.failed").data.error).toEqual({ type: "auto_retry", message: "exhausted" });
  });

  test("event ids are monotonic and carry the host sequence when the frame has one", () => {
    const subject = projector();
    const events = [
      ...subject.project({ kind: "prompt_started", sessionId: "ses_durable", sequence: 7 }),
      ...subject.project({ kind: "partial", sessionId: "ses_durable", sequence: 8, text: "a" }),
    ];
    const ids = events.map((event) => Number(event.id.replace("bridge-", "")));
    expect(ids).toEqual([...ids].sort((left, right) => left - right));
    expect(new Set(ids).size).toBe(ids.length);
    expect(events[0]?.metadata).toMatchObject({ sequence: 7 });
    expect(events[1]?.metadata).toMatchObject({ sequence: 8 });
  });
});

describe("host event projection: permission lifecycle", () => {
  const select = {
    type: "extension_ui_request",
    id: "ui-perm-1",
    method: "select",
    title: "Permission required: read\n\nPath: /work/a.txt",
    options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
    toolCallId: "call-9",
    sessionId: "ses_durable",
  };

  test("a permission select projects permission.asked with its action, text and options", () => {
    const subject = projector();
    const events = subject.project(select);
    expect(types(events)).toEqual(["permission.asked"]);
    const asked = only(events, "permission.asked");
    expect(asked.data).toMatchObject({
      id: "per_ui-perm-1",
      sessionID: "ses_durable",
      action: "read",
      resources: [],
      message: select.title,
    });
    expect(asked.metadata).toMatchObject({ options: select.options, toolCallId: "call-9" });
    expect(clientAccepts(asked)).toBe(true);
  });

  test("the matching extension_ui_response projects permission.replied", () => {
    const subject = projector();
    subject.project(select);
    const events = subject.project({ type: "extension_ui_response", id: "resp-1", uiRequestId: "ui-perm-1", value: "Allow once" });
    expect(only(events, "permission.replied").data).toEqual({ sessionID: "ses_durable", requestID: "per_ui-perm-1", reply: "once" });
    expect(clientAccepts(only(events, "permission.replied"))).toBe(true);

    const cancel = subject.project({ type: "extension_ui_response", id: "resp-2", uiRequestId: "ui-perm-2", cancelled: true });
    expect(cancel).toEqual([]);
  });

  test("a dialog event the client schema would refuse is reported, not published", () => {
    const subject = projector();
    const events = subject.project({ ...select, sessionId: "routing-without-a-client-brand" });
    expect(events).toEqual([]);
    expect(subject.stats().ignoredReasons.join("\n")).toContain("dialog event rejected by the client schema: Expected a string starting with \"ses\"");
  });

  test("a cancelled permission dialog settles as a rejection", () => {
    const subject = projector();
    subject.project(select);
    const events = subject.project({ type: "extension_ui_response", id: "resp-3", uiRequestId: "ui-perm-1", cancelled: true });
    expect(only(events, "permission.replied").data.reply).toBe("reject");
  });

  test("a select dialog that is not a permission prompt is counted, not projected", () => {
    const subject = projector();
    const events = subject.project({ ...select, title: "Pick a model", options: ["a", "b"] });
    expect(events).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("select dialog is not a permission prompt");
  });
});

describe("host event projection: form lifecycle", () => {
  const question = {
    type: "extension_ui_request",
    id: "ui-question-1",
    method: "question",
    requestId: "req-1",
    toolCallId: "call-q",
    waitForAnswer: true,
    questions: [
      {
        id: "q-1",
        header: "Scope",
        question: "Which files?",
        options: [{ label: "all", description: "every file" }, { label: "changed" }],
        multiSelect: false,
      },
      { id: "q-2", header: "Notes", question: "Anything else?", options: [], multiSelect: true },
    ],
    timeout: 60_000,
    askedAtMs: 1,
    deadlineAtMs: 60_001,
    remainingMs: 60_000,
    sessionId: "ses_durable",
  };

  test("a question projects form.created with one field per question", () => {
    const subject = projector();
    const events = subject.project(question);
    const form = only(events, "form.created").data.form;
    expect(form.id).toBe("frm_req-1");
    expect(form.sessionID).toBe("ses_durable");
    expect(form.fields).toHaveLength(2);
    expect(clientAccepts(only(events, "form.created"))).toBe(true);
    const field = form.fields[0];
    expect(field).toMatchObject({ key: "q0", title: "Scope", description: "Which files?", custom: true });
    if (field?.type !== "string") throw new Error("the first field is not a string field");
    expect(field.options).toEqual([
      { value: "all", label: "all", description: "every file" },
      { value: "changed", label: "changed" },
    ]);
    expect(form.fields[1]).toMatchObject({ key: "q1", type: "multiselect" });
    expect(form.metadata).toMatchObject({ kind: "question", toolCallId: "call-q", dialogId: "ui-question-1" });
  });

  test("question_resolved answered projects form.replied on the form's field keys", () => {
    const subject = projector();
    subject.project(question);
    const events = subject.project({
      type: "question_resolved",
      id: "ui-question-1",
      requestId: "req-1",
      toolCallId: "call-q",
      outcome: "answered",
      answers: { "q-1": { selected: ["all"] }, "q-2": { selected: ["x", "y"] } },
      unanswered: [],
    });
    expect(only(events, "form.replied").data).toEqual({
      id: "frm_req-1",
      sessionID: "ses_durable",
      answer: { q0: ["all"], q1: ["x", "y"] },
    });
    expect(clientAccepts(only(events, "form.replied"))).toBe(true);
  });

  test("question_resolved timed out projects form.cancelled", () => {
    const subject = projector();
    subject.project(question);
    const events = subject.project({
      type: "question_resolved",
      id: "ui-question-1",
      requestId: "req-1",
      toolCallId: "call-q",
      outcome: "timed_out",
      answers: {},
      unanswered: ["q-1", "q-2"],
    });
    expect(only(events, "form.cancelled").data).toEqual({ id: "frm_req-1", sessionID: "ses_durable" });
    expect(clientAccepts(only(events, "form.cancelled"))).toBe(true);
  });

  test("a required question is published as required and an answer that leaves it empty is refused", () => {
    const subject = projector();
    const requiredQuestion = {
      ...question,
      id: "ui-question-2",
      requestId: "req-2",
      questions: [
        { id: "q-1", header: "Version", question: "Which version?", options: [{ label: "1" }], multiSelect: false, required: true },
        { id: "q-2", header: "Note", question: "Anything else?", options: [], multiSelect: false },
      ],
    };
    const created = subject.project(requiredQuestion);
    /* FormField1's union has members without the optional flag, so the published fields are compared as data */
    expect(JSON.parse(JSON.stringify(only(created, "form.created").data.form.fields))).toEqual([
      expect.objectContaining({ key: "q0", required: true }),
      expect.objectContaining({ key: "q1" }),
    ]);

    const refused = subject.project({
      type: "question_resolved",
      id: "ui-question-2",
      requestId: "req-2",
      outcome: "answered",
      answers: { "q-2": { text: "none" } },
      unanswered: ["q-1"],
    });
    expect(refused).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain(
      'form reply rejected: {"_tag":"FormInvalidAnswerError","id":"frm_req-2","message":"Missing required form field: q0"}',
    );

    /* the form is still pending, so the answer that does supply the required field settles it */
    const settled = subject.project({
      type: "question_resolved",
      id: "ui-question-2",
      requestId: "req-2",
      outcome: "answered",
      answers: { "q-1": { selected: ["1"] }, "q-2": { text: "none" } },
      unanswered: [],
    });
    expect(only(settled, "form.replied").data.answer).toEqual({ q0: ["1"], q1: "none" });
  });

  test("a cancelled dialog answer cancels its form and settles it once", () => {
    const subject = projector();
    subject.project(question);
    const events = subject.project({ type: "extension_ui_response", id: "resp-9", uiRequestId: "ui-question-1", cancelled: true });
    expect(types(events)).toEqual(["form.cancelled"]);
    expect(subject.project({ type: "extension_ui_response", id: "resp-10", uiRequestId: "ui-question-1", cancelled: true })).toEqual([]);
  });
});

describe("host event projection: unprojectable frames", () => {
  test("unknown shapes are counted and never thrown", () => {
    const subject = projector();
    expect(subject.project({ weird: true })).toEqual([]);
    expect(subject.project("not a frame")).toEqual([]);
    expect(subject.project(null)).toEqual([]);
    expect(subject.project({ type: "brand.new.record" })).toEqual([]);
    expect(subject.project({ kind: "mystery_frame" })).toEqual([]);
    expect(subject.project({ type: "session_parked", sessionId: "rpc-1" })).toEqual([]);
    const stats = subject.stats();
    expect(stats.ignored).toBe(6);
    expect(stats.projected).toBe(0);
    expect(stats.ignoredReasons.length).toBe(6);
  });

  test("a duplicate or out-of-order sequence is dropped", () => {
    const subject = projector();
    const first = subject.project({ kind: "partial", sessionId: "ses_durable", sequence: 5, text: "newer" });
    expect(types(first)).toEqual(["session.text.started", "session.text.delta"]);
    expect(subject.project({ kind: "partial", sessionId: "ses_durable", sequence: 4, text: "older" })).toEqual([]);
    expect(subject.project({ kind: "partial", sessionId: "ses_durable", sequence: 5, text: "again" })).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("duplicate or out-of-order stream sequence 4");
    expect(subject.stats().ignoredReasons).toContain("duplicate or out-of-order stream sequence 5");
  });

  test("a duplicate subscription seq is dropped", () => {
    const subject = projector();
    expect(subject.project(statusFrame({ seq: 0 }))).toHaveLength(2);
    expect(subject.project(statusFrame({ seq: 0 }))).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("duplicate or out-of-order subscription seq 0");
  });

  test("a frame without a session is ignored once more than one session is known", () => {
    const subject = projector();
    subject.project(statusFrame({ seq: 0, sessionId: "rpc-1", durableSessionId: "ses_one" }));
    subject.project(statusFrame({ seq: 1, sessionId: "rpc-2", durableSessionId: "ses_two" }));
    expect(subject.project({ kind: "agent_idle", sequence: 0 })).toEqual([]);
    expect(subject.stats().ignoredReasons).toContain("frame carries no sessionId and there is no single session to route it to");
  });
});

describe("bridge client event stream", () => {
  test("keeps server.connected first, yields projected events, ticks activity and releases its subscriber on abort", async () => {
    jest.useFakeTimers();
    const data = new BridgeData();
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: location,
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    const controller = new AbortController();
    const activities: number[] = [];
    const iterator = api.event.subscribe({ signal: controller.signal, onActivity: () => activities.push(1) })[Symbol.asyncIterator]();

    const connected = await iterator.next();
    expect(connected.value?.type).toBe("server.connected");
    expect(data.eventSubscriberCount()).toBe(1);

    data.publishEvent(statusFrame({ seq: 0 }));
    const created = await iterator.next();
    expect(created.value?.type).toBe("session.created");
    const status = await iterator.next();
    expect(status.value?.type).toBe("session.status");

    expect(activities).toHaveLength(0);
    jest.advanceTimersByTime(15_000);
    expect(activities).toHaveLength(1);
    jest.advanceTimersByTime(30_000);
    expect(activities).toHaveLength(3);

    controller.abort();
    const ended = await iterator.next();
    await drainMicrotasks();
    expect(ended.done).toBe(true);
    expect(data.eventSubscriberCount()).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(activities).toHaveLength(3);
  });

  test("an unprojectable frame leaves the stream open and yields nothing", async () => {
    jest.useFakeTimers();
    const data = new BridgeData();
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: location,
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    const controller = new AbortController();
    const iterator = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("server.connected");

    data.publishEvent({ type: "brand.new.record" });
    data.publishEvent({ kind: "partial", sessionId: "ses_durable", sequence: 0, text: "after" });
    const next = await iterator.next();
    expect(next.value?.type).toBe("session.text.started");

    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    await drainMicrotasks();
    expect(data.eventSubscriberCount()).toBe(0);
  });

  test("the wired stream yields session.created before session.status with strictly ascending ids", async () => {
    jest.useFakeTimers();
    const data = new BridgeData();
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: location,
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    const controller = new AbortController();
    const iterator = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("server.connected");

    data.publishEvent(statusFrame({ seq: 0 }));
    const observed: { readonly id: string; readonly type: string }[] = [];
    for (let index = 0; index < 2; index += 1) {
      const next = await iterator.next();
      if (next.value !== undefined) observed.push({ id: String(next.value.id), type: String(next.value.type) });
    }
    expect(observed.map((event) => event.type)).toEqual(["session.created", "session.status"]);
    expect(observed.map((event) => event.id)).toEqual(["bridge-1", "bridge-2"]);
    const ordinals = idOrdinals(observed.map((event) => event.id));
    expect(ordinals.every((ordinal, index) => index === 0 || ordinal > (ordinals[index - 1] ?? Number.NaN))).toBe(true);

    controller.abort();
    await iterator.next();
    await drainMicrotasks();
    expect(data.eventSubscriberCount()).toBe(0);
  });

  test("the stream reports projected and unmapped frame counts when it closes", async () => {
    jest.useFakeTimers();
    const data = new BridgeData();
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: location,
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    const writes: string[] = [];
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      const controller = new AbortController();
      const iterator = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
      expect((await iterator.next()).value?.type).toBe("server.connected");
      data.publishEvent({ type: "brand.new.record" });
      data.publishEvent(statusFrame({ seq: 0 }));
      await iterator.next();
      controller.abort();
      await iterator.next();
      await drainMicrotasks();
    } finally {
      process.stderr.write = original;
    }
    const report = writes.find((line) => line.includes("event projection"));
    expect(report).toBeDefined();
    expect(report).toContain("2 events projected");
    expect(report).toContain("1 frames ignored");
  });
});

describe("live message identities", () => {
  const DURABLE = "ses_durable";
  const clientShaped = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

  /** The official host's live message records carry no id at all, so this is the frame shape measured there. */
  function liveTurn(): readonly OpenCodeEvent[] {
    const subject = new HostEventProjector({ location: location, now: () => 1_000 });
    subject.project(statusFrame());
    const events: OpenCodeEvent[] = [];
    events.push(...subject.project({ type: "turn_start", sessionId: "rpc-1" }));
    events.push(...subject.project({ type: "message_start", sessionId: "rpc-1", message: { role: "assistant", content: [] } }));
    events.push(
      ...subject.project({
        type: "message_update",
        sessionId: "rpc-1",
        assistantMessageEvent: { type: "text_delta", delta: "OK" },
      }),
    );
    events.push(
      ...subject.project({
        type: "message_end",
        sessionId: "rpc-1",
        message: { role: "assistant", timestamp: 900, content: [{ type: "text", text: "OK" }] },
      }),
    );
    return events;
  }

  test("a live turn carries client message ids although the host names no message", () => {
    const events = liveTurn();
    const step = only(events, "session.step.started").data as { readonly assistantMessageID: string };
    const ended = only(events, "session.text.ended").data as { readonly assistantMessageID: string };
    expect(step.assistantMessageID).toMatch(clientShaped);
    expect(ended.assistantMessageID).toBe(step.assistantMessageID);
    expect(events.every((event) => clientAccepts(event))).toBe(true);
  });

  test("an appended entry mints the id the pulled transcript mints for that entry", () => {
    const subject = new HostEventProjector({ location: location, now: () => 1_000 });
    subject.project(statusFrame());
    const events = subject.project({
      type: "entry_appended",
      sessionId: "rpc-1",
      entry: {
        id: "ee01",
        parentId: "ee00",
        message: { id: "not-an-id", role: "assistant", timestamp: 700, content: [{ type: "text", text: "OK" }] },
      },
    });
    const update = only(events, "session.message.content.updated");
    const expected = new BridgeIdScheme().messageID({ sessionID: DURABLE, entryID: "ee01" }, 700);
    expect(update.data).toMatchObject({ sessionID: DURABLE, messageID: expected });
    expect(update.metadata).toMatchObject({ hostEntryID: "ee01" });
    expect((update.data as { readonly messageID: string }).messageID).not.toBe("ee01");
    expect(clientAccepts(update)).toBe(true);
  });

  test("two messages of one session never share a bridge id", () => {
    const subject = new HostEventProjector({ location: location, now: () => 1_000 });
    subject.project(statusFrame());
    const firstMessage = subject.project({
      type: "message_start",
      sessionId: "rpc-1",
      message: { role: "assistant", content: [] },
    });
    expect(firstMessage).toEqual([]);
    const first = subject.project({
      type: "message_update",
      sessionId: "rpc-1",
      assistantMessageEvent: { type: "text_delta", delta: "one" },
    });
    subject.project({ type: "message_end", sessionId: "rpc-1", message: { role: "assistant", content: [{ type: "text", text: "one" }] } });
    subject.project({ type: "message_start", sessionId: "rpc-1", message: { role: "assistant", content: [] } });
    const second = subject.project({
      type: "message_update",
      sessionId: "rpc-1",
      assistantMessageEvent: { type: "text_delta", delta: "two" },
    });
    const firstID = (only(first, "session.text.started").data as { readonly assistantMessageID: string }).assistantMessageID;
    const secondID = (only(second, "session.text.started").data as { readonly assistantMessageID: string }).assistantMessageID;
    expect(firstID).toMatch(clientShaped);
    expect(secondID).toMatch(clientShaped);
    expect(firstID).not.toBe(secondID);
  });
});
