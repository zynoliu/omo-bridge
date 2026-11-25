import type { CaseContext, CaseResult, Check } from "../run.ts";
import { pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { readPermission } from "../../../packages/bridge-core/src/host-capabilities.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { dataOf, openLiveHost, text } from "./live-host.ts";

/**
 * P-668 against the real host: the approval state the host publishes is a preset with its source and
 * status, the pull records exactly that, and a preset change is one command. The client vocabulary's
 * `session.permissions` event is watched for and reported as absent, so the matrix row states what the
 * host really writes rather than what the client would like.
 */
export async function run(_context: CaseContext): Promise<CaseResult> {
  const host = await openLiveHost("bridge-permission-");
  if (host.kind === "blocked") {
    return { checks: [], cleanup: { ok: true, detail: [host.reason] }, blocked: true };
  }
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  const detail: string[] = [];
  const frameTypes = new Map<string, number>();
  const permissionEvents: string[] = [];
  try {
    host.data.subscribeEvents((frame) => {
      const type = typeof frame === "object" && frame !== null && "type" in frame ? String((frame as { type?: unknown }).type) : "unknown";
      frameTypes.set(type, (frameTypes.get(type) ?? 0) + 1);
      if (type === "session.permissions") permissionEvents.push(type);
    });

    const opened = await host.ask("open_session", { cwd: "/work" });
    const openedData = dataOf(opened) ?? {};
    const openedState = typeof openedData.state === "object" && openedData.state !== null ? (openedData.state as Record<string, unknown>) : {};
    const routing = String(openedData.sessionId ?? "");
    const durable = String(openedState.sessionId ?? "");
    const reported = readPermission(openedState);
    record(
      "the-host-publishes-a-preset-with-its-source",
      "permissionPreset, source, status and effective preset",
      text(reported),
      reported !== undefined && reported.source !== null && reported.status !== null,
    );

    const data = new BridgeData();
    await pullHostState(host.transport, data, new SessionRegistry());
    const pulled = data.hostPermissionFor(durable);
    record(
      "the-pull-records-what-the-host-reported",
      "the same four fields BridgeData holds",
      text(pulled),
      pulled !== undefined && pulled.preset === reported?.preset && pulled.source === reported?.source,
    );
    record(
      "full-access-is-the-only-preset-without-an-approval-boundary",
      "the TUI's autoaccept mapping is derived from the effective preset",
      String(reported?.effective),
      reported?.effective === "full-access" ? reported.preset === "full-access" : reported !== undefined,
    );

    const set = await host.ask("set_permission_preset", { sessionId: routing, permissionPreset: "ask" });
    const setData = dataOf(set) ?? {};
    record(
      "a-preset-change-names-the-command-and-its-source",
      "{permissionPreset: ask, source: client, status: applied}",
      text(setData),
      set.success === true && setData.permissionPreset === "ask" && setData.permissionPresetSource === "client",
    );
    const after = new BridgeData();
    await pullHostState(host.transport, after, new SessionRegistry());
    record(
      "the-new-preset-is-what-the-next-pull-reports",
      "ask / client / applied / ask",
      text(after.hostPermissionFor(durable)),
      after.hostPermissionFor(durable)?.preset === "ask" && after.hostPermissionFor(durable)?.effective === "ask",
    );

    const invalid = await host.ask("set_permission_preset", { sessionId: routing, permissionPreset: "yolo" });
    const unchanged = readPermission(dataOf(await host.ask("get_state", { sessionId: routing })) ?? {});
    record(
      "an-unknown-preset-changes-nothing",
      "invalid_launch_profile and the previous preset still enforced",
      text(invalid, 140) + " -> " + String(unchanged?.preset),
      String((invalid as Record<string, unknown>).errorCode ?? "") === "invalid_launch_profile" && unchanged?.preset === "ask",
    );

    record(
      "the-host-writes-no-session-permissions-event",
      "the client event this row was written against is absent from the stream",
      "session.permissions frames: " + String(permissionEvents.length) + "; stream types: " + [...frameTypes.keys()].join(","),
      permissionEvents.length === 0,
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    detail.push(...(await host.close()));
  }
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
