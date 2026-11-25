import { describe, expect, test } from "bun:test";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { BridgeEntryUsageError, createBridgeEntry, parseBridgeArgs } from "../../../cli/src/bridge-entry.ts";
import { createBridgeTuiContext } from "../../../tui/src/context/bridge.ts";

describe("bridge entry", () => {
  test("requires an explicit socket and never invents an OpenCode service", () => {
    expect(() => parseBridgeArgs([])).toThrow(BridgeEntryUsageError);
    const options = parseBridgeArgs(["--socket", "/tmp/bridge-test.sock", "--mini"]);
    expect(options.socket).toBe("/tmp/bridge-test.sock");
    expect(options.mini).toBe(true);
  });

  test("rejects an unknown argument instead of ignoring it", () => {
    expect(() => parseBridgeArgs(["--socket", "/tmp/x.sock", "--http"])).toThrow(BridgeEntryUsageError);
  });

  test("state moves idle to connecting to ready", async () => {
    const seen: string[] = [];
    const entry = createBridgeEntry({ socket: "/tmp/x.sock", mini: false }, async (socket) => {
      seen.push(socket);
    });
    expect(entry.state()).toBe("idle");
    const pending = entry.connect();
    expect(entry.state()).toBe("connecting");
    expect(await pending).toBe("ready");
    expect(seen).toEqual(["/tmp/x.sock"]);
    expect(entry.error()).toBeNull();
  });

  test("a failed connection is visible and does not report ready", async () => {
    const entry = createBridgeEntry({ socket: "/tmp/missing.sock", mini: false }, async () => {
      throw new Error("connect ENOENT");
    });
    expect(await entry.connect()).toBe("failed");
    expect(entry.state()).toBe("failed");
    expect(entry.error()).toContain("ENOENT");
  });

  test("close is terminal", async () => {
    const entry = createBridgeEntry({ socket: "/tmp/x.sock", mini: false }, async () => {});
    await entry.connect();
    entry.close();
    expect(entry.state()).toBe("closed");
  });

  test("the bridge context reports an in-process adapter and no HTTP service", () => {
    const deps = {
      data: new BridgeData(),
      defaultLocation: { directory: "/workspace" },
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
    };
    const context = createBridgeTuiContext(deps, () => "ready");
    expect(context.usesInProcessAdapter).toBe(true);
    expect(context.startsHttpService).toBe(false);
    expect(context.connection()).toBe("ready");
    expect(context.client.sessionList()).toEqual([]);
  });
});
