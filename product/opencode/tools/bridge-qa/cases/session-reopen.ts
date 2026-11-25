import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const store = path.join(context.out, "session-store.json");
  const registry = new SessionRegistry();
  const opened = registry.open({ persistentId: "p_controlled", history: ["u1", "a1"] });
  if (opened.kind !== "ok") throw new Error("open refused: " + opened.code);
  registry.markActive(opened.value);
  const parked = registry.park(opened.value);
  if (parked.kind !== "refused") throw new Error("park should refuse while active");
  registry.markActive(opened.value);
  const unloaded = registry.unload(opened.value);
  if (unloaded.kind !== "refused") throw new Error("unload should refuse while active");

  const idle = new SessionRegistry();
  const second = idle.open({ persistentId: "p_controlled", history: ["u1", "a1"] });
  if (second.kind !== "ok") throw new Error("second open refused");
  idle.park(second.value);
  const history = idle.history(second.value);
  if (history.kind !== "ok") throw new Error("history refused");
  fs.writeFileSync(store, JSON.stringify({ persistentId: "p_controlled", history: history.value }, null, 2), { mode: 0o600 });

  const restored = JSON.parse(fs.readFileSync(store, "utf8")) as { persistentId: string; history: string[] };
  const afterRestart = new SessionRegistry({
    knownPersistentIds: [restored.persistentId],
    historyByPersistentId: { [restored.persistentId]: restored.history },
  });
  const reopened = afterRestart.reopen(restored.persistentId);
  const reopenedHistory = reopened.kind === "ok" ? afterRestart.history(reopened.value) : reopened;

  const checks: Check[] = [
    {
      name: "parked-session-restores-history",
      expected: "u1,a1 after reopen",
      observed: reopenedHistory.kind === "ok" ? reopenedHistory.value.join(",") : "refused",
      pass: reopenedHistory.kind === "ok" && reopenedHistory.value.join(",") === "u1,a1",
    },
    {
      name: "handle-differs-from-persistent-id",
      expected: "a new handle per open",
      observed: reopened.kind === "ok" ? reopened.value : "refused",
      pass: reopened.kind === "ok" && reopened.value !== "p_controlled",
    },
    {
      name: "reopen-of-unknown-identity-refused",
      expected: "UNKNOWN_PERSISTENT_ID",
      observed: afterRestart.reopen("p_never_seen").kind === "refused" ? "UNKNOWN_PERSISTENT_ID" : "accepted",
      pass: afterRestart.reopen("p_never_seen").kind === "refused",
    },
  ];
  fs.unlinkSync(store);
  return { checks: checks, cleanup: { ok: !fs.existsSync(store), detail: ["session store removed"] } };
}
