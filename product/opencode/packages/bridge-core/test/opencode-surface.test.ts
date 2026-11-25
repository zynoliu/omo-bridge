import { describe, expect, test } from "bun:test";

import { BridgeData } from "../src/data.ts";
import { SurfaceNotFound, createSessionSurface } from "../src/opencode-surface.ts";

function seeded() {
  const data = new BridgeData();
  data.upsertSession({ id: "s1", title: "One", messages: 0 });
  data.applyEvent({ kind: "message_end", sequence: 0, messageId: "m1", text: "hello" } as never);
  return createSessionSurface(data);
}

describe("createSessionSurface", () => {
  test("session.list returns the store sessions", async () => {
    const surface = seeded();
    const sessions = await surface.session.list();
    expect(sessions.map((session) => session.id)).toEqual(["s1"]);
  });

  test("session.get returns the session or raises a typed error", async () => {
    const surface = seeded();
    expect((await surface.session.get({ id: "s1" })).title).toBe("One");
    await expect(surface.session.get({ id: "missing" })).rejects.toBeInstanceOf(SurfaceNotFound);
  });

  test("message.list returns the projected message for a known session", async () => {
    const surface = seeded();
    const messages = await surface.message.list({ sessionID: "s1" });
    expect(messages.length).toBe(1);
    expect(messages[0]?.text).toBe("hello");
  });

  test("message.list refuses an unknown session instead of returning empty", async () => {
    const surface = seeded();
    await expect(surface.message.list({ sessionID: "nope" })).rejects.toBeInstanceOf(SurfaceNotFound);
  });
});
