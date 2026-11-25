import type { CaseContext, CaseResult, Check } from "../run.ts";
import { createBridgeHostOps, createBridgePromptSender, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import type { HostSessionStatus } from "../../../packages/cli/src/bridge-run.ts";
import { MessageChannelRefused } from "../../../packages/client/src/message-channel.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { createBridgeTuiContext } from "../../../packages/tui/src/context/bridge.ts";
import { assistantText, isRecord, MODEL_HOST_MODEL, MODEL_HOST_PROVIDER, openModelHost } from "./model-host.ts";
import type { Frame } from "./model-host.ts";

/**
 * P-739 against real model turns: the client message channel's `edit` and `continueFromLeaf` members
 * reach the host's `edit_user_message` and `continue_from_leaf`, and the transcript shows the branch
 * each one makes.
 *
 * Order: prompt - continue from the answer (a new turn with no new prompt) - edit the user message
 * (the edited copy becomes the leaf and the old replies leave the active branch) - continue again,
 * which the host refuses with `leaf_not_assistant`. A sentinel file proves nothing was restored: the
 * host keeps no snapshots, and neither member pretends to.
 */

const SENTINEL = "/work/branch-sentinel.txt";
const SENTINEL_TEXT = "bridge-sentinel-untouched";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const host = await openModelHost("bridge-branch-");
  if (host.kind === "blocked") {
    return { checks: [], cleanup: { ok: true, detail: [host.reason] }, blocked: true };
  }
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
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
        continueFromLeaf: ops.continueFromLeaf,
      },
      () => "ready",
    );

    host.exec("printf '%s' '" + SENTINEL_TEXT + "' > " + SENTINEL);
    const session = await ops.createSession({ title: "branch-run" });
    const routingId = routingById.get(session.id);
    if (routingId === undefined) throw new Error("the host never announced session " + session.id);
    await host.transport.request("set_model", { sessionId: routingId, provider: MODEL_HOST_PROVIDER, modelId: MODEL_HOST_MODEL });

    const first = await turnOf(host, () =>
      context.tuiData.session.prompt({
        sessionID: session.id,
        text: "Reply with exactly: FIRST-OK",
        clientMessageId: "branch-first",
      }),
    );
    record("the-first-turn-completed", "FIRST-OK", assistantText(first).replace(/\s+/g, " ").slice(0, 60), assistantText(first).includes("FIRST-OK"));
    await pullHostState(host.transport, data, sessions);
    const afterFirst = countAssistants(data.hostMessagesFor(session.id));

    const continued = await turnOf(host, async () => {
      await context.tuiData.session.message.continueFromLeaf({ sessionID: session.id });
    });
    record(
      "continue-from-leaf-runs-a-turn-with-no-new-prompt",
      "a second assistant message from the host",
      String(afterFirst) + " assistant row(s), continue answered: " + (continued === undefined ? "timeout" : "settled"),
      continued !== undefined,
    );
    await pullHostState(host.transport, data, sessions);
    record(
      "the-continued-turn-grew-the-transcript",
      "more assistant rows than the first turn left",
      String(countAssistants(data.hostMessagesFor(session.id))) + " assistant row(s)",
      countAssistants(data.hostMessagesFor(session.id)) > afterFirst,
    );

    const userRow = data
      .hostMessagesFor(session.id)
      .find((message) => message.type === "user" && typeof message.metadata?.["hostEntryID"] === "string");
    if (userRow === undefined) throw new Error("the transcript exposed no user row bound to a host entry id");
    const originalEntryID = String(userRow.metadata?.["hostEntryID"]);
    const entriesBefore = await host.transport.request("get_entries", { sessionId: routingId });
    const entryCountBefore = entriesOf(entriesBefore).length;

    const edited = await context.tuiData.session.message.edit({
      sessionID: session.id,
      messageID: userRow.id,
      text: "Reply with exactly: EDITED-OK",
    });
    record(
      "edit-reports-the-host-outcome",
      "outcome edited with a new leaf",
      JSON.stringify({ outcome: edited.outcome, leaf: edited.leafID, entry: edited.entryID }),
      edited.outcome === "edited" && edited.leafID !== null && edited.leafID !== originalEntryID,
    );

    await pullHostState(host.transport, data, sessions);
    const active = data.hostMessagesFor(session.id);
    const activeUser = active.find((message) => message.type === "user");
    record(
      "the-edited-prompt-is-the-active-branch",
      "the edited text, with the pre-edit replies gone from the active branch",
      JSON.stringify({ user: activeUser?.type === "user" ? activeUser.text.slice(0, 60) : null, assistants: countAssistants(active) }),
      activeUser?.type === "user" &&
        activeUser.text.includes("EDITED-OK") &&
        countAssistants(active) === 0,
    );

    const entriesAfter = await host.transport.request("get_entries", { sessionId: routingId });
    const entries = entriesOf(entriesAfter);
    record(
      "the-abandoned-branch-stays-in-the-session-file",
      "the original entry is still an entry and the file grew",
      String(entryCountBefore) + " -> " + String(entries.length) + " entries, original present: " + String(entries.some((entry) => entry.id === originalEntryID)),
      entries.length > entryCountBefore && entries.some((entry) => entry.id === originalEntryID),
    );

    let refusal: unknown;
    try {
      await context.tuiData.session.message.continueFromLeaf({ sessionID: session.id });
    } catch (error) {
      refusal = error;
    }
    record(
      "continue-from-an-edited-prompt-is-refused-typed",
      "MessageChannelRefused leaf_not_assistant",
      refusal instanceof MessageChannelRefused ? refusal.code : String(refusal).slice(0, 120),
      refusal instanceof MessageChannelRefused && refusal.code === "leaf_not_assistant",
    );

    const sentinel = host.exec("cat " + SENTINEL).trim();
    record(
      "no-file-was-restored",
      SENTINEL_TEXT + " unchanged",
      sentinel.slice(0, 60),
      sentinel === SENTINEL_TEXT,
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 240), false);
  }
  const detail = await host.close();
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}

/** Runs `trigger` and waits for the assistant message that turn produces, bounded by one deadline. */
async function turnOf(host: Awaited<ReturnType<typeof openModelHost>>, trigger: () => Promise<unknown>): Promise<Frame | undefined> {
  if (host.kind !== "open") return undefined;
  const startIndex = host.frames.list().length;
  await trigger();
  return host.frames.waitFor(
    (frame) =>
      host.frames.list().indexOf(frame) >= startIndex &&
      frame.type === "message_end" &&
      isRecord(frame.message) &&
      frame.message.role === "assistant" &&
      frame.message.stopReason === "stop",
    240_000,
  );
}

function countAssistants(messages: readonly { readonly type: string }[]): number {
  return messages.filter((message) => message.type === "assistant").length;
}

function entriesOf(answer: Record<string, unknown>): readonly { readonly id: string }[] {
  const payload = isRecord(answer.data) ? answer.data : {};
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  return entries.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [{ id: entry.id }] : []));
}
