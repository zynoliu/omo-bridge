import { describe, expect, test } from "bun:test";

import { BridgeData } from "../src/data.ts";
import { SurfaceNotFound } from "../src/opencode-surface.ts";
import { createPartSurface } from "../src/part-surface.ts";

function seeded() {
  const data = new BridgeData();
  data.upsertSession({ id: "s1", title: "One", messages: 0 });
  data.applyEvent({ kind: "partial", sequence: 0, text: "hello" } as never);
  data.applyEvent({ kind: "tool_call", sequence: 1, callId: "c1", arguments: "{\"a\":1}" } as never);
  data.applyEvent({ kind: "tool_result", sequence: 2, callId: "c1", result: "ok" } as never);
  return { data: data, surface: createPartSurface(data) };
}

describe("createPartSurface", () => {
  test("projects a text part and a completed tool part in order", async () => {
    const { data, surface } = seeded();
    const parts = await surface.part.list({ sessionID: "s1", messageID: "m1" });
    expect(parts.length).toBe(2);
    expect(parts[0]).toEqual({ type: "text", id: data.ids.partID("m1", { kind: "text", ordinal: 0 }, 0), text: "hello" });
    expect(parts[1]).toEqual({
      type: "tool",
      id: data.ids.partID("m1", { kind: "tool", ordinal: 0 }, 0),
      arguments: "{\"a\":1}",
      result: "ok",
    });
  });

  test("an unknown session raises a typed error instead of an empty list", async () => {
    await expect(seeded().surface.part.list({ sessionID: "nope", messageID: "m1" })).rejects.toBeInstanceOf(SurfaceNotFound);
  });

  test("a session with no text yields only tool parts", async () => {
    const data = new BridgeData();
    data.upsertSession({ id: "s2", title: "Two", messages: 0 });
    data.applyEvent({ kind: "tool_call", sequence: 0, callId: "c9", arguments: "{}" } as never);
    const parts = await createPartSurface(data).part.list({ sessionID: "s2", messageID: "m1" });
    expect(parts.length).toBe(1);
    expect(parts[0]?.type).toBe("tool");
  });
});
