import { describe, expect, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { createBridgeClientGroups } from "../../../bridge-core/src/bridge-opencode-client.ts";
import { createEventSurface } from "../../../bridge-core/src/event-surface.ts";
import { createPartSurface } from "../../../bridge-core/src/part-surface.ts";
import { createSessionSurface } from "../../../bridge-core/src/opencode-surface.ts";
import { bridgeClientContext, useBridgeClient } from "../../src/context/bridge-client.ts";

describe("bridge client context", () => {
  test("useBridgeClient throws outside the provider", () => {
    createRoot((dispose) => {
      expect(() => useBridgeClient()).toThrow();
      dispose();
    });
  });

  test("useBridgeClient returns the provided groups inside the provider", async () => {
    const data = new BridgeData();
    data.upsertSession({ id: "s1", title: "One", messages: 0 });
    const groups = createBridgeClientGroups({
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });

    const seen: string[][] = [];
    createRoot((dispose) => {
      bridgeClientContext.Provider({
        value: groups,
        get children() {
          return createComponent(() => {
            seen.push(useBridgeClient().session ? ["has-session-group"] : []);
            return null;
          }, {});
        },
      });
      dispose();
    });
    expect(seen).toEqual([["has-session-group"]]);
  });
});
