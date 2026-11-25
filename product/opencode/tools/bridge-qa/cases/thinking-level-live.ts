import type { CaseContext, CaseResult, Check } from "../run.ts";
import { createBridgeHostOps, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import type { HostSessionStatus } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { readThinkingLevels, supportsThinkingLevel } from "../../../packages/bridge-core/src/host-capabilities.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { dataOf, openLiveHost, text } from "./live-host.ts";

const MODEL_PROVIDER = "opencode-go";
const MODEL_ID = "deepseek-v4.1-flash";

/**
 * P-694 against the real host: the thinking level the shipped pull projects, the read shape the host
 * requires (`get_model_thinking_level` with an explicit provider and model id), and the level a write
 * reports afterwards. No model turn is used. A run that supplies `BRIDGE_QA_MODEL_KEY` selects the free
 * model the way the TUI's picker does and requires a non-off level to be set and read back; without the
 * key the case records the model the host has rather than treating the wiring as a defect.
 */
export async function run(_context: CaseContext): Promise<CaseResult> {
  const host = await openLiveHost("bridge-thinking-");
  if (host.kind === "blocked") {
    return { checks: [], cleanup: { ok: true, detail: [host.reason] }, blocked: true };
  }
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  const detail: string[] = [];
  try {
    const opened = await host.ask("open_session", { cwd: "/work" });
    const openedData = dataOf(opened) ?? {};
    const openedState = typeof openedData.state === "object" && openedData.state !== null ? (openedData.state as Record<string, unknown>) : {};
    const durableId = String(openedState.sessionId ?? "");
    record(
      "session-opened",
      "the host opens a session",
      durableId.length > 0 ? "durable id present" : text(opened),
      durableId.length > 0,
    );

    /* A keyed run names the model the way the TUI's picker does: the host's own model profile resolves
       the startup model on its own, which on a run with no entitlement answers no turn and reports
       `unknown`. */
    const keyed = (process.env.BRIDGE_QA_MODEL_KEY ?? "").length > 0;
    const pinned = keyed
      ? await host.ask("set_model", { sessionId: String(openedData.sessionId ?? ""), provider: MODEL_PROVIDER, modelId: MODEL_ID })
      : undefined;

    const data = new BridgeData();
    const sessions = new SessionRegistry();
    const routingById = new Map<string, string>();
    const statusById = new Map<string, HostSessionStatus>();
    const pulled = new Set<string>();
    let pulledCount = 0;
    const outcome = await pullHostState(host.transport, data, sessions);
    pulledCount = outcome.sessionIds.length;
    record(
      "pull-completed",
      "every announced session is pulled",
      String(pulledCount) + " session(s)",
      pulledCount > 0,
    );
    for (const status of outcome.statuses) {
      routingById.set(status.durableId, status.routingId);
      statusById.set(status.durableId, status);
    }
    for (const id of outcome.sessionIds) pulled.add(id);

    const state = (dataOf(await host.ask("get_state", { sessionId: routingById.get(durableId) })) ?? {});
    const reported = readStateLevel(state);
    const thinking = data.hostThinkingFor(durableId);
    record(
      "pull-projects-the-host-level",
      "the level get_state reports is the level the pull records",
      "state " + String(reported) + ", pulled " + String(thinking?.level),
      reported !== undefined && thinking?.level === reported,
    );
    const session = data.hostSession(durableId);
    record(
      "session-row-carries-the-level-as-the-model-variant",
      "model.variant is the host's thinking level",
      text(session?.model ?? null),
      session?.model?.variant === reported,
    );
    record(
      "a-real-model-is-selected",
      keyed ? "set_model accepted and the pull reports " + MODEL_PROVIDER + "/" + MODEL_ID : "no key: the host's own model is recorded",
      keyed ? "set_model=" + String(pinned?.success) + " pulled=" + text(session?.model ?? null) : "not keyed",
      !keyed ||
        (pinned?.success === true &&
          session?.model !== undefined &&
          session.model.providerID !== "unknown" &&
          session.model.id !== "unknown"),
    );
    record(
      "thinking-source-is-recorded",
      "thinkingLevelSource is kept as published (null when the host omits it)",
      String(thinking?.source),
      thinking !== undefined && (thinking.source === null || thinking.source.length > 0),
    );

    const levelsAnswer = await host.ask("get_available_thinking_levels", { sessionId: routingById.get(durableId) });
    const levels = readThinkingLevels(levelsAnswer.data) ?? [];
    record(
      "available-levels-are-read",
      "a non-empty level list for the active model",
      levels.join(",") || text(levelsAnswer),
      levels.length > 0,
    );
    record(
      "a-non-off-level-is-offered",
      keyed ? "the selected model offers at least one level other than off" : "the host's own list is reported as published",
      levels.join(",") || text(levelsAnswer),
      keyed ? levels.some((level) => level !== "off") : levels.length > 0,
    );
    record(
      "pull-stores-the-available-levels",
      "the pull records the host's level list",
      (thinking?.availableLevels ?? []).join(","),
      thinking !== undefined && thinking.availableLevels.length === levels.length,
    );

    const model = session?.model;
    const perModel =
      model === undefined
        ? { skipped: true }
        : await host.ask("get_model_thinking_level", {
            sessionId: routingById.get(durableId),
            provider: model.providerID,
            modelId: model.id,
          });
    const perModelError = String((perModel as Record<string, unknown>).errorCode ?? "");
    const perModelData = dataOf(perModel as Record<string, unknown>);
    record(
      "explicit-provider-and-model-is-the-supported-read",
      "a level, or the typed model_not_found refusal when no provider is configured",
      text(perModel, 200),
      perModelData?.level !== undefined || perModelError === "model_not_found",
    );
    const missingArgs = await host.ask("get_model_thinking_level", { sessionId: routingById.get(durableId) });
    record(
      "the-read-requires-both-fields",
      "invalid_argument when provider and modelId are omitted",
      text(missingArgs, 160),
      String((missingArgs as Record<string, unknown>).errorCode ?? "") === "invalid_argument",
    );

    const target = levels[levels.length - 1] ?? levels[0] ?? "off";
    const set = await host.ask("set_thinking_level", { sessionId: routingById.get(durableId), level: target });
    const afterData = new BridgeData();
    await pullHostState(host.transport, afterData, new SessionRegistry());
    record(
      "a-set-level-is-what-the-next-pull-reports",
      "the level the host accepted comes back through a fresh pull",
      "set " + target + " -> pulled " + String(afterData.hostThinkingFor(durableId)?.level),
      set.success === true && afterData.hostThinkingFor(durableId)?.level === target && (!keyed || target !== "off"),
    );

    const bogus = await host.ask("set_thinking_level", { sessionId: routingById.get(durableId), level: "bogus" });
    record(
      "the-host-does-not-validate-an-unknown-level",
      "the bridge's own predicate is the only guard: 'bogus' is outside the host's list",
      "host answered success=" + String(bogus.success) + "; supportsThinkingLevel('bogus') = " + String(supportsThinkingLevel("bogus", levels)),
      !supportsThinkingLevel("bogus", levels),
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    detail.push(...(await host.close()));
  }
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}

function readStateLevel(state: Record<string, unknown>): string | undefined {
  const level = state.thinkingLevel;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}
