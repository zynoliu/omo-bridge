import { describe, expect, test } from "bun:test";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { createOtherStore, connectBridgeOther } from "../../src/bridge/features/other/store.ts";
import { decodeCodeMode, UNAVAILABLE_REASON } from "../../src/bridge/features/other/state.ts";

function wired() {
  const data = new BridgeData();
  const store = createOtherStore();
  const stop = connectBridgeOther(store, data);
  return { data: data, store: store, stop: stop };
}

describe("low-frequency native surfaces", () => {
  test("a wake_source_state event fills the CodeMode surface only", () => {
    const context = wired();
    context.data.publishEvent({
      type: "extension_event",
      name: "wake_source_state",
      data: { source: "senpi-codemode", activeCount: 1, items: [{ id: "cell_1", description: "Read the input files", startedAtMs: 1720000000000 }] },
    });
    const state = context.store.state();
    expect(state.codeMode.kind).toBe("reported");
    if (state.codeMode.kind === "reported") {
      expect(state.codeMode.value.activeCount).toBe(1);
      expect(state.codeMode.value.items[0]?.description).toBe("Read the input files");
    }
    expect(state.boulder.kind).toBe("unavailable");
    context.stop();
  });

  test("a boulder status entry fills the boulder surface and a clear makes it unavailable again", () => {
    const context = wired();
    context.data.publishEvent({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "boulder", statusText: "boulder: 3/8" });
    const reported = context.store.state().boulder;
    expect(reported.kind).toBe("reported");
    if (reported.kind === "reported") expect(reported.value).toBe("boulder: 3/8");
    context.data.publishEvent({ type: "extension_ui_request", id: "2", method: "setStatus", statusKey: "boulder" });
    expect(context.store.state().boulder.kind).toBe("unavailable");
    context.stop();
  });

  test("a non-boulder status entry is ignored rather than shown as boulder state", () => {
    const context = wired();
    context.data.publishEvent({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "memory", statusText: "3 steps" });
    expect(context.store.state().boulder.kind).toBe("unavailable");
    context.stop();
  });

  test("a malformed wake_source_state payload is reported and adds no row", () => {
    const context = wired();
    context.data.publishEvent({ type: "extension_event", name: "wake_source_state", data: { activeCount: 2 } });
    expect(context.store.state().codeMode.kind).toBe("unavailable");
    expect(context.store.notices()).toHaveLength(1);
    context.stop();
  });

  test("surfaces the host never publishes stay unavailable with the documented reason", () => {
    const state = createOtherStore().state();
    for (const surface of [state.terminalMonitor, state.lspText, state.computerUse, state.searchWidget, state.brand]) {
      expect(surface.kind).toBe("unavailable");
      if (surface.kind === "unavailable") expect(surface.reason).toBe(UNAVAILABLE_REASON);
    }
  });

  test("the codemode decoder refuses a negative count or a non-string item id", () => {
    expect(decodeCodeMode({ source: "s", activeCount: -1 })).toBeUndefined();
    expect(decodeCodeMode({ source: "s", activeCount: 1, items: [{ description: "x" }] })).toBeUndefined();
    expect(decodeCodeMode({ activeCount: 1 })).toBeUndefined();
  });
});
