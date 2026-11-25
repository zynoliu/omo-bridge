import type { CaseContext, CaseResult, Check } from "../run.ts";
import { createBridgeHostOps, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import type { HostSessionStatus } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { readForkMessages } from "../../../packages/bridge-core/src/host-capabilities.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { dataOf, openLiveHost, text } from "./live-host.ts";

/**
 * P-739 against the real host, without a model turn: the transcript cleanup the client calls a revert
 * is `navigate_tree` on a real entry id, the message ids the transcript rows carry are the host's
 * entry ids, and fork reaches `clone`/`fork`. The user-message half of the mapping needs a prompt in
 * the session, which needs a provider turn; the case measures that boundary instead of faking it.
 *
 * Fixture for the real entry: `send_custom_message` with `triggerTurn: false` appends a
 * `custom_message` entry, so a real tree entry exists with no model work.
 */
export async function run(_context: CaseContext): Promise<CaseResult> {
  const host = await openLiveHost("bridge-edit-");
  if (host.kind === "blocked") {
    return { checks: [], cleanup: { ok: true, detail: [host.reason] }, blocked: true };
  }
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  const detail: string[] = [];
  try {
    const data = new BridgeData();
    const sessions = new SessionRegistry();
    const routingById = new Map<string, string>();
    const statusById = new Map<string, HostSessionStatus>();
    const pulled = new Set<string>();
    const recallRouting = (status: HostSessionStatus) => {
      routingById.set(status.durableId, status.routingId);
      statusById.set(status.durableId, status);
    };
    const ops = createBridgeHostOps({
      transport: () => host.transport,
      data: data,
      sessions: sessions,
      routingById: routingById,
      statusById: statusById,
      recallRouting: recallRouting,
      pulled: pulled,
      interaction: new InteractionController(),
      cwd: "/work",
    });

    const session = await ops.createSession({ title: "qa edit" });
    const routing = routingById.get(session.id);
    record("session-opened", "the host opens a session", session.id, session.id.length > 0);

    const custom = await host.ask("send_custom_message", {
      sessionId: routing,
      message: "qa custom message",
      triggerTurn: false,
    });
    record("a-tree-entry-exists-without-a-turn", "send_custom_message accepted", text(custom, 120), custom.success === true);

    await pullHostState(host.transport, data, sessions);
    const branch = data.hostBranchFor(session.id);
    const last = branch?.entries.at(-1);
    const lastType =
      typeof last?.data === "object" && last.data !== null && "type" in last.data
        ? String((last.data as { type?: unknown }).type ?? "")
        : "";
    record(
      "the-pull-carries-the-entry",
      "the branch ends on the custom message entry",
      last === undefined ? "no entry" : last.id + " " + lastType,
      last !== undefined && lastType === "custom_message",
    );

    const staged = await ops.revertStage({ sessionID: session.id, messageID: last?.id ?? "missing" });
    record(
      "stage-records-the-boundary-on-the-row",
      "the session row reports the staged revert",
      text(data.hostSession(session.id)?.revert ?? null),
      staged.messageID === last?.id && data.hostSession(session.id)?.revert?.messageID === last?.id,
    );

    let filesRefused = "";
    try {
      await ops.revertStage({ sessionID: session.id, messageID: last?.id ?? "missing", files: true });
      filesRefused = "accepted";
    } catch (error) {
      filesRefused = String(error).slice(0, 160);
    }
    record(
      "file-restore-is-refused-because-the-host-keeps-no-snapshots",
      "a typed refusal instead of a revert that silently restores nothing",
      filesRefused,
      filesRefused.includes("no file snapshots"),
    );

    const before = data.hostBranchFor(session.id)?.leafId;
    await ops.revertCommit({ sessionID: session.id });
    const after = data.hostBranchFor(session.id)?.leafId;
    record(
      "commit-moves-the-leaf-to-the-parent",
      "navigate_tree select leaves the leaf on the entry's parent",
      String(before) + " -> " + String(after),
      after !== undefined && after !== before && after !== last?.id,
    );
    record(
      "commit-clears-the-staged-boundary",
      "no revert remains on the row",
      text(data.hostSession(session.id)?.revert ?? null),
      data.hostSession(session.id)?.revert === undefined,
    );

    const forkMessages = readForkMessages((await host.ask("get_fork_messages", { sessionId: routing })).data);
    record(
      "fork-messages-report-only-prompts-the-host-holds",
      "an empty list while no user prompt exists",
      text(forkMessages),
      forkMessages !== undefined && forkMessages.length === 0,
    );
    const notUser = await host.ask("edit_user_message", { sessionId: routing, entryId: last?.id ?? "missing", text: "x" });
    record(
      "editing-a-non-user-entry-is-typed",
      "not_user for a custom message entry",
      text(notUser, 140),
      String((notUser as Record<string, unknown>).errorCode ?? "") === "not_user",
    );
    const nothing = await host.ask("continue_from_leaf", { sessionId: routing });
    record(
      "continue-from-leaf-is-typed-when-there-is-nothing-to-continue",
      "nothing_to_continue before any answer exists",
      text(nothing, 160),
      String((nothing as Record<string, unknown>).errorCode ?? "") === "nothing_to_continue",
    );

    const previous = session.id;
    const forked = await ops.forkSession({ sessionID: previous });
    record(
      "fork-reports-the-session-the-host-made",
      "a different durable id, pulled with its own row",
      previous.slice(0, 8) + " -> " + forked.id.slice(0, 8),
      forked.id !== previous && data.hostSession(forked.id)?.id === forked.id,
    );
    record(
      "the-replaced-session-is-no-longer-addressable-here",
      "the old routing entry is dropped rather than pointing at the fork",
      String(routingById.get(previous)),
      !routingById.has(previous),
    );
    record(
      "the-fork-is-addressable",
      "the new session has a routing handle",
      String(routingById.get(forked.id)),
      routingById.get(forked.id) !== undefined,
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    detail.push(...(await host.close()));
  }
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
