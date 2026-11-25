import { describe, expect, test } from "bun:test";

import { createEventSurface } from "../src/event-surface.ts";
import type { BridgeEvent } from "../src/contracts.ts";

const event = (sequence: number): BridgeEvent => ({
  kind: "message.delta",
  sequence: sequence,
  sessionId: "ses_a" as BridgeEvent["sessionId"],
  messageId: "msg_a" as NonNullable<BridgeEvent["messageId"]>,
  payload: "p" + String(sequence),
});

describe("createEventSurface", () => {
  test("delivers published events to an async iterator subscriber in order", async () => {
    const surface = createEventSurface();
    const iterator = surface.subscribe()[Symbol.asyncIterator]();
    surface.publish(event(1));
    surface.publish(event(2));
    expect((await iterator.next()).value?.sequence).toBe(1);
    expect((await iterator.next()).value?.sequence).toBe(2);
    await iterator.return?.(undefined);
  });

  test("abort ends the iterator and removes the subscriber", async () => {
    const surface = createEventSurface();
    const controller = new AbortController();
    const iterator = surface.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    expect(surface.subscriberCount()).toBe(1);
    controller.abort();
    const done = await iterator.next();
    expect(done.done).toBe(true);
    expect(surface.subscriberCount()).toBe(0);
  });

  test("onActivity fires for every published event", async () => {
    const surface = createEventSurface();
    let activity = 0;
    const iterator = surface.subscribe({ onActivity: () => { activity += 1; } })[Symbol.asyncIterator]();
    surface.publish(event(1));
    surface.publish(event(2));
    expect(activity).toBe(2);
    await iterator.return?.(undefined);
  });

  test("two subscribers each receive every event", async () => {
    const surface = createEventSurface();
    const a = surface.subscribe()[Symbol.asyncIterator]();
    const b = surface.subscribe()[Symbol.asyncIterator]();
    surface.publish(event(9));
    expect((await a.next()).value?.sequence).toBe(9);
    expect((await b.next()).value?.sequence).toBe(9);
    await a.return?.(undefined);
    await b.return?.(undefined);
  });
});
