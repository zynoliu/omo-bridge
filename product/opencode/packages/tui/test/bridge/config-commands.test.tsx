import { describe, expect, test } from "bun:test";

import { ConfigError } from "../../src/bridge/features/config/state.ts";
import { projectCommands } from "../../src/bridge/features/config/commands.ts";

const sample = [
  {
    name: "hooks",
    description: "Inspect loaded builtin hook sources and diagnostics.",
    sourceInfo: { path: "<builtin:hooks>", source: "builtin", scope: "system", origin: "top-level" },
  },
];

describe("projectCommands", () => {
  test("projects the host command catalogue shape observed from the real host", () => {
    const projected = projectCommands(sample);
    expect(projected.length).toBe(1);
    expect(projected[0]?.name).toBe("hooks");
    expect(projected[0]?.source.scope).toBe("system");
  });

  test("keeps every host command rather than truncating or inventing", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      name: "cmd-" + String(index),
      description: "",
      sourceInfo: { path: "<builtin:x>", source: "builtin", scope: "system", origin: "top-level" },
    }));
    expect(projectCommands(many).length).toBe(25);
  });

  test("rejects a duplicate command name", () => {
    expect(() => projectCommands([sample[0], sample[0]])).toThrow(ConfigError);
  });

  test("rejects a command without sourceInfo instead of guessing one", () => {
    expect(() => projectCommands([{ name: "x", description: "" }])).toThrow(ConfigError);
  });

  test("rejects a non array payload", () => {
    expect(() => projectCommands({})).toThrow(ConfigError);
  });
});
