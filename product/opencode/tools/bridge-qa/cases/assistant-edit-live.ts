import type { CaseContext, CaseResult, Check } from "../run.ts";
import { createBridgeHostOps, createBridgePromptSender, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import type { HostSessionStatus } from "../../../packages/cli/src/bridge-run.ts";
import { MessageChannelRefused } from "../../../packages/client/src/message-channel.ts";
import { UnsupportedCapability } from "../../../packages/bridge-core/src/client.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { createBridgeTuiContext } from "../../../packages/tui/src/context/bridge.ts";
import { assistantText, isRecord, MODEL_HOST_MODEL, MODEL_HOST_PROVIDER, openModelHost } from "./model-host.ts";

/**
 * P-739, the assistant half: the client message channel's `editAssistantMessage` member reaches the
 * host's `edit_assistant_message` on a real transcript, and the transcript shows the edit.
 *
 * Order: one real turn - a stale `expectedLeafID` is refused typed before anything is written - the
 * assistant answer is edited - the active branch carries the corrected text while the original answer
 * stays in the session file - editing a user message through the assistant member is refused
 * `not_assistant`. A sentinel file proves nothing was restored: the host keeps no file snapshots, so
 * neither member pretends to.
 *
 * A data layer built without the host member is also driven here: that is the unwired seam, and it
 * must refuse with `UnsupportedCapability` rather than reporting a write that never left.
 */

const SENTINEL = "/work/assistant-edit-sentinel.txt";
const SENTINEL_TEXT = "bridge-sentinel-untouched";
const CORRECTED = "CORRECTED-ANSWER-OK";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const host = await openModelHost("bridge-assistant-edit-");
  if (host.kind === "blocked") {
    return { checks: [], cleanup: { ok: true, detail: [host.reason] }, blocked: true };
  }
  try {
    const data = new BridgeData();
    const sessions = new SessionRegistry();
    const routingById = new Map<string, string>();
    const statusById = new Map<string, HostSessionStatus>();
    const recallRouting = (status: HostSessionStatus) => {
      routingById.set(status.durableId, status.routingId);
      statusById.set(status.durableId, status);
      data.rememberRoutingId(status.durableId, status.routingId);
    };
    const ops = createBridgeHostOps({
      transport: () => host.transport,
      data: data,
      sessions: sessions,
      routingById: routingById,
      statusById: statusById,
      recallRouting: recallRouting,
      pulled: new Set<string>(),
      interaction: new InteractionController(),
      cwd: "/work",
    });
    const context = createBridgeTuiContext(
      {
        data: data,
        defaultLocation: { directory: "/work" },
        sessions: sessions,
        dialogs: new DialogRegistry(),
        interaction: new InteractionController(),
        sendPrompt: createBridgePromptSender({
          transport: () => host.transport,
          data: data,
          sessions: sessions,
          routingId: (durableId) => routingById.get(durableId),
          status: (durableId) => statusById.get(durableId),
        }),
        editMessage: ops.editMessage,
        editAssistantMessage: ops.editAssistantMessage,
        continueFromLeaf: ops.continueFromLeaf,
      },
      () => "ready",
    );

    /* The member has to exist on the shipped data layer before anything else can be about it. */
    const member = context.tuiData.session.message.editAssistantMessage;
    record(
      "the-member-is-on-the-client-message-channel",
      "editAssistantMessage is a function on the TUI data layer",
      typeof member,
      typeof member === "function",
    );
    if (typeof member !== "function") {
      /* The unwired state: say so and stop, instead of failing later for a reason that looks unrelated. */
      return { checks: checks, cleanup: { ok: false, detail: await host.close() } };
    }

    /* The same seam without the host member: this is what a launcher that never injected it looks like. */
    const bare = createBridgeTuiContext(
      {
        data: new BridgeData(),
        defaultLocation: { directory: "/work" },
        sessions: new SessionRegistry(),
        dialogs: new DialogRegistry(),
        interaction: new InteractionController(),
      },
      () => "ready",
    );
    let unwired: unknown;
    try {
      await bare.tuiData.session.message.editAssistantMessage({ sessionID: "ses_x", messageID: "msg_x", text: "x" });
    } catch (error) {
      unwired = error;
    }
    record(
      "the-unwired-seam-refuses-typed",
      "UnsupportedCapability session.message.editAssistantMessage",
      unwired instanceof UnsupportedCapability ? unwired.capability : String(unwired).slice(0, 120),
      unwired instanceof UnsupportedCapability && unwired.capability === "session.message.editAssistantMessage",
    );

    host.exec("printf '%s' '" + SENTINEL_TEXT + "' > " + SENTINEL);
    const session = await ops.createSession({ title: "assistant-edit-run" });
    const routingId = routingById.get(session.id);
    if (routingId === undefined) throw new Error("the host never announced session " + session.id);
    await host.transport.request("set_model", {
      sessionId: routingId,
      provider: MODEL_HOST_PROVIDER,
      modelId: MODEL_HOST_MODEL,
    });

    const startIndex = host.frames.list().length;
    await context.tuiData.session.prompt({
      sessionID: session.id,
      text: "Reply with exactly: EDIT-TARGET",
      clientMessageId: "assistant-edit-first",
    });
    const turn = await host.frames.waitFor(
      (frame) =>
        host.frames.list().indexOf(frame) >= startIndex &&
        frame.type === "message_end" &&
        isRecord(frame.message) &&
        frame.message.role === "assistant" &&
        frame.message.stopReason === "stop",
      240_000,
    );
    record(
      "the-real-turn-answered",
      "EDIT-TARGET",
      assistantText(turn).replace(/\s+/g, " ").slice(0, 80),
      assistantText(turn).includes("EDIT-TARGET"),
    );

    await pullHostState(host.transport, data, sessions);
    const assistantRow = data
      .hostMessagesFor(session.id)
      .find((message) => message.type === "assistant" && typeof message.metadata?.["hostEntryID"] === "string");
    if (assistantRow === undefined) throw new Error("the transcript exposed no assistant row bound to a host entry id");
    const originalEntryID = String(assistantRow.metadata?.["hostEntryID"]);
    const entriesBefore = entriesOf(await host.transport.request("get_entries", { sessionId: routingId }));

    let stale: unknown;
    try {
      await context.tuiData.session.message.editAssistantMessage({
        sessionID: session.id,
        messageID: assistantRow.id,
        text: CORRECTED,
        expectedLeafID: "entry-not-the-current-leaf",
      });
    } catch (error) {
      stale = error;
    }
    record(
      "a-stale-expected-leaf-is-refused-before-anything-is-written",
      "MessageChannelRefused stale_leaf",
      stale instanceof MessageChannelRefused ? stale.code : String(stale).slice(0, 120),
      stale instanceof MessageChannelRefused && stale.code === "stale_leaf",
    );

    const edited = await context.tuiData.session.message.editAssistantMessage({
      sessionID: session.id,
      messageID: assistantRow.id,
      text: CORRECTED,
    });
    record(
      "the-host-accepts-the-assistant-edit",
      "outcome edited with a new leaf and the copy's own entry id",
      JSON.stringify({ outcome: edited.outcome, leaf: edited.leafID, entry: edited.entryID }),
      edited.outcome === "edited" &&
        edited.leafID !== null &&
        edited.leafID !== originalEntryID &&
        typeof edited.entryID === "string",
    );

    await pullHostState(host.transport, data, sessions);
    const active = data.hostMessagesFor(session.id);
    const activeAssistant = active.find((message) => message.type === "assistant");
    const activeText = assistantRowText(activeAssistant);
    record(
      "the-transcript-reflects-the-edit",
      "the active branch's assistant row carries the corrected text",
      JSON.stringify({
        assistant: activeText.replace(/\s+/g, " ").slice(0, 80),
        assistants: active.filter((message) => message.type === "assistant").length,
      }),
      activeText.includes(CORRECTED) && !activeText.includes("EDIT-TARGET"),
    );

    const entriesAfter = entriesOf(await host.transport.request("get_entries", { sessionId: routingId }));
    record(
      "the-original-answer-stays-in-the-session-file",
      "the file grew and still holds the replaced entry",
      String(entriesBefore.length) + " -> " + String(entriesAfter.length) + " entries, original present: " + String(entriesAfter.some((entry) => entry.id === originalEntryID)),
      entriesAfter.length > entriesBefore.length && entriesAfter.some((entry) => entry.id === originalEntryID),
    );

    const userRow = data
      .hostMessagesFor(session.id)
      .find((message) => message.type === "user" && typeof message.metadata?.["hostEntryID"] === "string");
    if (userRow === undefined) throw new Error("the transcript exposed no user row bound to a host entry id");
    let wrongRole: unknown;
    try {
      await context.tuiData.session.message.editAssistantMessage({
        sessionID: session.id,
        messageID: userRow.id,
        text: CORRECTED,
      });
    } catch (error) {
      wrongRole = error;
    }
    record(
      "editing-a-user-message-through-the-assistant-member-is-typed",
      "MessageChannelRefused not_assistant",
      wrongRole instanceof MessageChannelRefused ? wrongRole.code : String(wrongRole).slice(0, 120),
      wrongRole instanceof MessageChannelRefused && wrongRole.code === "not_assistant",
    );

    const sentinel = host.exec("cat " + SENTINEL).trim();
    record("no-file-was-restored", SENTINEL_TEXT + " unchanged", sentinel.slice(0, 60), sentinel === SENTINEL_TEXT);
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 240), false);
  }
  const detail = await host.close();
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}

/** An assistant row keeps its text in content parts, not in a row-level field. */
function assistantRowText(row: unknown): string {
  if (!isRecord(row)) return "";
  const content = row.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("");
}

function entriesOf(answer: Record<string, unknown>): readonly { readonly id: string }[] {
  const payload = isRecord(answer.data) ? answer.data : {};
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  return entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [{ id: entry.id }] : []));
}
