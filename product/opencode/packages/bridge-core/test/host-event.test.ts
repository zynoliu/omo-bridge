import { describe, expect, test } from "bun:test";

import { decodeHostEvent, matchesEventType } from "../src/host-event.ts";

const branchFrame = {
  id: "evt_01j9x4c2m",
  created: 1731990000000,
  type: "vcs.branch.updated",
  location: { directory: "/workspace/bridge" },
  data: { branch: "main" },
};

const agentFrame = {
  id: "evt_01j9x4c2n",
  created: 1731990000001,
  type: "session.agent.selected",
  durable: { aggregateID: "ses_1", seq: 7, version: 1 },
  location: { directory: "/workspace/bridge" },
  data: { sessionID: "ses_1", agent: "build" },
};

function decoded(frame: unknown) {
  const result = decodeHostEvent(frame);
  if (!result.ok) throw new Error("expected a decoded event, got: " + result.reason);
  return result.event;
}

describe("decodeHostEvent", () => {
  test("decodes a well formed ephemeral frame from JSON and keeps every field", () => {
    const event = decoded(JSON.parse(JSON.stringify(branchFrame)));
    expect(event).toEqual(JSON.parse(JSON.stringify(branchFrame)));
    expect(event.type).toBe("vcs.branch.updated");
  });

  test("decodes a durable frame with its envelope so replay ordering survives", () => {
    const event = decoded(JSON.parse(JSON.stringify(agentFrame)));
    expect(event).toEqual(JSON.parse(JSON.stringify(agentFrame)));
    if (event.type !== "session.agent.selected") throw new Error("lost the type discriminator");
    expect(event.durable.seq).toBe(7);
    expect(event.data.agent).toBe("build");
  });

  test("rejects a known type whose payload is missing a required field", () => {
    const result = decodeHostEvent({ id: "evt_01j9x4c2m", created: 1, type: "vcs.branch.updated" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a frame without data should not decode");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("rejects a known type whose field has the wrong type and never coerces it", () => {
    const result = decodeHostEvent({ ...branchFrame, created: "1731990000000" });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a string created timestamp should not decode");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("rejects a durable frame whose envelope version is not the committed one", () => {
    const result = decodeHostEvent({ ...agentFrame, durable: { ...agentFrame.durable, version: 99 } });
    expect(result.ok).toBe(false);
  });

  test("rejects an unknown event type with a reason and does not throw", () => {
    const frame = { id: "evt_01j9x4c2m", created: 1, type: "session.teleported", data: {} };
    expect(() => decodeHostEvent(frame)).not.toThrow();
    const result = decodeHostEvent(frame);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("an unknown type should not decode");
    expect(result.reason).toBe("unknown event type: session.teleported");
  });

  test("rejects a frame that is not an object with a string type", () => {
    const result = decodeHostEvent(JSON.parse('"session.created"'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("a bare string should not decode");
    expect(result.reason).toBe("event frame has no string type");
  });
});

describe("matchesEventType", () => {
  test("matches only the requested type", () => {
    const event = decoded(branchFrame);
    expect(matchesEventType(event, "vcs.branch.updated")).toBe(true);
    expect(matchesEventType(event, "session.created")).toBe(false);
  });
});
