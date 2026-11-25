import { describe, expect, test } from "bun:test";

import { BridgeData } from "../src/data.ts";

const session = {
  id: "s1",
  projectID: "proj_1",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/workspace/s1" },
};

describe("bridge data subscription", () => {
  test("host session writes notify listeners and advance the revision", () => {
    const data = new BridgeData();
    let calls = 0;
    const stop = data.subscribe(() => {
      calls += 1;
    });
    const before = data.revision();
    data.upsertHostSession(session);
    expect(calls).toBe(1);
    expect(data.revision()).toBe(before + 1);
    stop();
    data.upsertHostSession({ ...session, id: "s2" });
    expect(calls).toBe(1);
  });

  test("message and location writes notify too, and unsubscribing is idempotent", () => {
    const data = new BridgeData();
    let calls = 0;
    const stop = data.subscribe(() => {
      calls += 1;
    });
    data.setHostMessages("s1", [{ id: "m1", type: "idle", time: { created: 3 }, outcome: "succeeded" }]);
    data.mergeLocation({ model: [] });
    expect(calls).toBe(2);
    stop();
    stop();
    expect(calls).toBe(2);
  });

  test("removing a session notifies so views can drop the row", () => {
    const data = new BridgeData();
    data.upsertHostSession(session);
    let calls = 0;
    const stop = data.subscribe(() => {
      calls += 1;
    });
    data.removeHostSession("s1");
    expect(calls).toBe(1);
    expect(data.hostSession("s1")).toBeUndefined();
    stop();
  });

  test("host events are forwarded to subscribers unchanged", () => {
    const data = new BridgeData();
    const seen: unknown[] = [];
    const stop = data.subscribeEvents((event) => {
      seen.push(event);
    });
    const frame = { type: "session.updated", data: { sessionID: "s1" } };
    data.publishEvent(frame);
    expect(seen).toEqual([frame]);
    expect(seen[0]).toBe(frame);
    expect(data.lastPublishedEvent()).toBe(frame);
    stop();
    data.publishEvent({ type: "other" });
    expect(seen.length).toBe(1);
  });
});
