import type { CaseContext, CaseResult, Check } from "../run.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const registry = new SessionRegistry();
  const opened = registry.open({ persistentId: "p_busy" });
  if (opened.kind !== "ok") throw new Error("open refused");
  registry.markActive(opened.value);

  const unload = registry.unload(opened.value);
  const attached = registry.attach(opened.value);
  const stillActive = attached.kind === "ok" && attached.value.state === "active";

  const checks: Check[] = [
    {
      name: "unload-refused-not-success",
      expected: "refused ACTIVE_TURN",
      observed: unload.kind === "refused" ? unload.code : "ok",
      pass: unload.kind === "refused" && unload.code === "ACTIVE_TURN",
    },
    {
      name: "session-not-moved-to-parked",
      expected: "state stays active",
      observed: attached.kind === "ok" ? attached.value.state : "unknown",
      pass: stillActive,
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["pure in-memory session, nothing to tear down"] } };
}
