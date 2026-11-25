import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import type { HostResponseFrame } from "../../../bridge-core/src/host-frames.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";
import { createDialogsStore, Dialogs } from "../../src/bridge/features/dialogs/index.ts";
import type { DialogsStore } from "../../src/bridge/features/dialogs/index.ts";
import { ConfigProvider } from "../../src/config";
import { ThemeProvider } from "../../src/context/theme";
import { emptyThemeSource } from "../fixture/fixture";
import { TestTuiContexts } from "../fixture/tui-environment";
import { createTuiResolvedConfig } from "../fixture/tui-runtime";

type Mounted = Awaited<ReturnType<typeof testRender>>;

let mounted: Mounted | undefined;

afterEach(() => {
  mounted?.renderer.destroy();
  mounted = undefined;
});

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
      options: [{ label: "PostgreSQL", description: "The primary store" }, { label: "SQLite" }],
      multiSelect: false,
    },
  ],
  timeout: 1800000,
  askedAtMs: 1718000000000,
  deadlineAtMs: 1718001800000,
  remainingMs: 1799500,
};

const confirmPrompt = {
  type: "extension_ui_request",
  id: "ui-confirm-1",
  method: "confirm",
  title: "Delete the build directory?",
  message: "This removes /workspace/build and everything in it.",
  timeout: 60000,
};

const inputPrompt = {
  type: "extension_ui_request",
  id: "ui-input-1",
  method: "input",
  title: "Branch name",
  placeholder: "feature/<name>",
  deadlineAtMs: 1718001800000,
  timeout: 120000,
};

const secretPrompt = {
  type: "extension_ui_request",
  id: "ui-input-secret-1",
  method: "input",
  title: "Registry token",
  secret: true,
};

const editorPrompt = {
  type: "extension_ui_request",
  id: "ui-editor-1",
  method: "editor",
  title: "Commit message",
  prefill: "feat(tui): surface host dialogs",
};

type Host = {
  readonly data: BridgeData;
  readonly tui: ReturnType<typeof createBridgeTuiData>;
  readonly sent: HostResponseFrame[];
  readonly store: DialogsStore;
  readonly clock: { value: number };
};

function bridge(): Host {
  const data = new BridgeData();
  const tui = createBridgeTuiData({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace" },
    events: bridgeEvents(data),
  });
  const clock = { value: 1_000 };
  const store = createDialogsStore({ data: tui, now: () => clock.value });
  const sent: HostResponseFrame[] = [];
  tui.hostDialogs.useSender((frame) => {
    sent.push(frame);
  });
  return { data: data, tui: tui, sent: sent, store: store, clock: clock };
}

async function mount(host: Host, width = 110) {
  mounted?.renderer.destroy();
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Dialogs data={host.tui} store={host.store} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: width, height: 50 },
  );
  mounted = app;
  await app.renderOnce();
  await app.renderOnce();
  return app;
}

function squash(text: string) {
  return text.replace(/\s+/g, "");
}

function occurrences(text: string, needle: string) {
  return text.split(needle).length - 1;
}

describe("bridge host dialogs", () => {
  test("a select dialog renders the host title, its options and an explicit cancel affordance", async () => {
    const host = bridge();
    host.data.publishEvent(selectPrompt);
    expect(host.store.live().map((entry) => entry.identity)).toEqual(["select:ui-permission-1"]);

    const app = await mount(host);
    const frame = squash(app.captureCharFrame());
    expect(frame).toContain("Permissionrequired:read");
    expect(frame).toContain("Path:/workspace/a.txt");
    expect(frame).toContain("Allowonce");
    expect(frame).toContain("Allowalways");
    expect(frame).toContain("Deny");
    expect(frame).toContain("Cancel(sendscancelled:true)");
    expect(frame).toContain("hostdecideswhetherananswerisacceptedandwhethertheactionruns");
    expect(frame).toContain("toolCallId=call-a");
  });

  test("answering a select sends exactly one frame with the frame's request id and the chosen label", async () => {
    const host = bridge();
    host.data.publishEvent(selectPrompt);
    const app = await mount(host);

    expect(host.store.answerSelect("select:ui-permission-1", "Allow once")).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(1);
    const response = host.sent[0];
    if (!("value" in response)) throw new Error("expected a value response, got a different frame shape");
    expect(response.uiRequestId).toBe("ui-permission-1");
    expect(response.value).toBe("Allow once");
    expect(host.tui.hostDialogs.list()).toEqual([]);
    expect(host.store.live()).toEqual([]);
    expect(host.store.entry("select:ui-permission-1")?.status).toBe("answered");

    expect(host.store.answerSelect("select:ui-permission-1", "Allow once").kind).toBe("not-live");
    expect(host.sent.length).toBe(1);

    await app.renderOnce();
    const frame = squash(app.captureCharFrame());
    expect(frame).toContain("Answered:Allowonce(sentonce;thispromptisnotsubmittedagain)");
    expect(frame).not.toContain("Cancel(sendscancelled:true)");
  });

  test("without a sender answering throws and the dialog stays open with the failure shown", async () => {
    const host = bridge();
    host.tui.hostDialogs.useSender(undefined);
    host.data.publishEvent(selectPrompt);
    const app = await mount(host);

    expect(() => host.store.answerSelect("select:ui-permission-1", "Allow once")).toThrow(UnsupportedCapability);
    expect(host.store.entry("select:ui-permission-1")?.status).toBe("open");
    expect(host.store.entry("select:ui-permission-1")?.failure).toContain("hostDialog.respond");
    expect(host.tui.hostDialogs.list().map((dialog) => dialog.id)).toEqual(["ui-permission-1"]);

    await app.renderOnce();
    const frame = squash(app.captureCharFrame());
    expect(frame).toContain("Theanswerwasnotsent:UNSUPPORTED_CAPABILITY:hostDialog.respond");
    expect(frame).toContain("Allowonce");
  });

  test("a repeated request id updates the existing entry instead of duplicating it", async () => {
    const host = bridge();
    host.data.publishEvent(selectPrompt);
    host.data.publishEvent({
      ...selectPrompt,
      title: "Permission required: write\n\nPath: /workspace/b.txt",
      options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
    });

    expect(host.store.entries().length).toBe(1);
    const entry = host.store.entry("select:ui-permission-1");
    expect(entry?.redeliveries).toBe(1);
    if (entry === undefined || entry.method !== "select") throw new Error("expected one select entry");
    expect(entry.frame.title).toContain("write");
    expect([...entry.frame.options]).toContain("Deny with feedback");
    expect(host.sent).toEqual([]);

    const app = await mount(host);
    const frame = squash(app.captureCharFrame());
    expect(frame).toContain("Permissionrequired:write");
    expect(frame).not.toContain("Permissionrequired:read");
    expect(occurrences(frame, "Allowonce")).toBe(1);
    expect(frame).toContain("Denywithfeedback");
  });

  test("a re-asked question with the same request id updates one entry and answers the newest frame id", async () => {
    const host = bridge();
    host.data.publishEvent(questionPrompt);
    host.data.publishEvent({ ...questionPrompt, id: "ui-question-2", remainingMs: 1_700_000 });

    expect(host.store.entries().length).toBe(1);
    const entry = host.store.entry("question:ask-user-1");
    if (entry === undefined || entry.method !== "question") throw new Error("expected one question entry");
    expect(entry.frame.id).toBe("ui-question-2");
    expect(entry.redeliveries).toBe(1);

    host.store.toggleOption("question:ask-user-1", "q1", "PostgreSQL");
    expect(host.store.submitQuestion("question:ask-user-1")).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(1);
    const response = host.sent[0];
    if (!("answers" in response)) throw new Error("expected an answers response");
    expect(response.uiRequestId).toBe("ui-question-2");
    expect(host.store.entries().length).toBe(1);
  });

  test("a dialog the host cancelled or timed out is shown as cancelled and cannot be answered", async () => {
    const host = bridge();
    host.data.publishEvent(questionPrompt);
    expect(host.store.live().length).toBe(1);

    host.data.publishEvent({
      type: "question_resolved",
      id: "ui-question-1",
      requestId: "ask-user-1",
      toolCallId: "ask-user-1",
      outcome: "timed_out",
      answers: {},
      unanswered: ["q1"],
    });

    expect(host.store.live()).toEqual([]);
    expect(host.store.entry("question:ask-user-1")?.status).toBe("cancelled");
    expect(host.store.entry("question:ask-user-1")?.cancelledBy).toBe("host");
    expect(host.store.submitQuestion("question:ask-user-1").kind).toBe("not-live");
    expect(host.sent).toEqual([]);

    host.data.publishEvent(questionPrompt);
    expect(host.store.entry("question:ask-user-1")?.status).toBe("cancelled");
    expect(host.store.entries().length).toBe(1);

    const app = await mount(host);
    const frame = squash(app.captureCharFrame());
    expect(frame).toContain("Dismissedbythehost(cancelledortimedout).Itcannolongerbeanswered.");
    expect(frame).not.toContain("Sendanswers");
  });

  test("cancelling sends cancelled: true once and freezes the prompt", async () => {
    const host = bridge();
    host.data.publishEvent(questionPrompt);

    expect(host.store.cancel("question:ask-user-1")).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(1);
    const response = host.sent[0];
    if (!("cancelled" in response)) throw new Error("expected a cancellation response");
    expect(response.cancelled).toBe(true);
    expect(response.uiRequestId).toBe("ui-question-1");
    expect(host.store.entry("question:ask-user-1")?.cancelledBy).toBe("client");
    expect(host.store.cancel("question:ask-user-1").kind).toBe("not-live");
    expect(host.sent.length).toBe(1);
  });

  test("a question renders its fields and submits answers plus comment under the frame id", async () => {
    const host = bridge();
    host.data.publishEvent(questionPrompt);
    const app = await mount(host);

    const rendered = squash(app.captureCharFrame());
    expect(rendered).toContain("Database");
    expect(rendered).toContain("WhichdatabaseshouldIuse?");
    expect(rendered).toContain("Selectone.");
    expect(rendered).toContain("PostgreSQL");
    expect(rendered).toContain("Theprimarystore");
    expect(rendered).toContain("≈29m59sleftbeforethehostclosesthisquestion");
    expect(rendered).toContain("Sendanswers");

    host.store.toggleOption("question:ask-user-1", "q1", "PostgreSQL");
    host.store.setComment("question:ask-user-1", "use the primary");
    await app.renderOnce();
    expect(host.store.draft("question:ask-user-1").selections.q1).toEqual(["PostgreSQL"]);

    expect(host.store.submitQuestion("question:ask-user-1")).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(1);
    const response = host.sent[0];
    if (!("answers" in response)) throw new Error("expected an answers response");
    expect(response.uiRequestId).toBe("ui-question-1");
    expect(response.answers).toEqual({ q1: { selected: ["PostgreSQL"] } });
    expect(response.comment).toBe("use the primary");
    expect(host.store.live()).toEqual([]);

    await app.renderOnce();
    expect(squash(app.captureCharFrame())).not.toContain("leftbeforethehostclosesthisquestion");
  });

  test("the remaining time falls as the local clock advances", async () => {
    const host = bridge();
    host.data.publishEvent(questionPrompt);
    const app = await mount(host);
    expect(squash(app.captureCharFrame())).toContain("≈29m59sleft");

    host.clock.value = 61_000;
    host.store.refreshClock();
    await app.renderOnce();
    expect(squash(app.captureCharFrame())).toContain("≈28m59sleft");
    expect(squash(app.captureCharFrame())).not.toContain("29m59s");
  });

  test("an incomplete question answer and an unoffered select label are refused before any write", async () => {
    const host = bridge();
    host.data.publishEvent(questionPrompt);
    host.data.publishEvent(selectPrompt);

    const empty = host.store.submitQuestion("question:ask-user-1");
    expect(empty.kind).toBe("invalid");
    expect(host.sent).toEqual([]);
    expect(host.store.entry("question:ask-user-1")?.status).toBe("open");

    const unoffered = host.store.answerSelect("select:ui-permission-1", "Allow forever");
    expect(unoffered.kind).toBe("invalid");
    expect(host.sent).toEqual([]);
    expect(host.store.entry("select:ui-permission-1")?.status).toBe("open");
  });

  test("a confirm dialog renders its message and both outcomes", async () => {
    const host = bridge();
    host.data.publishEvent(confirmPrompt);
    expect(host.store.live().map((entry) => entry.identity)).toEqual(["confirm:ui-confirm-1"]);

    const app = await mount(host);
    const frame = squash(app.captureCharFrame());
    expect(frame).toContain("Deletethebuilddirectory?");
    expect(frame).toContain("Thisremoves/workspace/buildandeverythinginit.");
    expect(frame).toContain("Confirm(sendsconfirmed:true)");
    expect(frame).toContain("Decline(sendsconfirmed:false)");
    expect(frame).toContain("Cancel(sendscancelled:true)");
    expect(frame).toContain("timeout=60000");
  });

  test("a confirm answer sends confirmed true and false under the frame id", async () => {
    const host = bridge();
    host.data.publishEvent(confirmPrompt);
    host.data.publishEvent({ ...confirmPrompt, id: "ui-confirm-2", title: "Keep the cache?" });

    expect(host.store.answerConfirm("confirm:ui-confirm-1", true)).toEqual({ kind: "sent" });
    expect(host.store.answerConfirm("confirm:ui-confirm-2", false)).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(2);

    const yes = host.sent[0];
    if (!("confirmed" in yes)) throw new Error("expected a confirmed response");
    expect(yes.uiRequestId).toBe("ui-confirm-1");
    expect(yes.confirmed).toBe(true);

    const no = host.sent[1];
    if (!("confirmed" in no)) throw new Error("expected a confirmed response");
    expect(no.uiRequestId).toBe("ui-confirm-2");
    expect(no.confirmed).toBe(false);
    expect(host.tui.hostDialogs.list()).toEqual([]);
    expect(host.store.live()).toEqual([]);
  });

  test("an input dialog sends the typed value", async () => {
    const host = bridge();
    host.data.publishEvent(inputPrompt);
    const app = await mount(host);

    const rendered = squash(app.captureCharFrame());
    expect(rendered).toContain("Branchname");
    expect(rendered).toContain("Placeholder:feature/<name>");
    expect(rendered).toContain("Sendvalue(sendsthetypedvalue)");
    expect(rendered).toContain("deadlineAtMs=1718001800000");
    expect(rendered).not.toContain("leftbeforethehostcloses");

    expect(host.store.answerText("input:ui-input-1").kind).toBe("invalid");
    expect(host.sent).toEqual([]);

    host.store.setText("input:ui-input-1", "feature/dialog-kinds");
    expect(host.store.answerText("input:ui-input-1")).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(1);
    const response = host.sent[0];
    if (!("value" in response)) throw new Error("expected a value response");
    expect(response.uiRequestId).toBe("ui-input-1");
    expect(response.value).toBe("feature/dialog-kinds");

    await app.renderOnce();
    expect(squash(app.captureCharFrame())).toContain("Answered:feature/dialog-kinds(sentonce;");
  });

  test("a secret input takes typed characters without rendering them", async () => {
    const host = bridge();
    host.data.publishEvent(secretPrompt);
    const app = await mount(host);

    const field = app.renderer.root.findDescendantById("dialog-secret-input:ui-input-secret-1");
    if (field === undefined) throw new Error("expected the secret field");
    field.focus();
    await app.mockInput.typeText("hunter2-token");
    await app.renderOnce();

    const rendered = squash(app.captureCharFrame());
    expect(rendered).toContain("Registrytoken");
    expect(rendered).toContain("secret=true");
    expect(rendered).toContain("•••••••••••••");
    expect(rendered).not.toContain("hunter2");

    const entry = host.store.entry("input:ui-input-secret-1");
    if (entry === undefined) throw new Error("expected a secret input entry");
    expect(host.store.textFor(entry)).toBe("hunter2-token");

    expect(host.store.answerText("input:ui-input-secret-1")).toEqual({ kind: "sent" });
    const response = host.sent[0];
    if (!("value" in response)) throw new Error("expected a value response");
    expect(response.value).toBe("hunter2-token");

    await app.renderOnce();
    const settled = squash(app.captureCharFrame());
    expect(settled).not.toContain("hunter2");
    expect(settled).toContain("Answered:asecretvalue(13characters,notshown)(sentonce;");
  });

  test("an editor dialog renders its prefill and sends the edited text", async () => {
    const host = bridge();
    host.data.publishEvent(editorPrompt);
    const app = await mount(host);

    const rendered = squash(app.captureCharFrame());
    expect(rendered).toContain("Commitmessage");
    expect(rendered).toContain("feat(tui):surfacehostdialogs");
    expect(rendered).toContain("Sendtext(sendstheeditedtext)");

    const entry = host.store.entry("editor:ui-editor-1");
    if (entry === undefined) throw new Error("expected an editor entry");
    expect(host.store.textFor(entry)).toBe(editorPrompt.prefill);

    host.store.setText("editor:ui-editor-1", "feat(tui): surface all five dialog kinds\n\nbody line");
    expect(host.store.answerText("editor:ui-editor-1")).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(1);
    const response = host.sent[0];
    if (!("value" in response)) throw new Error("expected a value response");
    expect(response.uiRequestId).toBe("ui-editor-1");
    expect(response.value).toBe("feat(tui): surface all five dialog kinds\n\nbody line");

    await app.renderOnce();
    expect(squash(app.captureCharFrame())).toContain("Answered:textof2lines(sentonce;");
  });

  test("a settled confirm, input or editor dialog cannot be answered again", async () => {
    const host = bridge();
    host.data.publishEvent(confirmPrompt);
    host.data.publishEvent(inputPrompt);
    host.data.publishEvent(editorPrompt);

    expect(host.store.answerConfirm("confirm:ui-confirm-1", true)).toEqual({ kind: "sent" });
    host.store.setText("input:ui-input-1", "main");
    expect(host.store.answerText("input:ui-input-1")).toEqual({ kind: "sent" });
    expect(host.store.answerText("editor:ui-editor-1")).toEqual({ kind: "sent" });
    expect(host.sent.length).toBe(3);
    expect(host.store.live()).toEqual([]);

    expect(host.store.answerConfirm("confirm:ui-confirm-1", false).kind).toBe("not-live");
    expect(host.store.answerText("input:ui-input-1").kind).toBe("not-live");
    expect(host.store.answerText("editor:ui-editor-1").kind).toBe("not-live");
    expect(host.store.cancel("confirm:ui-confirm-1").kind).toBe("not-live");
    expect(host.store.cancel("input:ui-input-1").kind).toBe("not-live");
    expect(host.store.cancel("editor:ui-editor-1").kind).toBe("not-live");
    expect(host.sent.length).toBe(3);

    const app = await mount(host);
    const frame = squash(app.captureCharFrame());
    expect(frame).not.toContain("Confirm(sendsconfirmed:true)");
    expect(frame).not.toContain("Sendvalue(sendsthetypedvalue)");
    expect(frame).not.toContain("Sendtext(sendstheeditedtext)");
  });

  test("pressing escape cancels a live question and answers nothing once it has settled", async () => {
    const host = bridge();
    host.data.publishEvent(questionPrompt);
    await mount(host);
    await Bun.sleep(20);
    mounted?.mockInput.pressKey("ESCAPE");
    await Bun.sleep(20);
    expect(host.sent.length).toBe(1);
    const response = host.sent[0];
    if (!("cancelled" in response)) throw new Error("expected a cancellation response");
    expect(response.cancelled).toBe(true);
    expect(response.uiRequestId).toBe("ui-question-1");
    expect(host.store.live().length).toBe(0);

    /* the settled row is no longer live, so the same key that just cancelled has nothing to answer */
    mounted?.mockInput.pressKey("ESCAPE");
    await Bun.sleep(20);
    expect(host.sent.length).toBe(1);
  });

  test("pressing the option number answers the select with that label", async () => {
    const host = bridge();
    host.data.publishEvent(selectPrompt);
    await mount(host);
    await Bun.sleep(20);
    mounted?.mockInput.typeText("1");
    await Bun.sleep(20);
    expect(host.sent.length).toBe(1);
    expect(host.sent[0]).toMatchObject({ type: "extension_ui_response", uiRequestId: "ui-permission-1", value: "Allow once" });
    expect(host.store.live().length).toBe(0);
  });

  test("pressing y answers a confirm dialog with true", async () => {
    const host = bridge();
    host.data.publishEvent({ type: "extension_ui_request", id: "ui-confirm-1", method: "confirm", title: "Confirm", message: "Proceed?" });
    await mount(host);
    await Bun.sleep(20);
    mounted?.mockInput.typeText("y");
    await Bun.sleep(20);
    expect(host.sent.length).toBe(1);
    expect(host.sent[0]).toMatchObject({ type: "extension_ui_response", uiRequestId: "ui-confirm-1", confirmed: true });
  });
});
