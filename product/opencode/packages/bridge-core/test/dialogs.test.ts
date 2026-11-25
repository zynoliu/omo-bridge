import { describe, expect, test } from "bun:test";

import { DialogRegistry } from "../src/dialogs.ts";

const ONCE = [{ value: "allow-once", label: "Allow once", onceOnly: true }, { value: "deny", label: "Deny", onceOnly: false }];

function registryWith(kind: "select" | "confirm" | "input" | "question", id = "d1") {
  const registry = new DialogRegistry();
  registry.open({ id: id, kind: kind, options: kind === "input" ? [] : ONCE, required: kind === "question" });
  return registry;
}

describe("DialogRegistry", () => {
  test("accepts only a raw host option value and marks it client reported", () => {
    const registry = registryWith("select");
    const result = registry.answer("d1", "allow-once");
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.value).toBe("allow-once");
    expect(result.authorization).toBe("client-reported");
    expect(result.serverVerified).toBe(false);
  });

  test("an unknown option is refused and the dialog stays pending", () => {
    const registry = registryWith("select");
    const result = registry.answer("d1", "allow-forever");
    expect(result.kind === "refused" && result.code).toBe("UNKNOWN_OPTION");
    expect(registry.get("d1")?.state).toBe("pending");
  });

  test("the first answer wins and a second one is refused", () => {
    const registry = registryWith("confirm");
    registry.answer("d1", "allow-once");
    const second = registry.answer("d1", "deny");
    expect(second.kind === "refused" && second.code).toBe("ALREADY_ANSWERED");
    expect(registry.get("d1")?.answer).toBe("allow-once");
  });

  test("an expired dialog refuses a late answer", () => {
    const registry = registryWith("select");
    registry.expire("d1");
    const late = registry.answer("d1", "allow-once");
    expect(late.kind === "refused" && late.code).toBe("NOT_PENDING");
    expect(registry.get("d1")?.state).toBe("expired");
  });

  test("a cancelled dialog refuses a late answer", () => {
    const registry = registryWith("select");
    registry.cancel("d1");
    const late = registry.answer("d1", "allow-once");
    expect(late.kind === "refused" && late.code).toBe("NOT_PENDING");
  });

  test("question required is recorded but never turned into authorization", () => {
    const registry = registryWith("question");
    expect(registry.get("d1")?.required).toBe(true);
    const result = registry.answer("d1", "allow-once");
    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.serverVerified).toBe(false);
  });

  test("concurrent dialogs are answered independently", () => {
    const registry = new DialogRegistry();
    registry.open({ id: "a", kind: "select", options: ONCE, required: false });
    registry.open({ id: "b", kind: "select", options: ONCE, required: false });
    expect(registry.answer("a", "allow-once").kind).toBe("accepted");
    expect(registry.get("b")?.state).toBe("pending");
    expect(registry.pendingDialogs().map((dialog) => dialog.id)).toEqual(["b"]);
  });

  test("pendingDialogs recovery restores only still pending dialogs", () => {
    const registry = new DialogRegistry();
    registry.restorePending([
      { id: "p", kind: "select", options: ONCE, required: false, state: "pending", answer: null },
      { id: "done", kind: "select", options: ONCE, required: false, state: "answered", answer: "deny" },
    ]);
    expect(registry.pendingDialogs().map((dialog) => dialog.id)).toEqual(["p"]);
    expect(registry.get("done")).toBeUndefined();
  });

  test("free text dialogs reject an empty answer", () => {
    const registry = registryWith("input");
    expect(registry.answer("d1", "").kind === "refused").toBe(true);
    expect(registry.answer("d1", "typed").kind).toBe("accepted");
  });

  test("an unknown dialog id is refused", () => {
    const registry = new DialogRegistry();
    expect(registry.answer("missing", "x").kind === "refused").toBe(true);
  });
});
