import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Option, Schema } from "effect";
import { createBridgeTuiConfig } from "../../../cli/src/bridge-config.ts";
import { Config } from "../../src/config";

const decode = (value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(Config.Info)(value));

const defaults = { terminalSuspend: true } as const;

describe("bridge TUI config reads the local cli.json", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const directory = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-tui-config-"));
    created.push(dir);
    return dir;
  };

  test("theme and keybinds come from the user's own document", async () => {
    const dir = directory();
    writeFileSync(
      path.join(dir, "cli.json"),
      `{
        // the file the CLI itself writes is JSONC
        "$schema": "https://opencode.ai/v2/cli.json",
        "theme": { "name": "dracula", "mode": "dark" },
        "keybinds": { "app.exit": "ctrl+q" },
      }`,
    );
    const service = createBridgeTuiConfig({ directory: dir, decode, environment: {} });

    expect(service.path).toBe(path.join(dir, "cli.json"));
    const resolved = Config.resolve(await service.get(), defaults);

    expect(resolved.theme?.name).toBe("dracula");
    expect(resolved.theme?.mode).toBe("dark");
    expect(resolved.keybinds.get("app.exit").map((binding) => binding.key)).toEqual(["ctrl+q"]);
  });

  test("an absent document reads as the built-in defaults", async () => {
    const service = createBridgeTuiConfig({ directory: directory(), decode, environment: {} });

    const resolved = Config.resolve(await service.get(), defaults);

    expect(resolved.theme?.name).toBeUndefined();
    expect(resolved.keybinds.get("app.exit").map((binding) => binding.key)).toEqual(["ctrl+c,ctrl+d,<leader>q"]);
  });

  test("an invalid document is ignored rather than replacing the defaults", async () => {
    const dir = directory();
    writeFileSync(path.join(dir, "cli.json"), `{ "theme": { "mode": "blue" }, `);
    const service = createBridgeTuiConfig({ directory: dir, decode, environment: {} });

    const resolved = Config.resolve(await service.get(), defaults);

    expect(resolved.theme?.mode).toBeUndefined();
    expect(resolved.keybinds.get("app.exit").map((binding) => binding.key)).toEqual(["ctrl+c,ctrl+d,<leader>q"]);
  });

  test("the host's approval preset outranks the file", async () => {
    const dir = directory();
    writeFileSync(path.join(dir, "cli.json"), `{ "session": { "permissions": "autoaccept", "tps": false } }`);
    const service = createBridgeTuiConfig({
      directory: dir,
      decode,
      environment: {},
      overlay: { session: { permissions: "prompt" } },
    });

    const resolved = Config.resolve(await service.get(), defaults);

    expect(resolved.session.permissions).toBe("prompt");
    expect(resolved.session.tps).toBe(false);
  });

  test("the environment document merges over the file", async () => {
    const dir = directory();
    writeFileSync(path.join(dir, "cli.json"), `{ "theme": { "name": "dracula" }, "keybinds": { "app.exit": "ctrl+q" } }`);
    const service = createBridgeTuiConfig({
      directory: dir,
      decode,
      environment: { OPENCODE_CLI_CONFIG_CONTENT: `{ "theme": { "name": "nord" } }` },
    });

    const resolved = Config.resolve(await service.get(), defaults);

    expect(resolved.theme?.name).toBe("nord");
    expect(resolved.keybinds.get("app.exit").map((binding) => binding.key)).toEqual(["ctrl+q"]);
  });

  test("each read reflects the document as it is now", async () => {
    const dir = directory();
    const file = path.join(dir, "cli.json");
    writeFileSync(file, `{ "theme": { "name": "dracula" } }`);
    const service = createBridgeTuiConfig({ directory: dir, decode, environment: {} });

    expect(Config.resolve(await service.get(), defaults).theme?.name).toBe("dracula");

    writeFileSync(file, `{ "theme": { "name": "nord" } }`);

    expect(Config.resolve(await service.get(), defaults).theme?.name).toBe("nord");
  });
});
