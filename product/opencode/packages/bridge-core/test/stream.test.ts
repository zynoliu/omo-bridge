import { describe, expect, test } from "bun:test";

import { MessageProjector } from "../src/stream.ts";

describe("MessageProjector", () => {
  test("replaces cumulative partial text instead of appending it", () => {
    const projector = new MessageProjector();
    projector.apply({ kind: "partial", sequence: 0, text: "A" });
    projector.apply({ kind: "partial", sequence: 1, text: "AB" });
    const state = projector.apply({ kind: "message_end", sequence: 2, text: "AB" });
    expect(state.text).toBe("AB");
    expect(state.status).toBe("complete");
  });

  test("keeps the final message as the baseline after message_end", () => {
    const projector = new MessageProjector();
    projector.apply({ kind: "partial", sequence: 0, text: "draft" });
    projector.apply({ kind: "message_end", sequence: 1, text: "final" });
    expect(projector.snapshot().text).toBe("final");
  });

  test("ignores an older out of order partial", () => {
    const projector = new MessageProjector();
    projector.apply({ kind: "partial", sequence: 5, text: "newer" });
    const state = projector.apply({ kind: "partial", sequence: 2, text: "older" });
    expect(state.text).toBe("newer");
    expect(state.ignored.some((entry) => entry.startsWith("OUT_OF_ORDER"))).toBe(true);
  });

  test("a missing partial text is ignored without wiping the current text", () => {
    const projector = new MessageProjector();
    projector.apply({ kind: "partial", sequence: 0, text: "keep" });
    const state = projector.apply({ kind: "partial", sequence: 1, text: null });
    expect(state.text).toBe("keep");
    expect(state.ignored).toContain("PARTIAL_WITHOUT_TEXT");
  });

  test("reset clears text, thinking and tool arguments", () => {
    const projector = new MessageProjector();
    projector.apply({ kind: "partial", sequence: 0, text: "x", thinking: "t" });
    projector.apply({ kind: "tool_call", sequence: 1, callId: "c1", arguments: "{\"a\":1}" });
    const state = projector.apply({ kind: "reset", sequence: 2 });
    expect(state.text).toBe("");
    expect(state.thinking).toBe("");
    expect(state.tools).toEqual([]);
  });

  test("tool arguments are replaced per call id and its result is recorded", () => {
    const projector = new MessageProjector();
    projector.apply({ kind: "tool_call", sequence: 0, callId: "c1", arguments: "{\"a\":1}" });
    projector.apply({ kind: "tool_call", sequence: 1, callId: "c1", arguments: "{\"a\":2}" });
    const state = projector.apply({ kind: "tool_result", sequence: 2, callId: "c1", result: "done" });
    expect(state.tools.length).toBe(1);
    expect(state.tools[0]?.arguments).toBe("{\"a\":2}");
    expect(state.tools[0]?.result).toBe("done");
  });

  test("prompt_started is not treated as completion but agent_idle is", () => {
    const projector = new MessageProjector();
    expect(projector.apply({ kind: "prompt_started", sequence: 0 }).status).toBe("streaming");
    expect(projector.apply({ kind: "agent_idle", sequence: 1 }).status).toBe("idle");
  });

  test("unknown extension events are recorded without changing state", () => {
    const projector = new MessageProjector();
    projector.apply({ kind: "partial", sequence: 0, text: "same" });
    const state = projector.apply({ kind: "some.future.extension", sequence: 1, text: "other" });
    expect(state.text).toBe("same");
    expect(state.ignored.some((entry) => entry.startsWith("UNKNOWN_EVENT"))).toBe(true);
  });

  test("a non object event is ignored rather than throwing", () => {
    const projector = new MessageProjector();
    const state = projector.apply(42);
    expect(state.ignored).toContain("NOT_AN_OBJECT");
  });
});
