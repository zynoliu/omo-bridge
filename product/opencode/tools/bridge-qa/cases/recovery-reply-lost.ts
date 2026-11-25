import type { CaseContext, CaseResult, Check } from "../run.ts";
import { RECOVERABLE_UNCONFIRMED_SIDE_EFFECT, assertNoSilentReplay, planRecovery } from "../../../packages/bridge-core/src/recovery.ts";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const decision = planRecovery({
    cause: "client_disconnect",
    supportsReset: true,
    eventGap: true,
    replyLost: true,
    unconfirmedSideEffects: ["shell.exec"],
    pendingDialogIds: [],
    heartbeatCapabilities: null,
  });

  let replayGuard = "not raised";
  try {
    assertNoSilentReplay(decision, ["shell.exec"]);
  } catch (error) {
    replayGuard = error instanceof Error ? error.message : "raised";
  }

  const checks: Check[] = [
    {
      name: "unconfirmed-effect-not-replayed",
      expected: "replaySideEffects false",
      observed: String(decision.replaySideEffects),
      pass: decision.replaySideEffects === false,
    },
    {
      name: "recoverable-error-surfaced",
      expected: RECOVERABLE_UNCONFIRMED_SIDE_EFFECT,
      observed: String(decision.userFacingError),
      pass: decision.userFacingError === RECOVERABLE_UNCONFIRMED_SIDE_EFFECT,
    },
    {
      name: "silent-replay-is-refused",
      expected: "a raised guard",
      observed: replayGuard.slice(0, 60),
      pass: replayGuard.includes("unconfirmed side effects were replayed"),
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["no resources created"] } };
}
