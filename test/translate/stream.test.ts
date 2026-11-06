import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createEventBus, type BridgeEvent } from "../../src/http/events";
import { createFrameDispatch } from "../../src/runtime";
import { createStreamProjector } from "../../src/translate/stream";
import type { OpenCodeEvent } from "../../src/translate/types";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "contracts", "senpi");
const SESSION_ID = "ses_stream";
const START = 1_718_000_000_000;

type Fixture = { frame: Record<string, unknown>; role: string; endpoint: string; source: string };

function fixtures(name: string): Fixture[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Fixture);
}

function startFrame(id: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      role: "assistant",
      id,
      content: [],
      provider: "anthropic",
      model: "claude-sonnet-4",
      usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { total: 0 } },
      stopReason: "pending",
      timestamp: START,
    },
  };
}

function replay(frames: unknown[]) {
  const emitted: OpenCodeEvent[] = [];
  let sequence = 0;
  let clock = START;
  const projector = createStreamProjector(
    { sessionID: SESSION_ID, nextID: () => `evt_${++sequence}`, now: () => clock++ },
    (event) => emitted.push(event),
  );
  for (const frame of frames) projector.handle(frame);
  return { emitted, projector };
}

const streamFrames = fixtures("stream.jsonl").map((record) => record.frame);

describe("stream projector", () => {
  test("projects one assistant turn from the derived stream fixture", () => {
    const { emitted } = replay(streamFrames);
    const assistant = (ordinal: number) => ({ sessionID: SESSION_ID, assistantMessageID: "msg_stream_1", ordinal });

    expect(emitted.map(({ type, data }) => ({ type, data }))).toEqual([
      {
        type: "session.step.started",
        data: {
          sessionID: SESSION_ID,
          assistantMessageID: "msg_stream_1",
          agent: "build",
          model: { id: "claude-sonnet-4", providerID: "anthropic" },
          started: START,
        },
      },
      { type: "session.reasoning.started", data: assistant(0) },
      { type: "session.reasoning.delta", data: { ...assistant(0), delta: "Let me " } },
      { type: "session.reasoning.delta", data: { ...assistant(0), delta: "think." } },
      { type: "session.reasoning.ended", data: { ...assistant(0), text: "Let me think." } },
      { type: "session.text.started", data: assistant(0) },
      { type: "session.text.delta", data: { ...assistant(0), delta: "First " } },
      { type: "session.text.delta", data: { ...assistant(0), delta: "block" } },
      { type: "session.text.ended", data: { ...assistant(0), text: "First block" } },
      { type: "session.text.started", data: assistant(1) },
      { type: "session.text.delta", data: { ...assistant(1), delta: "Second block" } },
      { type: "session.text.ended", data: { ...assistant(1), text: "Second block" } },
      {
        type: "session.step.ended",
        data: {
          sessionID: SESSION_ID,
          assistantMessageID: "msg_stream_1",
          finish: "stop",
          tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 10, write: 5 } },
          cost: 0.02,
        },
      },
    ]);
    expect(emitted.map((event) => event.id)).toEqual(emitted.map((_, index) => `evt_${index + 1}`));
    expect(emitted.map((event) => event.created)).toEqual(emitted.map((_, index) => START + index));
  });

  test("gives the two text blocks ordinals 0 and 1", () => {
    const { emitted } = replay(streamFrames);
    const ordinalsOf = (type: string) =>
      emitted.filter((event) => event.type === type).map((event) => event.data.ordinal);
    expect(ordinalsOf("session.text.started")).toEqual([0, 1]);
    expect(ordinalsOf("session.text.ended")).toEqual([0, 1]);
  });

  test("replays the recorded delta fixtures onto text and reasoning events", () => {
    const updates = fixtures("events.jsonl")
      .map((record) => record.frame)
      .filter((frame) => typeof frame.type === "string" && frame.type.startsWith("message_"));
    expect(updates.length).toBeGreaterThan(0);

    const { emitted, projector } = replay([startFrame("msg_events_1"), ...updates]);
    expect(emitted.map((event) => event.type)).toEqual([
      "session.step.started",
      "session.text.started",
      "session.text.delta",
      "session.text.ended",
      "session.reasoning.started",
      "session.reasoning.delta",
      "session.reasoning.ended",
    ]);

    const deltas = emitted
      .filter((event) => event.type === "session.text.delta")
      .map((event) => String(event.data.delta))
      .join("");
    const ended = emitted.find((event) => event.type === "session.text.ended");
    const wireContent = (updates.find((frame) => {
      const update = frame.assistantMessageEvent as { type?: string } | undefined;
      return update?.type === "text_end";
    })?.assistantMessageEvent as { content?: string } | undefined)?.content;
    expect(wireContent).toBe("Hello world");
    expect(deltas).toBe("Hello ");
    expect(ended?.data.text).toBe(deltas);
    expect(ended?.data.text).not.toBe(wireContent);
    expect(projector.stats.ignored).toBe(0);
  });

  test("drops deltas that arrive after the block ended", () => {
    const { emitted } = replay([
      startFrame("msg_late"),
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "hi" } },
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "!" } },
    ]);
    expect(emitted.filter((event) => event.type === "session.text.delta").map((event) => event.data.delta)).toEqual([
      "hi",
    ]);
    expect(emitted.find((event) => event.type === "session.text.ended")?.data.text).toBe("hi");
  });

  test("maps finish reasons, tokens and cost, then clears the current message", () => {
    const { emitted, projector } = replay([
      startFrame("msg_finish"),
      {
        type: "message_end",
        message: {
          role: "assistant",
          id: "msg_finish",
          stopReason: "toolUse",
          usage: {
            input: 7,
            output: 3,
            reasoning: 2,
            cacheRead: 4,
            cacheWrite: 1,
            totalTokens: 17,
            cost: { total: 0.5 },
          },
        },
      },
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "late" } },
    ]);
    expect(emitted.map((event) => event.type)).toEqual(["session.step.started", "session.step.ended"]);
    expect(emitted[1]?.data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID: "msg_finish",
      finish: "tool-calls",
      tokens: { input: 7, output: 3, reasoning: 2, cache: { read: 4, write: 1 } },
      cost: 0.5,
    });
    expect(projector.currentMessageID()).toBeUndefined();
    expect(projector.stats.ignored).toBe(1);
  });

  test("defaults missing usage and unknown stop reasons", () => {
    const { emitted } = replay([
      startFrame("msg_defaults"),
      { type: "message_end", message: { role: "assistant", id: "msg_defaults", stopReason: "aborted" } },
      startFrame("msg_unknown"),
      { type: "message_end", message: { role: "assistant", id: "msg_unknown" } },
    ]);
    const ended = emitted.filter((event) => event.type === "session.step.ended");
    expect(ended[0]?.data).toMatchObject({
      finish: "error",
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    });
    expect(ended[1]?.data).toMatchObject({ finish: "unknown", cost: 0 });
  });

  test("falls back to the wire content for a block that streamed no deltas", () => {
    const { emitted } = replay([
      startFrame("msg_complete"),
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "redacted" },
      },
    ]);
    expect(emitted.find((event) => event.type === "session.reasoning.ended")?.data.text).toBe("redacted");
  });

  // The manual-QA script captures these lines as the emitted-sequence evidence for one turn.
  test("prints the emitted sequence for one assistant turn", () => {
    const { emitted } = replay(streamFrames);
    for (const event of emitted) console.log(`${event.type} ${JSON.stringify(event.data)}`);
    expect(emitted.length).toBeGreaterThan(0);
  });

  test("ignores unknown frames and counts them", () => {
    const { emitted, projector } = replay([
      { type: "quantum_flux", payload: {} },
      { type: "agent_start" },
      null,
      "not an event",
      { type: "message_update", assistantMessageEvent: { type: "telepathy_delta", contentIndex: 0, delta: "x" } },
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "orphan" } },
    ]);
    expect(emitted).toEqual([]);
    expect(projector.stats.ignored).toBe(6);
  });
});

// The host opens an assistant step before it has an id and names it only when the durable entry
// lands. These cases drive the real frame dispatch, so the provisional id the runtime mints, the
// streaming the projectors do under it and the re-key at the entry are all exercised together.
const LIVE_SESSION = "ses_live";
const DURABLE_ID = "msg_durable_1";

function liveTurn() {
  const events: BridgeEvent[] = [];
  const bus = createEventBus({ capacity: 64 });
  const dispatch = createFrameDispatch({
    bus: {
      publish: (draft) => {
        const event = bus.publish(draft);
        events.push(event);
        return event;
      },
      subscribe: bus.subscribe,
      serverConnectedEvent: bus.serverConnectedEvent,
    },
    defaultSessionID: () => LIVE_SESSION,
    resolveSessionID: (routingID) => routingID,
  });
  return { events, dispatch };
}

// A fresh frame per call: the runtime writes the provisional id into `message.id`, so a shared
// object would arrive at the next test already named.
function startFrameWithoutID(): Record<string, unknown> {
  return {
    type: "message_start",
    message: { role: "assistant", content: [], provider: "anthropic", model: "claude-sonnet-4", timestamp: START },
  };
}

function deltaFrame(kind: "text_delta" | "thinking_delta", contentIndex: number, delta: string): Record<string, unknown> {
  return { type: "message_update", assistantMessageEvent: { type: kind, contentIndex, delta } };
}

function entryAppended(id: string, text: string): Record<string, unknown> {
  return {
    type: "entry_appended",
    entry: {
      type: "message",
      id,
      message: { role: "assistant", content: text.length === 0 ? [] : [{ type: "text", text }] },
    },
  };
}

/** One assistant step as the host sends it: no id on the start, then deltas, end and entry. */
function streamedTurn(): BridgeEvent[] {
  const { events, dispatch } = liveTurn();
  dispatch.handle(startFrameWithoutID());
  dispatch.handle({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
  dispatch.handle(deltaFrame("text_delta", 0, "Hel"));
  dispatch.handle(deltaFrame("text_delta", 0, "lo"));
  dispatch.handle({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } });
  dispatch.handle(deltaFrame("thinking_delta", 1, "thinking"));
  dispatch.handle({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", usage: { input: 1, output: 2 } },
  });
  dispatch.handle(entryAppended(DURABLE_ID, "Hello"));
  return events;
}

describe("live step identity", () => {
  test("streams the deltas before any event carries the durable id", () => {
    const events = streamedTurn();
    const deltaIndexes = events.flatMap((event, index) =>
      event.type === "session.text.delta" || event.type === "session.reasoning.delta" ? [index] : [],
    );
    const firstDurable = events.findIndex((event) => event.data.assistantMessageID === DURABLE_ID);

    expect(deltaIndexes).toHaveLength(3);
    expect(firstDurable).toBeGreaterThan(Math.max(...deltaIndexes));
    expect(events[firstDurable]?.type).toBe("session.step.started");
    expect(events.find((event) => event.type === "session.text.delta")?.data.assistantMessageID).toBe("msg_live_1");
  });

  test("re-keys the step exactly once, naming the provisional id it replaces", () => {
    const events = streamedTurn();
    const startsOf = (id: string) =>
      events.filter((event) => event.type === "session.step.started" && event.data.assistantMessageID === id);

    const durableStarts = startsOf(DURABLE_ID);
    expect(durableStarts).toHaveLength(1);
    expect(durableStarts[0]?.data.replaces).toBe("msg_live_1");

    const liveStarts = startsOf("msg_live_1");
    expect(liveStarts).toHaveLength(1);
    expect(liveStarts[0]?.data.replaces).toBeUndefined();

    // The step ends under the live id at the message end and again under the durable id at the entry.
    expect(
      events.filter((event) => event.type === "session.step.ended").map((event) => event.data.assistantMessageID),
    ).toEqual(["msg_live_1", DURABLE_ID]);
  });

  test("emits the reply text exactly once", () => {
    const events = streamedTurn();
    const textDeltas = events.filter((event) => event.type === "session.text.delta");
    const streamed = textDeltas.map((event) => String(event.data.delta)).join("");

    // Re-projecting the entry text would make this "HelloHello".
    expect(streamed).toBe("Hello");
    expect(textDeltas).toHaveLength(2);
  });

  test("projects an entry that never opened a message as a cold start", () => {
    const { events, dispatch } = liveTurn();
    dispatch.handle(entryAppended("msg_cold_1", "Full reply"));

    expect(events.map((event) => event.type)).toEqual([
      "session.step.started",
      "session.text.started",
      "session.text.delta",
      "session.text.ended",
      "session.step.ended",
    ]);
    expect(events[0]?.data).toMatchObject({ sessionID: LIVE_SESSION, assistantMessageID: "msg_cold_1", agent: "build" });
    expect(events[0]?.data.replaces).toBeUndefined();
    expect(events[3]?.data.text).toBe("Full reply");
  });

  test("carries the provisional id before the entry and the durable id after it", () => {
    const { events, dispatch } = liveTurn();
    dispatch.handle(startFrameWithoutID());
    dispatch.handle({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_live", toolName: "bash" },
    });
    dispatch.handle(entryAppended(DURABLE_ID, ""));
    dispatch.handle({ type: "tool_execution_start", toolCallId: "call_live", toolName: "bash", args: { command: "ls" } });
    dispatch.handle({
      type: "tool_execution_end",
      toolCallId: "call_live",
      result: { content: [{ type: "text", text: "ok" }] },
    });

    const idsOf = (type: string) =>
      events.filter((event) => event.type === type).map((event) => event.data.assistantMessageID);
    expect(idsOf("session.tool.input.started")).toEqual(["msg_live_1"]);
    expect(idsOf("session.tool.called")).toEqual([DURABLE_ID]);
    expect(idsOf("session.tool.success")).toEqual([DURABLE_ID]);
  });

  test("reports the durable id for a step the lifecycle saw open under the provisional one", () => {
    const { events, dispatch } = liveTurn();
    dispatch.handle({ type: "agent_start" });
    dispatch.handle(startFrameWithoutID());
    dispatch.handle(entryAppended(DURABLE_ID, "Hello"));
    dispatch.handle({ type: "turn_start" });

    expect(
      events.filter((event) => event.type === "session.step.streamed").map((event) => event.data.assistantMessageID),
    ).toEqual([DURABLE_ID]);
  });
});
