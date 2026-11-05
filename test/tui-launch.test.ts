import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_TUI_DIR, channelForStateDir, isOmoRuntimeBun, tuiBunFrom, tuiDirFrom } from "../src/tui-launch";

describe("tui launch isolation", () => {
  test("gives each bridge state directory its own channel", () => {
    const first = channelForStateDir("/tmp/bridge-a");
    const second = channelForStateDir("/tmp/bridge-b");
    expect(first).toStartWith("bridge-");
    expect(first).not.toBe(second);
    expect(first).not.toBe("dev");
    expect(channelForStateDir("/tmp/bridge-a/")).toBe(first);
    expect(channelForStateDir(join("/tmp", "bridge-a", "..", "bridge-a"))).toBe(first);
  });

  test("keeps the channel short enough for a state directory name", () => {
    const channel = channelForStateDir("/Users/someone/a very long bridge state directory name");
    expect(channel.length).toBeLessThanOrEqual(16);
    expect(/^[a-z0-9-]+$/.test(channel)).toBe(true);
  });
});

describe("tui launch inputs", () => {
  test("reads the TUI checkout from OMO_BRIDGE_TUI_DIR and falls back to the documented fork", () => {
    expect(tuiDirFrom({ OMO_BRIDGE_TUI_DIR: "/tmp/checkout" })).toBe("/tmp/checkout");
    expect(tuiDirFrom({})).toBe(DEFAULT_TUI_DIR);
  });

  test("reads the TUI bun from OMO_BRIDGE_TUI_BUN and falls back to a standalone bun on PATH", () => {
    expect(tuiBunFrom({ OMO_BRIDGE_TUI_BUN: "/opt/homebrew/bin/bun" })).toBe("/opt/homebrew/bin/bun");
    const standalone = tuiBunFrom({ PATH: "/opt/homebrew/bin:/usr/bin" });
    expect(standalone === "/opt/homebrew/bin/bun" || standalone === process.execPath).toBe(true);
    expect(tuiBunFrom({})).toBe(process.execPath);
  });

  test("never hands the TUI the OmO runtime wrapper", () => {
    expect(isOmoRuntimeBun("/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo")).toBe(true);
    expect(isOmoRuntimeBun("/Users/zyno/.omo/agent/bundled-bun/91f1db1bdaa8366e/bun")).toBe(true);
    expect(isOmoRuntimeBun("/opt/homebrew/bin/bun")).toBe(false);
    const skipped = tuiBunFrom({ PATH: "/Applications/OmO.app/bin:/opt/homebrew/bin" });
    expect(skipped === "/opt/homebrew/bin/bun" || skipped === process.execPath).toBe(true);
    expect(skipped).not.toContain("OmO.app");
  });
});
