import { describe, expect, test } from "bun:test";

import { ConfigError, ConfigState } from "../../src/bridge/features/config/state.ts";

const OK = { authorized: true };

describe("ConfigState", () => {
  test("a valid model change is applied only with host confirmation", () => {
    const state = new ConfigState();
    expect(state.setModel("gpt-x", { ...OK, known: true }).model).toBe("gpt-x");
  });

  test("an unknown model is refused and state is unchanged", () => {
    const state = new ConfigState();
    expect(() => state.setModel("nope", { ...OK, known: false })).toThrow(ConfigError);
    expect(state.snapshot().model).toBeNull();
  });

  test("an invalid permission preset keeps the previous value and raises", () => {
    const state = new ConfigState();
    state.setPermissionPreset("prompt", { ...OK, allowed: ["prompt", "autoaccept"] });
    try {
      state.setPermissionPreset("yolo", { ...OK, allowed: ["prompt", "autoaccept"] });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) expect(error.code).toBe("INVALID_PRESET");
    }
    expect(state.snapshot().permissionPreset).toBe("prompt");
  });

  test("unauthorised writes are refused for model, thinking, preset and local keys", () => {
    const state = new ConfigState();
    const denied = { authorized: false };
    expect(() => state.setModel("m", { ...denied, known: true })).toThrow(ConfigError);
    expect(() => state.setThinkingLevel("high", denied)).toThrow(ConfigError);
    expect(() => state.setPermissionPreset("prompt", { ...denied, allowed: ["prompt"] })).toThrow(ConfigError);
    expect(() => state.setLocal("theme", "dark", denied)).toThrow(ConfigError);
    expect(state.snapshot()).toEqual({ model: null, thinkingLevel: null, permissionPreset: null, local: {}, reloadCount: 0 });
  });

  test("an unsupported thinking level is rejected", () => {
    const state = new ConfigState();
    expect(() => state.setThinkingLevel("maximum", OK)).toThrow(ConfigError);
    expect(state.setThinkingLevel("high", OK).thinkingLevel).toBe("high");
  });

  test("the host's own level list narrows what the level can be set to", () => {
    const state = new ConfigState();
    const offered = { ...OK, available: ["off", "minimal", "high"] };
    expect(state.setThinkingLevel("minimal", offered).thinkingLevel).toBe("minimal");
    try {
      state.setThinkingLevel("xhigh", offered);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) expect(error.code).toBe("UNSUPPORTED_THINKING_LEVEL");
    }
    expect(state.snapshot().thinkingLevel).toBe("minimal");
  });

  test("loaded surfaces are reported as loaded-only, not as a full catalogue", () => {
    const state = new ConfigState();
    state.reload(["server-a"]);
    const surfaces = state.loadedSurfaces();
    expect(surfaces.mcpServers).toEqual(["server-a"]);
    expect(surfaces.scope).toBe("loaded-only");
    expect(surfaces.note).toContain("not a full");
  });

  test("reload counts and replaces the loaded set", () => {
    const state = new ConfigState();
    state.reload(["a"]);
    state.reload(["b"]);
    expect(state.snapshot().reloadCount).toBe(2);
    expect(state.loadedSurfaces().mcpServers).toEqual(["b"]);
  });
});
