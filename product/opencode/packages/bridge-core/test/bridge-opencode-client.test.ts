import { describe, expect, test } from "bun:test";

import { UnimplementedApiGroup } from "../src/client-surface.ts";
import { createBridgeClientGroups } from "../src/bridge-opencode-client.ts";
import { createEventSurface } from "../src/event-surface.ts";
import { createPartSurface } from "../src/part-surface.ts";
import { BridgeData } from "../src/data.ts";
import { createSessionSurface } from "../src/opencode-surface.ts";
import type { BridgeEvent } from "../src/contracts.ts";

function build() {
  const data = new BridgeData();
  data.upsertSession({ id: "s1", title: "One", messages: 0 });
  data.applyEvent({ kind: "message_end", sequence: 0, messageId: "m1", text: "hi" } as never);
  const events = createEventSurface();
  return { data, events, groups: createBridgeClientGroups({ events, sessions: createSessionSurface(data), parts: createPartSurface(data) }) };
}

const event = (sequence: number): BridgeEvent => ({ kind: "message.delta", sequence, sessionId: "s1" as BridgeEvent["sessionId"], messageId: "m1" as NonNullable<BridgeEvent["messageId"]>, payload: "p" });

describe("bridge client groups", () => {
  test("session.list and session.get read the store", async () => {
    const { groups } = build();
    expect((await groups.session.list()).map((session) => session.id)).toEqual(["s1"]);
    expect((await groups.session.get({ id: "s1" })).title).toBe("One");
  });

  test("session.message.get projects parts", async () => {
    const { groups } = build();
    const parts = await groups.session.message.get({ sessionID: "s1", messageID: "m1" });
    expect(parts.some((part) => part.type === "text")).toBe(true);
  });

  test("event.subscribe streams published events", async () => {
    const { groups, events } = build();
    const iterator = groups.event.subscribe()[Symbol.asyncIterator]();
    events.publish(event(1));
    expect((await iterator.next()).value?.sequence).toBe(1);
    await iterator.return?.(undefined);
  });

  test("config.get throws instead of inventing a configuration", () => {
    const { groups } = build();
    expect(() => groups.config.get()).toThrow(UnimplementedApiGroup);
  });
});
