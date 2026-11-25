import { describe, expect, test } from "bun:test";

import { ConfigError } from "../../src/bridge/features/config/state.ts";
import { assertNonEmpty, projectModels, selectModel } from "../../src/bridge/features/config/models.ts";

describe("model projection", () => {
  test("an empty host list is preserved as empty rather than invented", () => {
    expect(projectModels([])).toEqual([]);
  });

  test("the observed empty model list makes any selection fail loudly", () => {
    const models = projectModels([]);
    expect(() => selectModel(models, "anything")).toThrow(ConfigError);
    expect(() => assertNonEmpty(models, "switch")).toThrow(ConfigError);
  });

  test("a qualified selection resolves and reports the qualified name", () => {
    const models = projectModels([{ provider: "p", id: "m1", thinkingLevels: ["off", "high"] }]);
    const selection = selectModel(models, "p/m1");
    expect(selection.qualified).toBe("p/m1");
    expect(selection.model.thinkingLevels).toEqual(["off", "high"]);
  });

  test("duplicate provider/id pairs are rejected", () => {
    expect(() => projectModels([{ provider: "p", id: "m", thinkingLevels: [] }, { provider: "p", id: "m", thinkingLevels: [] }])).toThrow(ConfigError);
  });

  test("a malformed entry is rejected instead of skipped", () => {
    expect(() => projectModels([{ provider: "p" }])).toThrow(ConfigError);
    expect(() => projectModels({})).toThrow(ConfigError);
  });
});
