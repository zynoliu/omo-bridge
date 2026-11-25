import { describe, expect, test } from "bun:test";

import { decodeHostExtensionFrame } from "../src/host-extension-frames.ts";

function frame(value: unknown) {
  return decodeHostExtensionFrame(value);
}

describe("host extension frame decoders", () => {
  test("an extension_event keeps its name and payload", () => {
    const decoded = frame({ type: "extension_event", name: "omo.memory.updated", data: { totalSteps: 3 } });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.frame.kind).toBe("extension_event");
    if (decoded.frame.kind !== "extension_event") return;
    expect(decoded.frame.name).toBe("omo.memory.updated");
    expect(decoded.frame.data).toEqual({ totalSteps: 3 });
  });

  test("notify decodes its message and level, and refuses an unknown level", () => {
    const ok = frame({ type: "extension_ui_request", id: "1", method: "notify", message: "hello", notifyType: "warning" });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.frame.kind === "notify") expect(ok.frame.notifyType).toBe("warning");
    const bad = frame({ type: "extension_ui_request", id: "1", method: "notify", message: "hi", notifyType: "loud" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("unknown notifyType");
  });

  test("setStatus distinguishes a missing text from a clear", () => {
    const cleared = frame({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "memory" });
    expect(cleared.ok).toBe(true);
    if (cleared.ok && cleared.frame.kind === "setStatus") expect(cleared.frame.statusText).toBeUndefined();
    const set = frame({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "memory", statusText: "3 steps" });
    if (set.ok && set.frame.kind === "setStatus") expect(set.frame.statusText).toBe("3 steps");
    const wrong = frame({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "memory", statusText: 3 });
    expect(wrong.ok).toBe(false);
  });

  test("setWidget accepts zero rows and keeps the difference from a clear", () => {
    const zero = frame({ type: "extension_ui_request", id: "1", method: "setWidget", widgetKey: "w", widgetLines: [] });
    expect(zero.ok).toBe(true);
    if (zero.ok && zero.frame.kind === "setWidget") expect(zero.frame.widgetLines).toEqual([]);
    const cleared = frame({ type: "extension_ui_request", id: "1", method: "setWidget", widgetKey: "w" });
    if (cleared.ok && cleared.frame.kind === "setWidget") expect(cleared.frame.widgetLines).toBeUndefined();
    const bad = frame({ type: "extension_ui_request", id: "1", method: "setWidget", widgetKey: "w", widgetLines: [1, 2] });
    expect(bad.ok).toBe(false);
    const badPlacement = frame({ type: "extension_ui_request", id: "1", method: "setWidget", widgetKey: "w", widgetPlacement: "left" });
    expect(badPlacement.ok).toBe(false);
  });

  test("widget actions decode as label/command pairs and refuse a partial pair", () => {
    const ok = frame({ type: "extension_ui_request", id: "1", method: "setWidget", widgetKey: "w", widgetActions: [{ label: "Run", command: "run" }] });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.frame.kind === "setWidget") expect(ok.frame.widgetActions).toEqual([{ label: "Run", command: "run" }]);
    const bad = frame({ type: "extension_ui_request", id: "1", method: "setWidget", widgetKey: "w", widgetActions: [{ label: "Run" }] });
    expect(bad.ok).toBe(false);
  });

  test("a custom_message keeps display and refuses a missing customType", () => {
    const ok = frame({ type: "custom_message", id: "m1", customType: "senpi-task.team-member-liveness", content: "x", display: false });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.frame.kind === "custom_message") expect(ok.frame.display).toBe(false);
    const bad = frame({ type: "custom_message", id: "m1", content: "x", display: false });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("customType");
  });

  test("an undecoded method and an unknown type are rejected with a reason, never guessed", () => {
    const method = frame({ type: "extension_ui_request", id: "1", method: "select" });
    expect(method.ok).toBe(false);
    if (!method.ok) expect(method.reason).toContain("select");
    const type = frame({ type: "something_else" });
    expect(type.ok).toBe(false);
    if (!type.ok) expect(type.reason).toContain("unknown frame type");
    expect(frame("text").ok).toBe(false);
    expect(frame(null).ok).toBe(false);
  });
});
