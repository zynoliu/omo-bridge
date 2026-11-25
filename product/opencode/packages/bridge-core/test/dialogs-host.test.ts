import { describe, expect, test } from "bun:test";

import { HostDialogStore } from "../src/dialogs-host.ts";
import type { HostDialogChange, HostResponseFrame } from "../src/dialogs-host.ts";
import { decodeHostFrame } from "../src/host-frames.ts";

const selectPrompt = {
  type: "extension_ui_request",
  id: "ui-permission-1",
  method: "select",
  title: "Permission required: read\n\nPath: /workspace/a.txt",
  options: ["Allow once", "Allow always", "Deny"],
  toolCallId: "call-a",
};

const questionPrompt = {
  type: "extension_ui_request",
  id: "ui-question-1",
  method: "question",
  requestId: "ask-user-1",
  toolCallId: "ask-user-1",
  waitForAnswer: true,
  questions: [
    {
      id: "q1",
      header: "Database",
      question: "Which database should I use?",
      options: [{ label: "PostgreSQL" }],
      multiSelect: false,
    },
  ],
  timeout: 1800000,
  askedAtMs: 1718000000000,
  deadlineAtMs: 1718001800000,
  remainingMs: 1799500,
};

function dialogOf(frame: unknown) {
  const decoded = decodeHostFrame(frame);
  if (!decoded.ok) throw new Error("expected a decoded frame, got: " + decoded.reason);
  if (decoded.frame.type !== "extension_ui_request") throw new Error("expected a dialog, got " + decoded.frame.type);
  return decoded.frame;
}

describe("host dialog store", () => {
  test("keeps a decoded dialog under its request id and announces it once", () => {
    const store = new HostDialogStore();
    const changes: HostDialogChange[] = [];
    store.subscribe((change) => {
      changes.push(change);
    });
    const select = store.upsert(dialogOf(selectPrompt));
    expect(select.id).toBe("ui-permission-1");
    expect(store.get("ui-permission-1")?.method).toBe("select");
    expect(store.list().map((dialog) => dialog.id)).toEqual(["ui-permission-1"]);
    expect(changes.length).toBe(1);
    expect(changes[0].kind).toBe("open");
  });

  test("an update for the same request id replaces the entry instead of adding a second", () => {
    const store = new HostDialogStore();
    store.upsert(dialogOf(selectPrompt));
    store.upsert(dialogOf({ ...selectPrompt, options: ["Allow once", "Deny"] }));
    expect(store.list().length).toBe(1);
    const stored = store.get("ui-permission-1");
    if (stored === undefined || stored.method !== "select") throw new Error("lost the select dialog");
    expect([...stored.options]).toEqual(["Allow once", "Deny"]);
  });

  test("resolving removes the dialog, and resolving the same id again is harmless", () => {
    const store = new HostDialogStore();
    const changes: HostDialogChange[] = [];
    store.subscribe((change) => {
      changes.push(change);
    });
    store.upsert(dialogOf(selectPrompt));
    expect(store.resolve("ui-permission-1")).toBe(true);
    expect(store.list()).toEqual([]);
    expect(changes.map((change) => change.kind)).toEqual(["open", "closed"]);
    expect(store.resolve("ui-permission-1")).toBe(false);
    expect(store.resolve("never-seen")).toBe(false);
    expect(changes.length).toBe(2);
  });

  test("a resolved question closes by its own request id and leaves unrelated dialogs alone", () => {
    const store = new HostDialogStore();
    store.upsert(dialogOf(selectPrompt));
    store.upsert(dialogOf(questionPrompt));
    expect(store.resolveRequest("ask-user-1")).toBe(true);
    expect(store.list().map((dialog) => dialog.id)).toEqual(["ui-permission-1"]);
    expect(store.resolveRequest("ask-user-1")).toBe(false);
    expect(store.resolveRequest("ui-permission-1")).toBe(false);
    expect(store.list().length).toBe(1);
  });

  test("an unsubscribed listener stops receiving changes", () => {
    const store = new HostDialogStore();
    let calls = 0;
    const stop = store.subscribe(() => {
      calls += 1;
    });
    store.upsert(dialogOf(selectPrompt));
    stop();
    stop();
    store.upsert(dialogOf(questionPrompt));
    expect(calls).toBe(1);
  });

  test("the injected sender is held until it is replaced or cleared", () => {
    const store = new HostDialogStore();
    expect(store.sender()).toBeUndefined();
    const sent: HostResponseFrame[] = [];
    const sender = (frame: HostResponseFrame) => {
      sent.push(frame);
    };
    store.useSender(sender);
    expect(store.sender()).toBe(sender);
    store.useSender(undefined);
    expect(store.sender()).toBeUndefined();
    expect(sent.length).toBe(0);
  });
});
