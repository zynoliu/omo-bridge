import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { createBridgeTuiContext } from "../../src/context/bridge.ts";
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";

function build() {
  const data = new BridgeData();
  return createBridgeTuiContext(
    {
      data: data,
      defaultLocation: { directory: "/workspace" },
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
    },
    () => "ready",
  );
}

describe("bridge TUI bootstrap", () => {
  test("the context exposes an in-process adapter and never an HTTP service", () => {
    const context = build();
    expect(context.usesInProcessAdapter).toBe(true);
    expect(context.startsHttpService).toBe(false);
    expect(context.connection()).toBe("ready");
  });

  test("session creation through the context reaches the shared data view", async () => {
    const context = build();
    context.client.sessionCreate("p_boot", "Boot");
    expect(context.data.view().sessions.map((session) => session.id)).toEqual(["p_boot"]);
    expect(await context.client.sessionList()).toEqual(context.client.sessionList());
  });

  test("the context is usable inside a solid root without a renderer", () => {
    createRoot((dispose) => {
      const context = build();
      expect(context.connection()).toBe("ready");
      expect(context.client.sessionList().length).toBe(0);
      dispose();
    });
  });

  test("the context exposes a client api and a data layer that read the same host payload", async () => {
    const data = new BridgeData();
    data.upsertHostSession({
      id: "s1",
      projectID: "proj_1",
      cost: 0.1,
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      title: "Bridged",
      location: { directory: "/workspace/s1" },
    });
    const context = createBridgeTuiContext(
      {
        data: data,
        defaultLocation: { directory: "/workspace" },
        sessions: new SessionRegistry(),
        dialogs: new DialogRegistry(),
        interaction: new InteractionController(),
      },
      () => "ready",
    );
    const listed = await context.api.session.list({});
    expect(listed.data.map((session) => session.id)).toEqual(["s1"]);
    expect(context.tuiData.session.list().map((session) => session.id)).toEqual(["s1"]);
    // The TUI reads its connection state from this stream: it opens with the handshake the in-process
    // attachment already completed, so the session route renders instead of staying "reconnecting".
    const iterator = context.api.event.subscribe()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done === false ? first.value.type : "closed").toBe("server.connected");
    expect(() => context.api.session.compact({ sessionID: "s1" })).toThrow();
  });
});
