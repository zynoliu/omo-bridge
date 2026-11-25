import { describe, expect, test } from "bun:test";

import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import type { PermissionRule } from "../../../bridge-core/src/permission-rules.ts";
import { SessionPermissionRules } from "../../../bridge-core/src/permission-rules.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import type { HostDialogRequestFrame } from "../../../bridge-core/src/dialogs-host.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";

type Frame = Record<string, unknown>;

/* The dialog the official host wrote for a gated tool call on 2026-11-24 (bridge-host-official:5.1.75). */
function permissionDialog(id: string, title: string, toolCallId: string): Frame {
  return {
    type: "extension_ui_request",
    id: id,
    method: "select",
    title: title,
    options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
    toolCallId: toolCallId,
    sessionId: "rpc-1",
  };
}

function feedbackDialog(id: string, toolCallId: string): Frame {
  return {
    type: "extension_ui_request",
    id: id,
    method: "input",
    title: "Feedback",
    toolCallId: toolCallId,
    sessionId: "rpc-1",
  };
}

function build(rules: SessionPermissionRules | undefined) {
  const data = new BridgeData();
  /* The dialog tags the routing handle; the rules are keyed by the durable id the client names. */
  data.rememberRoutingId("ses_durable", "rpc-1");
  const answers: Frame[] = [];
  const surfaced: HostDialogRequestFrame[] = [];
  const tui = createBridgeTuiData({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace" },
    events: bridgeEvents(data),
    permissionRules: rules,
  });
  tui.hostDialogs.useSender((frame) => answers.push(frame as unknown as Frame));
  tui.onHostDialog((dialog) => surfaced.push(dialog));
  return { data: data, tui: tui, answers: answers, surfaced: surfaced };
}

const READ_TITLE = "Permission required: read\n\nPath: /work/a.txt";

describe("session permission rules answer the host's ask", () => {
  test("an allow rule answers immediately: the host asked, no dialog reached a person", () => {
    const rules = new SessionPermissionRules();
    rules.set("ses_durable", [{ action: "read", resource: "*", effect: "allow" }]);
    const built = build(rules);
    built.data.publishEvent(permissionDialog("ui-1", READ_TITLE, "call-1"));
    expect(built.surfaced.length).toBe(0);
    expect(built.answers.length).toBe(1);
    expect(built.answers[0]?.type).toBe("extension_ui_response");
    expect(built.answers[0]?.["value"]).toBe("Allow once");
    expect(built.answers[0]?.["uiRequestId"]).toBe("ui-1");
    expect(built.answers[0]?.["sessionId"]).toBe("rpc-1");
  });

  test("a deny rule with a reason refuses through the feedback dialog the model reads", () => {
    const rules = new SessionPermissionRules();
    const deny: readonly PermissionRule[] = [
      { action: "eval", resource: "*", effect: "deny", reason: "eval is off-limits in this session" },
    ];
    rules.set("ses_durable", deny);
    const built = build(rules);
    built.data.publishEvent(permissionDialog("ui-2", "Permission required: eval\n\nTool: eval", "call-2"));
    expect(built.surfaced.length).toBe(0);
    expect(built.answers.length).toBe(1);
    expect(built.answers[0]?.["value"]).toBe("Deny with feedback");
    built.data.publishEvent(feedbackDialog("ui-2-feedback", "call-2"));
    expect(built.answers.length).toBe(2);
    expect(built.answers[1]?.["value"]).toBe("eval is off-limits in this session");
    expect(built.surfaced.length).toBe(0);
  });

  test("an ask rule surfaces exactly one dialog and answers nothing", () => {
    const rules = new SessionPermissionRules();
    rules.set("ses_durable", [{ action: "*", resource: "*", effect: "ask" }]);
    const built = build(rules);
    built.data.publishEvent(permissionDialog("ui-3", READ_TITLE, "call-3"));
    expect(built.surfaced.length).toBe(1);
    expect(built.surfaced[0]?.id).toBe("ui-3");
    expect(built.answers.length).toBe(0);
  });

  test("a session with no rule behaves exactly as before: the dialog is surfaced", () => {
    const built = build(new SessionPermissionRules());
    built.data.publishEvent(permissionDialog("ui-4", READ_TITLE, "call-4"));
    expect(built.surfaced.length).toBe(1);
    expect(built.answers.length).toBe(0);
  });

  test("a rule cannot answer a dialog whose options cannot carry the decision", () => {
    const rules = new SessionPermissionRules();
    rules.set("ses_durable", [{ action: "read", resource: "*", effect: "allow" }]);
    const built = build(rules);
    built.data.publishEvent({
      type: "extension_ui_request",
      id: "ui-5",
      method: "select",
      title: READ_TITLE,
      options: ["Deny"],
      sessionId: "rpc-1",
    });
    expect(built.surfaced.length).toBe(1);
    expect(built.answers.length).toBe(0);
  });
});

describe("the permission surface the TUI reads", () => {
  test("rules are reported on the session row and through the permission namespace", () => {
    const rules = new SessionPermissionRules();
    const built = build(rules);
    built.data.upsertHostSession({
      id: "ses_1",
      projectID: "proj_1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      location: { directory: "/workspace" },
    });
    rules.set("ses_1", [{ action: "*", resource: "*", effect: "allow" }]);
    expect(built.tui.session.permission.rules("ses_1")).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    expect(built.tui.session.permission.rules("ses_other")).toEqual([]);
    expect(built.tui.session.get("ses_1")?.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
    /* A pull replaces the row with the host payload; the bridge's own rules must survive it. */
    built.data.upsertHostSession(built.data.hostSession("ses_1") as never);
    expect(built.tui.session.get("ses_1")?.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  });

  test("the reply member answers the live dialog the projected request id names", async () => {
    const built = build(new SessionPermissionRules());
    built.data.publishEvent(permissionDialog("ui-6", READ_TITLE, "call-6"));
    expect(built.surfaced.length).toBe(1);
    await built.tui.session.permission.reply({ sessionID: "ses_durable", requestID: "per_ui-6", decision: "once" });
    expect(built.answers.length).toBe(1);
    expect(built.answers[0]?.["value"]).toBe("Allow once");
    expect(built.data.permissionsFor("ses_durable").length).toBe(0);
  });

  test("a reply for a request with no live dialog refuses instead of reporting an answer", async () => {
    const built = build(new SessionPermissionRules());
    let thrown: unknown;
    try {
      await built.tui.session.permission.reply({ sessionID: "ses_durable", requestID: "per_gone", decision: "once" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCapability);
    expect(built.answers.length).toBe(0);
  });
});

describe("the session.permissions client event", () => {
  const allowRead: PermissionRule = { action: "read", resource: "/work/*", effect: "allow" };
  const denyEval: PermissionRule = { action: "eval", resource: "*", effect: "deny", reason: "eval is off-limits" };

  function observed(rules: SessionPermissionRules) {
    const data = new BridgeData();
    const events: Record<string, unknown>[] = [];
    data.subscribeClientEvents((event) => events.push(event as Record<string, unknown>));
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace" },
      events: bridgeEvents(data),
      permissionRules: rules,
    });
    return { data: data, tui: tui, events: events };
  }

  test("the document is published when the TUI loads it", () => {
    const built = observed(new SessionPermissionRules({ version: 1, sessions: { ses_load: [allowRead] } }));
    expect(built.events.length).toBe(1);
    expect(built.events[0]?.["type"]).toBe("session.permissions");
    expect(built.events[0]?.["data"]).toEqual({ sessionID: "ses_load", permissions: [allowRead] });
    expect(built.events[0]?.["durable"]).toEqual({ aggregateID: "ses_load", seq: expect.any(Number), version: 1 });
    expect(String(built.events[0]?.["id"])).toMatch(/^evt_/);
  });

  test("an edit is published with the rules the row now reports", () => {
    const rules = new SessionPermissionRules();
    const built = observed(rules);
    expect(built.events.length).toBe(0);
    built.data.upsertHostSession({
      id: "ses_edit",
      projectID: "proj_1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      location: { directory: "/workspace/edit" },
    });
    rules.set("ses_edit", [denyEval]);
    expect(built.events.length).toBe(1);
    expect(built.events[0]?.["data"]).toEqual({ sessionID: "ses_edit", permissions: [denyEval] });
    expect(built.events[0]?.["location"]).toEqual({ directory: "/workspace/edit" });
    expect(built.tui.session.get("ses_edit")?.permissions).toEqual([denyEval]);
  });

  test("re-reporting the same rules publishes nothing", () => {
    const rules = new SessionPermissionRules();
    const built = observed(rules);
    rules.set("ses_same", [allowRead]);
    expect(built.events.length).toBe(1);
    built.data.setSessionPermissionRules("ses_same", [{ action: "read", resource: "/work/*", effect: "allow" }]);
    expect(built.events.length).toBe(1);
  });

  test("clearing the rules publishes the empty set", () => {
    const rules = new SessionPermissionRules();
    const built = observed(rules);
    rules.set("ses_clear", [allowRead]);
    rules.set("ses_clear", []);
    expect(built.events.length).toBe(2);
    expect(built.events[1]?.["data"]).toEqual({ sessionID: "ses_clear", permissions: [] });
    expect(built.tui.session.get("ses_clear")?.permissions).toBeUndefined();
  });
});
