import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ConfigError } from "../../src/bridge/features/config/state.ts";
import { LocalSettings } from "../../src/bridge/features/config/local.ts";

const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-settings-"));
  roots.push(dir);
  return dir;
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("LocalSettings", () => {
  test("an absent settings file reads as empty", () => {
    expect(new LocalSettings({ root: root(), allowedKeys: ["theme"] }).read()).toEqual({});
  });

  test("an allowed key round trips through the file", () => {
    const settings = new LocalSettings({ root: root(), allowedKeys: ["theme"] });
    settings.write("theme", "dark", { authorized: true });
    expect(settings.read()).toEqual({ theme: "dark" });
    expect(fs.existsSync(settings.file())).toBe(true);
  });

  test("a key outside the allowlist is refused and nothing is written", () => {
    const settings = new LocalSettings({ root: root(), allowedKeys: ["theme"] });
    expect(() => settings.write("apiKey", "x", { authorized: true })).toThrow(ConfigError);
    expect(fs.existsSync(settings.file())).toBe(false);
  });

  test("an unauthorised write is refused", () => {
    const settings = new LocalSettings({ root: root(), allowedKeys: ["theme"] });
    expect(() => settings.write("theme", "dark", { authorized: false })).toThrow(ConfigError);
  });

  test("a symlinked root is rejected", () => {
    const real = root();
    const link = path.join(os.tmpdir(), "bridge-settings-link-" + String(process.pid));
    fs.symlinkSync(real, link);
    try {
      expect(() => new LocalSettings({ root: link, allowedKeys: ["theme"] })).toThrow(ConfigError);
    } finally {
      fs.unlinkSync(link);
    }
  });
});
