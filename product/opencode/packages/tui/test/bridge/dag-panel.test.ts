import { describe, expect, test } from "bun:test";

import { createPanelState } from "../../src/bridge/features/dag/panel.ts";

describe("right panel exclusivity", () => {
  test("opening the DAG panel closes the terminal or the sidebar", () => {
    const panel = createPanelState();
    expect(panel.open("terminal")).toBe("terminal");
    expect(panel.open("dag")).toBe("dag");
    expect(panel.current()).toBe("dag");
    expect(panel.open("sidebar")).toBe("sidebar");
    expect(panel.current()).toBe("sidebar");
  });

  test("only one panel is ever current", () => {
    const panel = createPanelState("terminal");
    panel.open("dag");
    panel.open("terminal");
    expect(panel.current()).toBe("terminal");
    expect(panel.close()).toBe("none");
  });

  test("a persisted choice restores, and an unknown value restores nothing instead of guessing", () => {
    const panel = createPanelState("dag");
    expect(panel.serialize()).toBe("dag");
    const restored = createPanelState();
    expect(restored.restore("dag")).toBe("dag");
    expect(restored.restore("something-else")).toBe("none");
    expect(restored.restore(undefined)).toBe("none");
  });
});
