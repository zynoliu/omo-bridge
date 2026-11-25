import { describe, expect, test } from "bun:test";

import type { MessageChannel } from "../../../client/src/message-channel.ts";
import { MessageChannelRefused } from "../../../client/src/message-channel.ts";
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";

function build(channel: Partial<MessageChannel> = {}) {
  const data = new BridgeData();
  return createBridgeTuiData({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace" },
    events: bridgeEvents(data),
    ...(channel.edit === undefined ? {} : { editMessage: channel.edit }),
    ...(channel.editAssistantMessage === undefined ? {} : { editAssistantMessage: channel.editAssistantMessage }),
    ...(channel.continueFromLeaf === undefined ? {} : { continueFromLeaf: channel.continueFromLeaf }),
  });
}

describe("client message channel members", () => {
  test("edit reaches the injected host member with the row id the transcript carries", async () => {
    const calls: unknown[] = [];
    const tui = build({
      edit: async (input) => {
        calls.push(input);
        return { outcome: "edited", leafID: "u4", entryID: "u4" };
      },
    });
    const outcome = await tui.session.message.edit({ sessionID: "ses_1", messageID: "msg_1", text: "again" });
    expect(outcome).toEqual({ outcome: "edited", leafID: "u4", entryID: "u4" });
    expect(calls).toEqual([{ sessionID: "ses_1", messageID: "msg_1", text: "again" }]);
  });

  test("editAssistantMessage reaches the injected host member with the row id the transcript carries", async () => {
    const calls: unknown[] = [];
    const tui = build({
      editAssistantMessage: async (input) => {
        calls.push(input);
        return { outcome: "edited", leafID: "a2", entryID: "a2" };
      },
    });
    const outcome = await tui.session.message.editAssistantMessage({
      sessionID: "ses_1",
      messageID: "msg_2",
      text: "corrected answer",
      expectedLeafID: "a1",
    });
    expect(outcome).toEqual({ outcome: "edited", leafID: "a2", entryID: "a2" });
    expect(calls).toEqual([
      { sessionID: "ses_1", messageID: "msg_2", text: "corrected answer", expectedLeafID: "a1" },
    ]);
  });

  test("without a host member editAssistantMessage refuses instead of reporting a write that never left", async () => {
    const tui = build();
    let thrown: unknown;
    try {
      await tui.session.message.editAssistantMessage({ sessionID: "ses_1", messageID: "msg_2", text: "x" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCapability);
    expect((thrown as UnsupportedCapability).capability).toBe("session.message.editAssistantMessage");
  });

  test("continueFromLeaf reaches the injected host member", async () => {
    const calls: unknown[] = [];
    const tui = build({
      continueFromLeaf: async (input) => {
        calls.push(input);
      },
    });
    await tui.session.message.continueFromLeaf({ sessionID: "ses_1" });
    expect(calls).toEqual([{ sessionID: "ses_1" }]);
  });

  test("a host refusal arrives typed, with the host's own code", async () => {
    const tui = build({
      edit: async () => {
        throw new MessageChannelRefused("leaf_not_assistant", "the conversation ends on a user message");
      },
    });
    let thrown: unknown;
    try {
      await tui.session.message.edit({ sessionID: "ses_1", messageID: "msg_1", text: "again" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MessageChannelRefused);
    expect((thrown as MessageChannelRefused).code).toBe("leaf_not_assistant");
  });

  test("without a host member the data layer refuses instead of reporting a write that never left", async () => {
    const tui = build();
    for (const call of [
      () => tui.session.message.edit({ sessionID: "ses_1", messageID: "msg_1", text: "again" }),
      () => tui.session.message.continueFromLeaf({ sessionID: "ses_1" }),
    ]) {
      let thrown: unknown;
      try {
        await call();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UnsupportedCapability);
    }
  });
});
