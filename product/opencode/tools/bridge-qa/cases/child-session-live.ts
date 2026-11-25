import type { CaseContext, CaseResult, Check } from "../run.ts";
import { createBridgeHostOps, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import type { HostSessionStatus } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { readLifecycle } from "../../../packages/bridge-core/src/host-capabilities.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { dataOf, openLiveHost, text } from "./live-host.ts";

/**
 * P-725 against the real host: a child opened through the shipped `createSession` carries
 * `spawnedBy`, the host persists that ancestry, and the pull projects it onto the session row so the
 * TUI's `root`/`family` walk real parents instead of collapsing to every session. No model turn.
 */
export async function run(_context: CaseContext): Promise<CaseResult> {
  const host = await openLiveHost("bridge-child-");
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

    const parent = await ops.createSession({ title: "qa parent" });
    record("parent-opened", "the host opens a root session", parent.id + " / " + String(parent.parentID), parent.parentID === undefined);
    record(
      "root-has-no-spawned-ancestry",
      "a root session reports role root",
      text(data.hostSession(parent.id)?.parentID ?? null),
      data.hostSession(parent.id)?.parentID === undefined,
    );

    const minted = "01a1f720-0000-7c00-8000-0000000000c1";
    const child = await ops.createSession({ id: minted, parentID: parent.id, title: "qa child" });
    record(
      "the-client-minted-id-is-adopted",
      "the host keeps the id the TUI minted",
      child.id,
      child.id === minted,
    );
    record(
      "the-child-row-carries-its-parent",
      "parentID is the host's spawned-by parent",
      String(child.parentID),
      child.parentID === parent.id,
    );
    record(
      "the-title-reaches-the-host",
      "the created session is named",
      String(child.title),
      child.title === "qa child",
    );

    const childRouting = routingById.get(minted);
    const state = childRouting === undefined ? {} : (dataOf(await host.ask("get_state", { sessionId: childRouting })) ?? {});
    const lifecycle = readLifecycle((state as Record<string, unknown>).lifecycle);
    record(
      "the-host-persisted-the-ancestry",
      "get_state.lifecycle names the child, its parent, root and task",
      text(lifecycle),
      lifecycle !== undefined &&
        lifecycle.role === "child" &&
        lifecycle.parentSessionId === parent.id &&
        lifecycle.rootSessionId === parent.id,
    );
    record(
      "the-pull-projects-ancestry-onto-the-row",
      "a fresh pull reads the same parent back",
      text(data.hostSession(minted)?.parentID ?? null),
      data.hostSession(minted)?.parentID === parent.id,
    );

    const fresh = new BridgeData();
    await pullHostState(host.transport, fresh, new SessionRegistry());
    const freshChild = fresh.hostSession(minted);
    record(
      "ancestry-survives-a-fresh-pull",
      "a new pull of the host lands the child with its parent",
      text(freshChild?.parentID ?? null),
      freshChild?.parentID === parent.id,
    );

    const badSpawn = await host.ask("open_session", {
      cwd: "/work",
      spawnedBy: { parentSessionId: parent.id, rootSessionId: "", taskId: "t" },
    });
    record(
      "a-malformed-spawned-by-is-refused",
      "invalid_spawned_by",
      text(badSpawn, 120),
      String((badSpawn as Record<string, unknown>).error ?? "") === "invalid_spawned_by",
    );

    let unknownParent = "";
    try {
      await ops.createSession({ parentID: "01a1f720-0000-7c00-8000-0000deadbeef" });
      unknownParent = "opened a session";
    } catch (error) {
      unknownParent = String(error).slice(0, 140);
    }
    record(
      "an-unknown-parent-is-refused-instead-of-becoming-a-root",
      "a refused create, not a silent root session",
      unknownParent,
      unknownParent.includes("never announced parent session"),
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    detail.push(...(await host.close()));
  }
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
