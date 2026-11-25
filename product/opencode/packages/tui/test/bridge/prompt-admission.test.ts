import { describe, expect, test } from "bun:test";

import { createBridgeTuiContext } from "../../src/context/bridge.ts";
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import type { BridgePromptSubmission } from "../../src/context/bridge-data.ts";
import { AGENT_REQUEST_MARKER } from "../../../bridge-core/src/prompt-input.ts";

function build(sendPrompt?: (input: BridgePromptSubmission) => Promise<void>) {
  return createBridgeTuiContext(
    {
      data: new BridgeData(),
      defaultLocation: { directory: "/workspace" },
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      sendPrompt: sendPrompt,
    },
    () => "ready",
  );
}

describe("bridge prompt admission", () => {
  test("a prompt without an injected sender refuses instead of reporting a submission", async () => {
    const context = build();
    let thrown: unknown;
    try {
      await context.tuiData.session.prompt({ sessionID: "s1", text: "hello" } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCapability);
    expect((thrown as Error).message).toContain("session.prompt");
  });

  test("the row handed back carries the id the host was given, not a separate one", async () => {
    const sent: BridgePromptSubmission[] = [];
    const context = build(async (input) => {
      sent.push(input);
    });
    const row = await context.tuiData.session.prompt({ sessionID: "s1", text: "hello" } as never);
    expect(sent.length).toBe(1);
    expect(sent[0]?.sessionID).toBe("s1");
    expect(sent[0]?.text).toBe("hello");
    expect(row.id).toBe(sent[0]?.clientMessageId as never);
    expect(row.sessionID).toBe("s1" as never);
    expect(row.type).toBe("user");
    expect(row.payload.text).toBe("hello");
  });

  test("a steer delivery is forwarded as the streaming behavior the host documents", async () => {
    const sent: BridgePromptSubmission[] = [];
    const context = build(async (input) => {
      sent.push(input);
    });
    const row = await context.tuiData.session.prompt({ sessionID: "s1", text: "go", delivery: "steer" } as never);
    expect(sent[0]?.delivery).toBe("steer");
    expect(row.delivery).toBe("steer");
  });

  test("a refused submission rejects and hands back no row", async () => {
    const context = build(async () => {
      throw new Error("host refused the prompt");
    });
    let thrown: unknown;
    try {
      await context.tuiData.session.prompt({ sessionID: "s1", text: "hello" } as never);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toContain("host refused the prompt");
  });

  test("the setup gate is awaited before anything is sent", async () => {
    const order: string[] = [];
    const context = build(async () => {
      order.push("sent");
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = context.tuiData.session.prompt({ sessionID: "s1", text: "hello", gate: gate } as never);
    await Promise.resolve();
    expect(order).toEqual([]);
    release();
    await pending;
    expect(order).toEqual(["sent"]);
  });

  test("a prompt that names an agent carries the request as an instruction and records it", async () => {
    const sent: BridgePromptSubmission[] = [];
    const context = build(async (input) => {
      sent.push(input);
    });
    let gateAwaited = false;
    const gate = {
      then: (resolve: (value?: unknown) => void) => {
        gateAwaited = true;
        resolve(undefined);
      },
    } as unknown as Promise<unknown>;
    const row = await context.tuiData.session.prompt({
      sessionID: "s1",
      text: "hello",
      agents: [{ name: "review" }],
      gate: gate,
    } as never);
    expect(gateAwaited).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0]?.text.startsWith(AGENT_REQUEST_MARKER)).toBe(true);
    expect(sent[0]?.text).toContain('"review"');
    expect(sent[0]?.text.endsWith("\n\nhello")).toBe(true);
    expect(sent[0]?.agentRequest).toEqual({ requested: ["review"] });
    expect(context.tuiData.session.agentRequest("s1")?.requested).toEqual(["review"]);
    expect(context.tuiData.session.agentRequest("s1")?.carrier).toBe("prompt-prefix");
    expect(context.tuiData.session.agentRequest("s1")?.hostField).toBe(false);
    expect(row.payload.text).toBe("hello");
  });
});
