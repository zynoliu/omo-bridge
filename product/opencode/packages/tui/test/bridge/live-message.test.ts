import { describe, expect, test } from "bun:test";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";

const SESSION = "persistent-1";

function build() {
  const data = new BridgeData();
  const sessions = new SessionRegistry();
  const tui = createBridgeTuiData({
    data: data,
    sessions: sessions,
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace/default" },
    events: bridgeEvents(data),
  });
  const opened = sessions.open({ persistentId: SESSION, durableId: "durable-1" });
  if (opened.kind !== "ok") throw new Error("the fixture session could not be opened");
  return { data: data, sessions: sessions, handle: opened.value, tui: tui };
}

describe("live assistant overlay", () => {
  test("a streaming turn shows its reasoning, text and running tool before the host pulls them", () => {
    const fixture = build();
    fixture.sessions.markActive(fixture.handle);
    const partial: Record<string, unknown> = { kind: "partial", text: "working on it", thinking: "considering the file" };
    const toolCall: Record<string, unknown> = { kind: "tool_call", callId: "call-1", arguments: '{"command":"cat probe.txt"}' };
    fixture.data.applyEvent(partial);
    fixture.data.applyEvent(toolCall);

    const rows = fixture.tui.session.message.list(SESSION);
    expect(rows).toHaveLength(1);
    const live = rows[0];
    expect(live?.type).toBe("assistant");
    if (live === undefined || live.type !== "assistant") throw new Error("the live row was not an assistant message");
    const kinds = live.content.map((part) => part.type);
    expect(kinds).toEqual(["reasoning", "text", "tool"]);
    const tool = live.content.find((part) => part.type === "tool");
    expect(tool?.type === "tool" ? tool.state.status : undefined).toBe("running");
    expect(live.time.completed).toBeUndefined();
  });

  test("a scheduled retry shows as a notice and clears when the retry ends", () => {
    const fixture = build();
    fixture.sessions.markActive(fixture.handle);
    const start: Record<string, unknown> = { kind: "auto_retry_start" };
    fixture.data.applyEvent(start);
    const rows = fixture.tui.session.message.list(SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("system");
    const end: Record<string, unknown> = { kind: "auto_retry_end" };
    fixture.data.applyEvent(end);
    expect(fixture.tui.session.message.list(SESSION)).toEqual([]);
  });

  test("an idle turn adds nothing, and neither does a session this process marks idle", () => {
    const fixture = build();
    fixture.sessions.markActive(fixture.handle);
    fixture.data.applyEvent({ kind: "partial", text: "done" });
    fixture.data.applyEvent({ kind: "agent_idle" });
    expect(fixture.tui.session.message.list(SESSION)).toEqual([]);

    fixture.sessions.markIdle(fixture.handle);
    fixture.data.applyEvent({ kind: "partial", text: "streaming again" });
    expect(fixture.tui.session.message.list(SESSION)).toEqual([]);
  });
});
