import { describe, expect, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { DataProvider, useData } from "../../src/context/data.tsx";
import { bridgeEvents } from "../fixture/bridge-events.ts";

function bridge() {
  const data = new BridgeData();
  data.upsertHostSession({
    id: "s1",
    projectID: "proj_1",
    cost: 0.5,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Bridged",
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

describe("data provider in bridge mode", () => {
  test("a supplied bridge layer is returned verbatim instead of building a client data layer", () => {
    const tui = bridge();
    createRoot((dispose) => {
      DataProvider({
        directory: "/workspace",
        bridge: tui,
        get children() {
          return createComponent(() => {
            expect(useData()).toBe(tui);
            expect(useData().session.list().map((session) => session.title)).toEqual(["Bridged"]);
            return null;
          }, {});
        },
      });
      dispose();
    });
  });
});
