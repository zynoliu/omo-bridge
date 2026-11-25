export type DisconnectCause = "same_connection_overflow" | "client_disconnect" | "session_unload" | "host_restart";

export type RecoveryInput = {
  readonly cause: DisconnectCause;
  readonly supportsReset: boolean;
  readonly eventGap: boolean;
  readonly replyLost: boolean;
  readonly unconfirmedSideEffects: readonly string[];
  readonly pendingDialogIds: readonly string[];
  readonly heartbeatCapabilities: readonly string[] | null;
};

export type RecoveryDecision = {
  readonly cause: DisconnectCause;
  readonly eventResync: false | "reset" | "snapshot";
  readonly snapshotRequired: boolean;
  readonly resetToolArguments: boolean;
  readonly restorePendingDialogs: readonly string[];
  readonly heartbeatCapabilities: readonly string[] | null;
  readonly replyLost: boolean;
  readonly replaySideEffects: false;
  readonly userFacingError: string | null;
};

export const RECOVERABLE_UNCONFIRMED_SIDE_EFFECT = "RECOVERABLE_UNCONFIRMED_SIDE_EFFECT";

export function planRecovery(input: RecoveryInput): RecoveryDecision {
  const requiresSnapshot = input.cause === "host_restart" || input.cause === "session_unload";
  const gap = input.eventGap || requiresSnapshot;

  let eventResync: RecoveryDecision["eventResync"] = false;
  if (gap) {
    if (requiresSnapshot) eventResync = "snapshot";
    else if (input.supportsReset) eventResync = "reset";
    else eventResync = "snapshot";
  }

  const blockedByUnconfirmed = input.replyLost && input.unconfirmedSideEffects.length > 0;

  return {
    cause: input.cause,
    eventResync: eventResync,
    snapshotRequired: requiresSnapshot || eventResync === "snapshot",
    resetToolArguments: gap,
    restorePendingDialogs: gap ? input.pendingDialogIds : [],
    heartbeatCapabilities: input.heartbeatCapabilities,
    replyLost: input.replyLost,
    replaySideEffects: false,
    userFacingError: blockedByUnconfirmed ? RECOVERABLE_UNCONFIRMED_SIDE_EFFECT : null,
  };
}

export function assertNoSilentReplay(decision: RecoveryDecision, replayed: readonly string[]): void {
  if (replayed.length > 0 && decision.replaySideEffects === false) {
    throw new Error("unconfirmed side effects were replayed: " + replayed.join(","));
  }
}
