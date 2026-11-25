import type { CaseContext, CaseResult, Check } from "../run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { decodeHostEvent, applyFormEvent } from "../../../packages/bridge-core/src/host-event.ts";

/**
 * The form events the host publishes, taken through the same decoder the client uses.
 *
 * Scope, stated so the checks are not read as more than they are: this drives `decodeHostEvent` and
 * `applyFormEvent` — the documented path from a frame to the store — but not a socket. No case can drive a
 * form over the transport yet, because nothing in the isolated host emits one without a tool the harness
 * cannot start.
 */
const SESSION = "ses-forms-1";

function formFrame(type: string, data: Record<string, unknown>): unknown {
  return { id: "evt_" + type.replace(".", "_"), created: Date.now(), type: type, data: data };
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const data = new BridgeData();

  const created = formFrame("form.created", {
    form: { id: "frm_1", sessionID: SESSION, title: "Deploy target", fields: [{ key: "target", type: "string", title: "Target" }] },
  });
  const createdDecode = decodeHostEvent(created);
  const createdApplied = createdDecode.ok ? applyFormEvent(data, createdDecode.event) : false;
  const held = data.formsFor(SESSION);
  checks.push({
    name: "P-674-form-list",
    expected: "a form.created frame reaches the store and reads back for its session",
    observed: createdDecode.ok ? held.map((form) => form.id).join(",") || "(none)" : "decode refused: " + createdDecode.reason,
    pass: createdDecode.ok && createdApplied && held.length === 1 && held[0].id === "frm_1",
  });

  const replied = formFrame("form.replied", { id: "frm_1", sessionID: SESSION, answer: { target: "Staging" } });
  const repliedDecode = decodeHostEvent(replied);
  const repliedApplied = repliedDecode.ok ? applyFormEvent(data, repliedDecode.event) : false;
  checks.push({
    name: "P-675-form-reply-resolves",
    expected: "form.replied removes the form from the store",
    observed: repliedDecode.ok ? "remaining " + String(data.formsFor(SESSION).length) + " form(s)" : "decode refused: " + repliedDecode.reason,
    pass: repliedDecode.ok && repliedApplied && data.formsFor(SESSION).length === 0,
  });

  const cancelled = formFrame("form.cancelled", { id: "frm_2", sessionID: SESSION });
  const cancelledDecode = decodeHostEvent(cancelled);
  const cancelledApplied = cancelledDecode.ok ? applyFormEvent(data, cancelledDecode.event) : false;
  checks.push({
    name: "P-675-form-cancel-accepted",
    expected: "form.cancelled is decoded and applied rather than ignored",
    observed: cancelledDecode.ok ? "applied=" + String(cancelledApplied) : "decode refused: " + cancelledDecode.reason,
    pass: cancelledDecode.ok && cancelledApplied,
  });

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: ["no process or socket was created"] } };
}
