import { describe, expect, test } from "bun:test";

import { RECOVERABLE_UNCONFIRMED_SIDE_EFFECT, planRecovery } from "../src/recovery.ts";

const BASE = {
  cause: "client_disconnect" as const,
  supportsReset: true,
  eventGap: true,
  replyLost: false,
  unconfirmedSideEffects: [],
  pendingDialogIds: [],
  heartbeatCapabilities: ["session.list", "tool.call"],
};

describe("planRecovery", () => {
  test("declares event_resync only when the implementation supports reset", () => {
    expect(planRecovery({ ...BASE }).eventResync).toBe("reset");
    expect(planRecovery({ ...BASE, supportsReset: false }).eventResync).toBe("snapshot");
    expect(planRecovery({ ...BASE, eventGap: false }).eventResync).toBe(false);
  });

  test("a host restart always requires a snapshot and resets tool arguments", () => {
    const decision = planRecovery({ ...BASE, cause: "host_restart", supportsReset: true });
    expect(decision.eventResync).toBe("snapshot");
    expect(decision.snapshotRequired).toBe(true);
    expect(decision.resetToolArguments).toBe(true);
  });

  test("a session unload restores pending dialogs while a clean disconnect does not", () => {
    expect(planRecovery({ ...BASE, cause: "session_unload", pendingDialogIds: ["d1"] }).restorePendingDialogs).toEqual([
      "d1",
    ]);
    expect(planRecovery({ ...BASE, eventGap: false, pendingDialogIds: ["d1"] }).restorePendingDialogs).toEqual([]);
  });

  test("a lost reply with an unconfirmed side effect is surfaced and never replayed", () => {
    const decision = planRecovery({ ...BASE, replyLost: true, unconfirmedSideEffects: ["shell.exec"] });
    expect(decision.replaySideEffects).toBe(false);
    expect(decision.userFacingError).toBe(RECOVERABLE_UNCONFIRMED_SIDE_EFFECT);
  });

  test("a lost reply without unconfirmed effects needs no blocking error", () => {
    const decision = planRecovery({ ...BASE, replyLost: true });
    expect(decision.userFacingError).toBeNull();
    expect(decision.replaySideEffects).toBe(false);
  });

  test("an incomplete heartbeat capability list is passed through as null, not invented", () => {
    expect(planRecovery({ ...BASE, heartbeatCapabilities: null }).heartbeatCapabilities).toBeNull();
  });

  test("same connection overflow keeps the connection and only resyncs events", () => {
    const decision = planRecovery({ ...BASE, cause: "same_connection_overflow" });
    expect(decision.snapshotRequired).toBe(false);
    expect(decision.eventResync).toBe("reset");
  });
});
