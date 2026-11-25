import { describe, expect, test } from "bun:test";

import { BridgeClient, UnsupportedCapability } from "../src/client.ts";
import { BridgeData } from "../src/data.ts";
import { DialogRegistry } from "../src/dialogs.ts";
import { InteractionController } from "../src/interaction.ts";
import { SessionRegistry } from "../src/sessions.ts";

function build() {
  const data = new BridgeData();
  const sessions = new SessionRegistry();
  const dialogs = new DialogRegistry();
  const interaction = new InteractionController();
  const client = new BridgeClient({ data: data, sessions: sessions, dialogs: dialogs, interaction: interaction });
  return { data, sessions, dialogs, interaction, client };
}

describe("BridgeClient and BridgeData", () => {
  test("a client request and an event update the same view", () => {
    const { data, client } = build();
    client.sessionCreate("p_one", "First");
    data.applyEvent({ kind: "session.created", sessionId: "p_one", title: "Renamed by host" });
    const view = data.view();
    expect(view.sessions.length).toBe(1);
    expect(view.sessions[0]?.title).toBe("Renamed by host");
    expect(client.sessionList().length).toBe(1);
  });

  test("an event projects into the message view the client exposes", () => {
    const { data } = build();
    data.applyEvent({ kind: "partial", sequence: 0, text: "hi" });
    data.applyEvent({ kind: "message_end", sequence: 1, text: "hi" });
    const view = data.view();
    expect(view.message.text).toBe("hi");
    expect(view.message.status).toBe("complete");
  });

  test("selecting an unknown session is refused without changing the view", () => {
    const { data, client } = build();
    client.sessionCreate("p_one", "First");
    expect(client.sessionSelect("p_missing")).toBe(false);
    expect(data.view().selected).toBe("p_one");
  });

  test("input submission goes through the interaction controller", () => {
    const { interaction, client } = build();
    const turn = interaction.startTurn();
    const result = client.inputSubmit("steer", turn, "note");
    expect(result.kind).toBe("accepted");
    expect(interaction.pendingQueue().length).toBe(1);
  });

  test("an unimplemented capability raises a typed error instead of a fake success", () => {
    const { client } = build();
    expect(() => client.capability("mcp.registerServer")).toThrow(UnsupportedCapability);
    try {
      client.capability("mcp.registerServer");
    } catch (error) {
      expect(error instanceof UnsupportedCapability).toBe(true);
      if (error instanceof UnsupportedCapability) expect(error.capability).toBe("mcp.registerServer");
    }
  });

describe("createInProcessClient", () => {
  test("serves the TUI session surface without any network call", async () => {
    const { createInProcessClient } = await import("../src/in-process-client.ts");
    const data = new BridgeData();
    const sessions = new SessionRegistry();
    const client = new BridgeClient({ data, sessions, dialogs: new DialogRegistry(), interaction: new InteractionController() });
    const inProcess = createInProcessClient({ client, data });

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error("network must not be used");
    }) as typeof fetch;
    try {
      const created = await inProcess.session.create({ id: "p_tui", title: "TUI" });
      const listed = await inProcess.session.list();
      expect(created.id).toBe("p_tui");
      expect(listed.length).toBe(1);
      expect(fetchCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("event subscription can be removed", async () => {
    const { createInProcessClient } = await import("../src/in-process-client.ts");
    const data = new BridgeData();
    const client = new BridgeClient({ data, sessions: new SessionRegistry(), dialogs: new DialogRegistry(), interaction: new InteractionController() });
    const inProcess = createInProcessClient({ client, data });
    const seen: string[] = [];
    const off = inProcess.event.subscribe((event) => seen.push(event.kind));
    off();
    expect(seen.length).toBe(0);
  });
});
});
