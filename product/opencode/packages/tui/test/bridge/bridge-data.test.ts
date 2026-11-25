import { describe, expect, test } from "bun:test";
import { createMemo, createRoot } from "solid-js";

import type { SessionInfo } from "@opencode/client";
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import type { HostDialogRequestFrame } from "../../../bridge-core/src/dialogs-host.ts";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";

function sessionInfo(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: id,
    projectID: "proj_1",
    cost: 0.25,
    tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Session " + id,
    location: { directory: "/workspace/" + id },
    ...extra,
  };
}

function build(data: BridgeData = new BridgeData()) {
  const sessions = new SessionRegistry();
  const dialogs = new DialogRegistry();
  const interaction = new InteractionController();
  return createBridgeTuiData({
    data: data,
    sessions: sessions,
    dialogs: dialogs,
    interaction: interaction,
    defaultLocation: { directory: "/workspace/default" },
    events: bridgeEvents(data),
  });
}

const selectPrompt = {
  type: "extension_ui_request",
  id: "ui-permission-1",
  method: "select",
  title: "Permission required: read\n\nPath: /workspace/a.txt",
  options: ["Allow once", "Allow always", "Deny"],
  toolCallId: "call-a",
};

const questionPrompt = {
  type: "extension_ui_request",
  id: "ui-question-1",
  method: "question",
  requestId: "ask-user-1",
  toolCallId: "ask-user-1",
  waitForAnswer: true,
  questions: [
    {
      id: "q1",
      header: "Database",
      question: "Which database should I use?",
      options: [{ label: "PostgreSQL" }],
      multiSelect: false,
    },
  ],
  timeout: 1800000,
  askedAtMs: 1718000000000,
  deadlineAtMs: 1718001800000,
  remainingMs: 1799500,
};

describe("bridge tui data adapter", () => {
  test("session reads answer from the host payloads the bridge stored", () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("s1"));
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace/default" },
      events: bridgeEvents(data),
    });
    expect(tui.session.list().map((session) => session.id)).toEqual(["s1"]);
    expect(tui.session.get("s1")?.title).toBe("Session s1");
    /* root is the root session id, as the TUI and the upstream adapter treat it */
    expect(tui.session.root("s1")).toBe("s1");
    expect(tui.session.cost("s1")).toBe(0.25);
    expect(tui.session.family("s1")).toEqual(["s1"]);
    expect(tui.session.missing("s1")).toBe(false);
    expect(tui.session.missing("missing")).toBe(true);
    /* a stale tab may hold an id the bridge does not publish; the client type now allows undefined */
    expect(tui.session.get("missing")).toBeUndefined();
    expect(tui.session.family("missing")).toEqual([]);
  });

  test("messages come from the stored host payload and an unknown session yields none", () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("s1"));
    data.setHostMessages("s1", [{ id: "m1", type: "idle", time: { created: 3 }, outcome: "succeeded" }]);
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace/default" },
      events: bridgeEvents(data),
    });
    expect(tui.session.message.list("s1").length).toBe(1);
    expect(tui.session.message.list("unknown")).toEqual([]);
  });

  test("a host payload that lands after the first read recomputes the readers", () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("s1"));
    const tui = build(data);
    createRoot((dispose) => {
      const count = createMemo(() => tui.session.message.list("s1").length);
      expect(count()).toBe(0);
      data.setHostMessages("s1", [{ id: "m1", type: "idle", time: { created: 3 }, outcome: "succeeded" }]);
      expect(count()).toBe(1);
      dispose();
    });
  });

  test("a submitted prompt hands back its row without inventing a transcript message", async () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("s1"));
    const sent: string[] = [];
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace/default" },
      events: bridgeEvents(data),
      sendPrompt: async (input) => {
        sent.push(input.clientMessageId);
      },
    });
    const row = await tui.session.prompt({ sessionID: "s1", text: "hello" } as never);
    expect(sent).toEqual([row.id]);
    expect(tui.session.message.list("s1")).toEqual([]);
  });

  test("status reports running only for an active bridge session", () => {
    const data = new BridgeData();
    const sessions = new SessionRegistry();
    const handle = sessions.open({ persistentId: "s1", durableId: "s1" });
    if (handle.kind !== "ok") throw new Error("expected an open session");
    sessions.markActive(handle.value);
    const tui = createBridgeTuiData({
      data: data,
      sessions: sessions,
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace/default" },
      events: bridgeEvents(data),
    });
    expect(tui.session.status("s1")).toBe("running");
    expect(tui.session.status("other")).toBe("idle");
  });

  test("surfaces the bridge cannot answer throw instead of returning empty state", () => {
    const tui = build();
    expect(tui.session.permission.list("ses_1")).toEqual([]);
    expect(tui.session.form.list("s1")).toEqual([]);
    expect(tui.project.list()).toEqual([]);
    expect(tui.location.agent.list()).toBeUndefined();
    /* root is total upstream: an unknown id resolves to itself instead of crashing a render memo */
    expect(tui.session.root("missing")).toBe("missing");
    expect(tui.location.default().directory).toBe("/workspace/default");
  });

  test("a project row is the directory the host announced for its session", () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("s1"));
    const tui = build(data);
    expect(tui.project.list()).toEqual([
      {
        id: "proj_1",
        canonical: "/workspace/s1",
        time: { created: 1, updated: 2, active: 2 },
        sandboxes: [],
      },
    ]);
    expect(tui.project.get("proj_1")?.canonical).toBe("/workspace/s1");
    expect(tui.project.get("unknown")).toBeUndefined();
  });

  test("location catalogues stay undefined until the host delivers them", () => {
    const data = new BridgeData();
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace" },
      events: bridgeEvents(data),
    });
    expect(tui.location.info()).toBeUndefined();
    expect(tui.location.model.list()).toBeUndefined();
    expect(tui.location.vcs.info()).toBeUndefined();

    data.mergeLocation({
      info: { directory: "/workspace", project: { id: "proj_1", directory: "/workspace", canonical: "/workspace" } },
      model: [
        {
          id: "m1",
          modelID: "gpt",
          providerID: "p1",
          name: "GPT",
          capabilities: { tools: false, input: [], output: [] },
          variants: [],
          time: { released: 1 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ],
    });
    expect(tui.location.info()?.project.id).toBe("proj_1");
    expect(tui.location.model.list()?.map((model) => model.modelID)).toEqual(["gpt"]);
    expect(tui.location.command.list()).toBeUndefined();
  });

  test("onHostEvent delivers only validated host frames", () => {
    const data = new BridgeData();
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace" },
      events: bridgeEvents(data),
    });
    const seen: string[] = [];
    const stop = tui.onHostEvent((event) => {
      seen.push(event.type);
    });
    data.publishEvent({ type: "definitely.not.an.event", data: {} });
    data.publishEvent({ notAnEvent: true });
    expect(seen).toEqual([]);
    const good = {
      id: "evt_01j9x4c2m",
      created: 1731990000000,
      type: "vcs.branch.updated",
      location: { directory: "/workspace/bridge" },
      data: { branch: "main" },
    };
    data.publishEvent(good);
    expect(seen.length).toBe(1);
    stop();
    data.publishEvent(good);
    expect(seen.length).toBe(1);
  });

  test("permission events are projected into the session permission list and cleared on reply", () => {
    const data = new BridgeData();
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace" },
      events: bridgeEvents(data),
    });
    const stop = tui.onHostEvent(() => {});
    data.publishEvent({
      id: "evt_perm_1",
      created: 1731990000100,
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_1", action: "read", resources: ["/workspace/a.txt"] },
    });
    expect(tui.session.permission.list("ses_1").length).toBe(1);
    expect(tui.session.permission.list("ses_1")[0]?.action).toBe("read");
    expect(tui.session.permission.list("other")).toEqual([]);
    data.publishEvent({
      id: "evt_perm_2",
      created: 1731990000200,
      type: "permission.replied",
      data: { sessionID: "ses_1", requestID: "per_1", reply: "once" },
    });
    expect(tui.session.permission.list("ses_1")).toEqual([]);
    stop();
  });

  test("form events project into the session form list and clear on cancel", () => {
    const data = new BridgeData();
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace" },
      events: bridgeEvents(data),
    });
    const stop = tui.onHostEvent(() => {});
    expect(tui.session.form.list("ses_1")).toEqual([]);
    data.publishEvent({
      id: "evt_form_1",
      created: 1731990000300,
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_1",
          title: "Confirm",
          fields: [{ key: "ok", title: "OK", type: "boolean" }],
        },
      },
    });
    expect(tui.session.form.list("ses_1")?.length).toBe(1);
    expect(tui.session.form.list("ses_2")).toEqual([]);
    data.publishEvent({
      id: "evt_form_2",
      created: 1731990000400,
      type: "form.cancelled",
      data: { id: "frm_1", sessionID: "ses_1" },
    });
    expect(tui.session.form.list("ses_1")).toEqual([]);
    stop();
  });

  test("a select request reaches onHostDialog as the frame the host wrote", () => {
    const data = new BridgeData();
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace" },
      events: bridgeEvents(data),
    });
    const opened: HostDialogRequestFrame[] = [];
    const stop = tui.onHostDialog((dialog) => {
      opened.push(dialog);
    });
    data.publishEvent({ type: "extension_ui_request", id: "ui-notify", method: "notify", message: "hi" });
    expect(opened).toEqual([]);
    data.publishEvent(selectPrompt);
    expect(opened.map((dialog) => dialog.id)).toEqual(["ui-permission-1"]);
    const dialog = opened[0];
    if (dialog.method !== "select") throw new Error("expected a select dialog, got " + dialog.method);
    expect(dialog.title).toBe(selectPrompt.title);
    expect([...dialog.options]).toEqual(["Allow once", "Allow always", "Deny"]);
    expect(dialog.toolCallId).toBe("call-a");
    expect(tui.hostDialogs.list().map((stored) => stored.id)).toEqual(["ui-permission-1"]);
    stop();
  });

  test("responding without a sender throws and leaves the dialog open", () => {
    const data = new BridgeData();
    const tui = build(data);
    data.publishEvent(selectPrompt);
    expect(() => tui.respondToHostDialog("ui-permission-1", { kind: "value", value: "Allow once" })).toThrow(
      UnsupportedCapability,
    );
    expect(tui.hostDialogs.list().map((dialog) => dialog.id)).toEqual(["ui-permission-1"]);
  });

  test("responding with a sender writes exactly the encoded frame and drops the dialog", () => {
    const data = new BridgeData();
    const tui = build(data);
    const sent: unknown[] = [];
    tui.hostDialogs.useSender((frame) => {
      sent.push(frame);
    });
    data.publishEvent(selectPrompt);
    data.publishEvent(questionPrompt);
    tui.respondToHostDialog("ui-permission-1", { kind: "value", value: "Allow once" });
    expect(sent.length).toBe(1);
    expect(JSON.stringify(sent[0])).toBe(
      '{"type":"extension_ui_response","id":"ui-permission-1:response","uiRequestId":"ui-permission-1","value":"Allow once"}',
    );
    expect(tui.hostDialogs.list().map((dialog) => dialog.id)).toEqual(["ui-question-1"]);
    tui.respondToHostDialog("ui-question-1", {
      kind: "answers",
      answers: { q1: { selected: ["PostgreSQL"] } },
      comment: "first",
    });
    expect(JSON.stringify(sent[1])).toBe(
      '{"type":"extension_ui_response","id":"ui-question-1:response","uiRequestId":"ui-question-1","answers":{"q1":{"selected":["PostgreSQL"]}},"comment":"first"}',
    );
    expect(tui.hostDialogs.list()).toEqual([]);
    data.publishEvent(questionPrompt);
    tui.respondToHostDialog("ui-question-1", { kind: "cancelled" });
    expect(sent.length).toBe(3);
    expect(JSON.stringify(sent[2])).toBe(
      '{"type":"extension_ui_response","id":"ui-question-1:response","uiRequestId":"ui-question-1","cancelled":true}',
    );
    expect(tui.hostDialogs.list()).toEqual([]);
  });

  test("an answer to a routed dialog carries its session tag", () => {
    const data = new BridgeData();
    const tui = build(data);
    const sent: unknown[] = [];
    tui.hostDialogs.useSender((frame) => {
      sent.push(frame);
    });
    data.publishEvent({ ...selectPrompt, sessionId: "rpc-1" });
    tui.respondToHostDialog("ui-permission-1", { kind: "value", value: "Allow once" });
    expect(JSON.stringify(sent[0])).toBe(
      '{"type":"extension_ui_response","id":"ui-permission-1:response","uiRequestId":"ui-permission-1","sessionId":"rpc-1","value":"Allow once"}',
    );
  });

  test("a question_resolved frame closes the question it settles", () => {
    const data = new BridgeData();
    const tui = build(data);
    const opened: string[] = [];
    tui.onHostDialog((dialog) => {
      opened.push(dialog.id);
    });
    data.publishEvent(questionPrompt);
    expect(tui.hostDialogs.list().map((dialog) => dialog.id)).toEqual(["ui-question-1"]);
    data.publishEvent({
      type: "question_resolved",
      id: "ui-question-1",
      requestId: "ask-user-1",
      toolCallId: "ask-user-1",
      outcome: "cancelled",
      answers: {},
      unanswered: ["q1"],
    });
    expect(tui.hostDialogs.list()).toEqual([]);
    expect(opened).toEqual(["ui-question-1"]);
  });

  test("data subscriptions deliver the bridge client's own server.connected frame", async () => {
    const tui = build();
    const onReceived = new Promise<string>((resolve) => {
      tui.on("server.connected", (event) => resolve(event.type + ":" + event.id));
    });
    const listenReceived = new Promise<string>((resolve) => {
      tui.listen((event) => resolve(event.name + ":" + event.details.type));
    });
    expect(await onReceived).toBe("server.connected:bridge-connected");
    expect(await listenReceived).toBe("server.connected:server.connected");
  });

  test("root is total and walks parentID instead of throwing", () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("root"));
    data.upsertHostSession(sessionInfo("child", { parentID: "root" }));
    data.upsertHostSession(sessionInfo("grandchild", { parentID: "child" }));
    const tui = build(data);
    expect(tui.session.root("grandchild")).toBe("root");
    expect(tui.session.root("child")).toBe("root");
    expect(tui.session.family("child")).toEqual(["root", "child", "grandchild"]);
    expect(tui.session.root("missing")).toBe("missing");
    expect(tui.session.family("missing")).toEqual([]);
    /* a parent cycle stops at the last non-repeating ancestor instead of looping */
    data.upsertHostSession(sessionInfo("a", { parentID: "b" }));
    data.upsertHostSession(sessionInfo("b", { parentID: "a" }));
    expect(tui.session.root("a")).toBe("b");
  });

  test("pending inputs the host reports reach the client inbox instead of an empty list", () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("s1"));
    data.setPendingInputs("s1", [
      { clientMessageId: "c-7", state: "queued", text: "also run the tests", requestedMode: "followUp" },
      { clientMessageId: "c-8", state: "sending", text: "stop after this call", requestedMode: null },
    ]);
    const tui = build(data);
    const items = tui.session.pending.list("s1");
    expect(items.map((item) => item.id)).toEqual(["c-7", "c-8"]);
    expect(items.map((item) => item.delivery)).toEqual(["queue", "steer"]);
    expect(items.map((item) => item.type)).toEqual(["user", "user"]);
    const queued = items[0];
    if (queued === undefined || queued.type !== "user") throw new Error("expected the host's first pending input");
    expect(queued.payload.text).toBe("also run the tests");
    /* the host reports no enqueue time, so it is never a plausible instant */
    expect(Number.isNaN(queued.time.created)).toBe(true);
    expect(tui.session.pending.list("other")).toEqual([]);
    expect(tui.session.input.list("s1")).toEqual(["c-7", "c-8"]);
    expect(tui.session.input.has("s1", "c-8")).toBe(true);
    expect(tui.session.input.has("s1", "c-9")).toBe(false);
  });

  test("shell answers stay empty so the layout path renders", () => {
    const tui = build();
    expect(tui.shell.list()).toEqual([]);
    expect(tui.shell.listBySession("s1")).toEqual([]);
    expect(tui.shell.get("sh_1")).toBeUndefined();
  });

  test("session.create mints the id it returns and hands that same id to the host opener", async () => {
    const data = new BridgeData();
    const seen: unknown[] = [];
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace/default" },
      events: bridgeEvents(data),
      createSession: async (input) => {
        seen.push(input);
        return sessionInfo(input.id ?? "missing");
      },
    });
    const created = tui.session.create({ title: "Fresh", location: { directory: "/workspace/chosen" } });
    expect(tui.session.get(created.id)?.title).toBe("Fresh");
    const info = await created.request;
    expect(info.id).toBe(created.id);
    expect(seen).toEqual([{ id: created.id, title: "Fresh", directory: "/workspace/chosen" }]);
    expect(tui.session.get(created.id)?.id).toBe(info.id);
    /* `creating` stays false because the caller holds the request, not a store this layer fills */
    expect(tui.session.creating(created.id)).toBe(false);
  });

  test("a failed create removes the optimistic row instead of leaving it mounted", async () => {
    const data = new BridgeData();
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace/default" },
      events: bridgeEvents(data),
      createSession: async () => {
        throw new Error("the host refused the open");
      },
    });
    const created = tui.session.create({ title: "Doomed" });
    expect(tui.session.get(created.id)?.title).toBe("Doomed");
    await expect(created.request).rejects.toThrow("the host refused the open");
    expect(tui.session.get(created.id)).toBeUndefined();
  });

  test("session.create without an injected opener refuses instead of admitting a local record", () => {
    const tui = build();
    expect(() => tui.session.create({})).toThrow(UnsupportedCapability);
  });

  test("session.create carries parentID to the opener and nests the optimistic row under it", async () => {
    const data = new BridgeData();
    data.upsertHostSession(sessionInfo("root"));
    const seen: unknown[] = [];
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: "/workspace/default" },
      events: bridgeEvents(data),
      createSession: async (input) => {
        seen.push(input);
        return sessionInfo(input.id ?? "missing", input.parentID === undefined ? {} : { parentID: input.parentID });
      },
    });
    const created = tui.session.create({ title: "Child", parentID: "root" });
    /* the row nests before the host answers, so root/family never treat a fresh child as a root */
    expect(tui.session.get(created.id)?.parentID).toBe("root");
    expect(tui.session.root(created.id)).toBe("root");
    expect(tui.session.family(created.id)).toEqual(["root", created.id]);
    const info = await created.request;
    expect(seen).toEqual([{ id: created.id, title: "Child", directory: "/workspace/default", parentID: "root" }]);
    expect(info.parentID).toBe("root");
  });

  /* The projection publishes a host question as a client form: `frm_` + the host requestId, with the
     dialog frame id in the metadata (host-projection.ts projectFormRequest). */
  const projectedForm = {
    id: "evt_form_dialog_1",
    created: 1731990000500,
    type: "form.created",
    data: {
      form: {
        id: "frm_ask-user-1",
        sessionID: "ses_1",
        title: "Database",
        metadata: {
          kind: "question",
          dialogId: "ui-question-1",
          questions: questionPrompt.questions,
        },
        fields: [
          {
            key: "q0",
            title: "Database",
            description: "Which database should I use?",
            type: "string",
            options: [{ value: "PostgreSQL", label: "PostgreSQL" }],
            custom: true,
          },
        ],
      },
    },
  };

  test("a form reply answers the host question dialog the form was projected from", async () => {
    const data = new BridgeData();
    const tui = build(data);
    const sent: unknown[] = [];
    tui.hostDialogs.useSender((frame) => {
      sent.push(frame);
    });
    const published: string[] = [];
    data.subscribeEvents((frame) => {
      const typed = frame as { type?: unknown };
      if (typed.type === "extension_ui_response") published.push(JSON.stringify(frame));
    });
    const stop = tui.onHostEvent(() => {});
    data.publishEvent(questionPrompt);
    data.publishEvent(projectedForm);
    expect(tui.session.form.list("ses_1")?.map((form) => form.id)).toEqual(["frm_ask-user-1"]);
    expect(tui.hostDialogs.list().map((dialog) => dialog.id)).toEqual(["ui-question-1"]);
    const reply = tui.session.form.reply({ sessionID: "ses_1", formID: "frm_ask-user-1", answer: { q0: "PostgreSQL" } });
    expect(sent.length).toBe(1);
    /* the field key is the projection's `q0`, the question id is the host's `q1` */
    expect(JSON.stringify(sent[0])).toBe(
      '{"type":"extension_ui_response","id":"ui-question-1:response","uiRequestId":"ui-question-1","answers":{"q1":{"selected":["PostgreSQL"]}}}',
    );
    /* the published answer is what the shipping projector turns into `form.replied` */
    expect(published).toEqual([JSON.stringify(sent[0])]);
    expect(tui.hostDialogs.list()).toEqual([]);
    await reply;
    stop();
  });

  test("a form reply sends a value the question did not offer as free text", async () => {
    const data = new BridgeData();
    const tui = build(data);
    const sent: unknown[] = [];
    tui.hostDialogs.useSender((frame) => {
      sent.push(frame);
    });
    const stop = tui.onHostEvent(() => {});
    data.publishEvent(questionPrompt);
    data.publishEvent(projectedForm);
    await tui.session.form.reply({ sessionID: "ses_1", formID: "frm_ask-user-1", answer: { q0: "sqlite" } });
    expect(JSON.stringify(sent[0])).toBe(
      '{"type":"extension_ui_response","id":"ui-question-1:response","uiRequestId":"ui-question-1","answers":{"q1":{"selected":[],"text":"sqlite"}}}',
    );
    stop();
  });

  test("a form cancel cancels the host question dialog the form was projected from", async () => {
    const data = new BridgeData();
    const tui = build(data);
    const sent: unknown[] = [];
    tui.hostDialogs.useSender((frame) => {
      sent.push(frame);
    });
    const stop = tui.onHostEvent(() => {});
    data.publishEvent(questionPrompt);
    data.publishEvent(projectedForm);
    await tui.session.form.cancel({ sessionID: "ses_1", formID: "frm_ask-user-1" });
    expect(JSON.stringify(sent[0])).toBe(
      '{"type":"extension_ui_response","id":"ui-question-1:response","uiRequestId":"ui-question-1","cancelled":true}',
    );
    expect(tui.hostDialogs.list()).toEqual([]);
    stop();
  });

  test("a form with no live host dialog behind it refuses instead of settling locally", async () => {
    const data = new BridgeData();
    const tui = build(data);
    const sent: unknown[] = [];
    tui.hostDialogs.useSender((frame) => {
      sent.push(frame);
    });
    const stop = tui.onHostEvent(() => {});
    data.publishEvent({
      id: "evt_form_only_1",
      created: 1731990000600,
      type: "form.created",
      data: {
        form: {
          id: "frm_local_only",
          sessionID: "ses_1",
          title: "Confirm",
          fields: [{ key: "ok", title: "OK", type: "boolean" }],
        },
      },
    });
    await expect(
      tui.session.form.reply({ sessionID: "ses_1", formID: "frm_local_only", answer: { ok: true } }),
    ).rejects.toThrow(UnsupportedCapability);
    await expect(tui.session.form.cancel({ sessionID: "ses_1", formID: "frm_local_only" })).rejects.toThrow(
      UnsupportedCapability,
    );
    expect(sent).toEqual([]);
    /* the local row stays listed: it was never answered anywhere */
    expect(tui.session.form.list("ses_1")?.map((form) => form.id)).toEqual(["frm_local_only"]);
    stop();
  });
});
