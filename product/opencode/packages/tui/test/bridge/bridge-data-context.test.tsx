import { describe, expect, test } from "bun:test";
import { createRoot, createComponent } from "solid-js";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeDataContext, useBridgeData } from "../../src/context/bridge-data-context.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";

function build() {
  const data = new BridgeData();
  data.upsertHostSession({
    id: "s1",
    projectID: "proj_1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "One",
    location: { directory: "/workspace/s1" },
  });
  return createBridgeTuiData({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace" },
    events: bridgeEvents(data),
  });
}

describe("bridge data context", () => {
  test("useBridgeData throws outside the provider", () => {
    createRoot((dispose) => {
      expect(() => useBridgeData()).toThrow();
      dispose();
    });
  });

  test("useBridgeData reads the provided adapter inside the provider", () => {
    const tui = build();
    createRoot((dispose) => {
      bridgeDataContext.Provider({
        value: tui,
        get children() {
          return createComponent(() => {
            expect(useBridgeData().session.list().map((session) => session.id)).toEqual(["s1"]);
            return null;
          }, {});
        },
      });
      dispose();
    });
  });
});
