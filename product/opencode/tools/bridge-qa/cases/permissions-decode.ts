import type { CaseContext, CaseResult, Check } from "../run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { decodeHostEvent, applyPermissionEvent } from "../../../packages/bridge-core/src/host-event.ts";

/**
 * The permission events the host publishes, taken through the same decoder the client uses.
 *
 * Scope: `decodeHostEvent` → `applyPermissionEvent` → store. No socket, because nothing in the isolated host
 * asks for permission through the launch path the bridge uses (measured: tools ran without a prompt even under
 * `permission-preset ask`).
 */
const SESSION = "ses-permissions-1";

function frame(type: string, data: Record<string, unknown>): unknown {
  return { id: "evt_" + type.replace(".", "_"), created: Date.now(), type: type, data: data };
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const data = new BridgeData();

  const asked = frame("permission.asked", {
    id: "per_1",
    sessionID: SESSION,
    action: "write",
    resources: ["/workspace/probe.txt"],
  });
  const askedDecode = decodeHostEvent(asked);
  const askedApplied = askedDecode.ok ? applyPermissionEvent(data, askedDecode.event) : false;
  const held = data.permissionsFor(SESSION);
  checks.push({
    name: "P-664-permission-list",
    expected: "a permission.asked frame reaches the store and reads back for its session",
    observed: askedDecode.ok ? held.map((request) => request.id).join(",") || "(none)" : "decode refused: " + askedDecode.reason,
    pass: askedDecode.ok && askedApplied && held.length === 1 && held[0].id === "per_1",
  });

  const replied = frame("permission.replied", { sessionID: SESSION, requestID: "per_1", reply: "once" });
  const repliedDecode = decodeHostEvent(replied);
  const repliedApplied = repliedDecode.ok ? applyPermissionEvent(data, repliedDecode.event) : false;
  checks.push({
    name: "P-666-permission-replied",
    expected: "permission.replied removes the request from the store",
    observed: repliedDecode.ok ? "remaining " + String(data.permissionsFor(SESSION).length) + " request(s)" : "decode refused: " + repliedDecode.reason,
    pass: repliedDecode.ok && repliedApplied && data.permissionsFor(SESSION).length === 0,
  });

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: ["no process or socket was created"] } };
}
