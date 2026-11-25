import { describe, expect, test } from "bun:test";

import { createDagLedger } from "../../src/bridge/features/dag/state.ts";

describe("dag ledger", () => {
  test("one run applies each seq exactly once, even when the host replays it", () => {
    const ledger = createDagLedger();
    expect(ledger.applyEvent({ runId: "run-1", seq: 1 }).kind).toBe("applied");
    expect(ledger.applyEvent({ runId: "run-1", seq: 1 }).kind).toBe("duplicate");
    expect(ledger.applyEvent({ runId: "run-1", seq: 2 }).kind).toBe("applied");
    expect(ledger.events("run-1").map((event) => event.seq)).toEqual([1, 2]);
    expect(ledger.head("run-1")).toBe(2);
  });

  test("events are kept in seq order even when they arrive out of order", () => {
    const ledger = createDagLedger();
    ledger.applyEvent({ runId: "run-1", seq: 3 });
    ledger.applyEvent({ runId: "run-1", seq: 1 });
    expect(ledger.events("run-1").map((event) => event.seq)).toEqual([1, 3]);
  });

  test("two runs never share a ledger", () => {
    const ledger = createDagLedger();
    ledger.applyEvent({ runId: "a", seq: 1 });
    ledger.applyEvent({ runId: "b", seq: 1 });
    expect(ledger.events("a")).toHaveLength(1);
    expect(ledger.events("b")).toHaveLength(1);
  });

  test("heartbeat proves liveness only and never becomes a ledger row", () => {
    const ledger = createDagLedger();
    expect(ledger.applyHeartbeat({ schemaVersion: 1, at: "2026-11-18T00:00:00Z", runs: [{ runId: "run-1", headSeq: 1 }] })).toBe(true);
    expect(ledger.heartbeatAt()).toBe("2026-11-18T00:00:00Z");
    expect(ledger.events("run-1")).toHaveLength(0);
    expect(ledger.applyHeartbeat({ runs: [] })).toBe(false);
  });

  test("activity is telemetry and stays out of the ledger", () => {
    const ledger = createDagLedger();
    ledger.noteActivity({ runId: "run-1", kind: "progress" });
    expect(ledger.activity()).toHaveLength(1);
    expect(ledger.events("run-1")).toHaveLength(0);
  });

  test("an updated payload replaces the run list wholesale and skips unusable rows", () => {
    const ledger = createDagLedger();
    ledger.replaceRuns([{ runId: "run-1", status: "running" }, { runId: "run-2" }, "junk"]);
    expect(ledger.runs().map((run) => run.runId + ":" + run.status)).toEqual(["run-1:running"]);
    ledger.replaceRuns([{ runId: "run-3", status: "completed" }]);
    expect(ledger.runs().map((run) => run.runId)).toEqual(["run-3"]);
  });

  test("an overflow stops normal application until history closes the gap without duplicates or holes", () => {
    const ledger = createDagLedger();
    ledger.applyEvent({ runId: "run-1", seq: 1 });
    const gap = ledger.applyOverflow({ runId: "run-1", seq: 5, recoverAfterSeq: 1, droppedCount: 3 });
    expect(gap).toEqual({ after: 1, through: 5, droppedCount: 3 });

    const held = ledger.applyEvent({ runId: "run-1", seq: 4 });
    expect(held.kind).toBe("pending-gap");

    const first = ledger.applyHistoryPage("run-1", [{ runId: "run-1", seq: 2 }, { runId: "run-1", seq: 3 }]);
    expect(first).toBe("partial");
    expect(ledger.gap("run-1")).toBeDefined();

    const second = ledger.applyHistoryPage("run-1", [
      { runId: "run-1", seq: 4 },
      { runId: "run-1", seq: 5 },
      { runId: "run-1", seq: 3 },
    ]);
    expect(second).toBe("filled");
    expect(ledger.gap("run-1")).toBeUndefined();
    expect(ledger.events("run-1").map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("a history page for another run or a malformed row is rejected", () => {
    const ledger = createDagLedger();
    ledger.applyOverflow({ runId: "run-1", seq: 3, recoverAfterSeq: 1 });
    expect(ledger.applyHistoryPage("run-1", [{ runId: "other", seq: 2 }])).toBe("rejected");
    expect(ledger.applyHistoryPage("run-1", ["junk"])).toBe("rejected");
  });

  test("a sequence hole without an overflow opens a gap instead of pretending the data is complete", () => {
    const ledger = createDagLedger();
    ledger.applyEvent({ runId: "run-1", seq: 1 });
    const outcome = ledger.applyEvent({ runId: "run-1", seq: 4 });
    expect(outcome.kind).toBe("pending-gap");
    expect(ledger.gap("run-1")).toEqual({ after: 1, through: 3, droppedCount: 0 });
  });
});
