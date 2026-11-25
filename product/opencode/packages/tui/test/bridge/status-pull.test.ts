import { describe, expect, test } from "bun:test";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { createExtensionRequester } from "../../../bridge-core/src/extension-request.ts";
import { connectBridgeStatus, createStatusStore } from "../../src/bridge/features/status/store.ts";

const SESSION = "sess_1";

function withSender() {
  const written: unknown[] = [];
  const requester = createExtensionRequester({ write: (frame) => written.push(frame) });
  const data = new BridgeData();
  data.setExtensionRequester(requester);
  data.upsertHostSession({
    id: SESSION,
    projectID: "proj",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Session",
    location: { directory: "/workspace/s" },
  });
  const store = createStatusStore({ sessionID: SESSION });
  const stop = connectBridgeStatus(store, data);
  return { data: data, store: store, stop: stop, written: written, requester: requester };
}

describe("status memory pull", () => {
  test("with a sender installed the status surface asks the host for its memory snapshot", () => {
    const context = withSender();
    expect(context.written).toHaveLength(1);
    const frame = context.written[0];
    expect(typeof frame === "object" && frame !== null).toBe(true);
    if (typeof frame !== "object" || frame === null) return;
    expect((frame as Record<string, unknown>)["type"]).toBe("extension_request");
    expect((frame as Record<string, unknown>)["name"]).toBe("omo.memory.status");
    context.stop();
  });

  test("the host answer reaches the memory surface instead of being dropped", async () => {
    const context = withSender();
    const frame = context.written[0];
    if (typeof frame !== "object" || frame === null) throw new Error("no frame written");
    const id = (frame as Record<string, unknown>)["id"];
    if (typeof id !== "string") throw new Error("no string id on the request");
    expect(context.requester.accept(id, { id: id, success: true, data: { kind: "unavailable", reason: "no repo" } })).toBe("resolved");
    await Promise.resolve();
    expect(context.store.memory()).not.toBeNull();
    context.stop();
  });

  test("without a sender the surface asks nothing and stays unreported", () => {
    const data = new BridgeData();
    data.upsertHostSession({
      id: SESSION,
      projectID: "proj",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      title: "Session",
      location: { directory: "/workspace/s" },
    });
    const store = createStatusStore({ sessionID: SESSION });
    const stop = connectBridgeStatus(store, data);
    const memory = store.memory();
    expect(memory === null || memory.kind === "not-reported").toBe(true);
    stop();
  });
});
