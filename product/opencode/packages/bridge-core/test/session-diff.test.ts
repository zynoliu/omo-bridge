import { describe, expect, test } from "bun:test";

import { EventManifest } from "../../schema/src/event-manifest.ts";
import { SessionDiff, sessionChangeEvents } from "../src/session-diff.ts";

const context = { location: { directory: "/work" }, sequence: () => 1, now: () => 1_700_000_000_000 };

describe("session pull diff", () => {
  test("the first snapshot of a session only records it", () => {
    const diff = new SessionDiff();
    expect(diff.observe({ id: "ses_1", title: "named on the host", directory: "/work" })).toEqual([]);
    expect(diff.known()).toEqual(["ses_1"]);
    expect(diff.observe({ id: "ses_1", title: "named on the host", directory: "/work" })).toEqual([]);
  });

  test("a changed title is reported once as a rename", () => {
    const diff = new SessionDiff();
    diff.observe({ id: "ses_1", title: "before", directory: "/work" });
    expect(diff.observe({ id: "ses_1", title: "after", directory: "/work" })).toEqual([
      { kind: "renamed", id: "ses_1", title: "after" },
    ]);
    expect(diff.observe({ id: "ses_1", title: "after", directory: "/work" })).toEqual([]);
  });

  test("a title that appears after an unnamed pull is a rename", () => {
    const diff = new SessionDiff();
    expect(diff.observe({ id: "ses_1", directory: "/work" })).toEqual([]);
    expect(diff.observe({ id: "ses_1", title: "first name", directory: "/work" })).toEqual([
      { kind: "renamed", id: "ses_1", title: "first name" },
    ]);
  });

  test("a title that stops being reported keeps the last known one", () => {
    const diff = new SessionDiff();
    diff.observe({ id: "ses_1", title: "kept", directory: "/work" });
    expect(diff.observe({ id: "ses_1", directory: "/work" })).toEqual([]);
    expect(diff.observe({ id: "ses_1", title: "kept", directory: "/work" })).toEqual([]);
  });

  test("a changed directory is reported as a move", () => {
    const diff = new SessionDiff();
    diff.observe({ id: "ses_1", directory: "/work" });
    expect(diff.observe({ id: "ses_1", directory: "/work/second" })).toEqual([
      { kind: "moved", id: "ses_1", directory: "/work/second" },
    ]);
  });

  test("sessions are tracked independently", () => {
    const diff = new SessionDiff();
    diff.observe({ id: "ses_1", title: "one", directory: "/work" });
    diff.observe({ id: "ses_2", title: "two", directory: "/work" });
    expect(diff.observe({ id: "ses_2", title: "two!", directory: "/work" })).toEqual([
      { kind: "renamed", id: "ses_2", title: "two!" },
    ]);
  });
});

describe("session change events", () => {
  test("a rename is published as the client's own session.renamed event", () => {
    expect(EventManifest.Server.has("session.renamed")).toBe(true);
    expect(EventManifest.Server.has("session.moved")).toBe(true);
    expect(EventManifest.Server.has("session.updated")).toBe(false);
    const events = sessionChangeEvents([{ kind: "renamed", id: "ses_1", title: "after" }], context);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe("session.renamed");
    expect(event?.id.startsWith("evt_")).toBe(true);
    expect(event?.location).toEqual({ directory: "/work" });
    expect(event?.durable).toEqual({ aggregateID: "ses_1", seq: 1, version: 1 });
    expect(event?.data).toEqual({ sessionID: "ses_1", title: "after" });
  });

  test("a move carries the new location and the project it moved into", () => {
    const events = sessionChangeEvents([{ kind: "moved", id: "ses_1", directory: "/work/second" }], context);
    expect(events[0]?.type).toBe("session.moved");
    expect(events[0]?.data).toEqual({
      sessionID: "ses_1",
      location: { directory: "/work/second" },
      projectID: "/work/second",
    });
  });

  test("no change produces no event", () => {
    expect(sessionChangeEvents([], context)).toEqual([]);
  });

  test("the sequence comes from the producer, not from the change itself", () => {
    let next = 0;
    const events = sessionChangeEvents(
      [
        { kind: "renamed", id: "ses_1", title: "a" },
        { kind: "renamed", id: "ses_2", title: "b" },
      ],
      { ...context, sequence: () => (next += 1) },
    );
    expect(events.map((event) => event.durable.seq)).toEqual([1, 2]);
  });
});
