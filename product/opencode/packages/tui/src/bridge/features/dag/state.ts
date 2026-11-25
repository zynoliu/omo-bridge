import { createSignal } from "solid-js";
/**
 * The DAG ledger.
 *
 * The host publishes four separate channels and this module keeps them separate
 * (upstream/oh-my-openagent/packages/omo-senpi/src/components/task/dag-rpc-bridge.ts:28-42):
 *
 * - `omo.dag.event` is the sequenced ledger, exactly-once per `(runId, seq)`; a replay after a reopen
 *   can redeliver a seq and it must not be applied twice;
 * - `omo.dag.heartbeat` carries `{ schemaVersion, at, runs: [{ runId, headSeq }] }` and proves liveness
 *   only, never ledger content;
 * - `omo.dag.activity` is unsequenced telemetry and never becomes a ledger row;
 * - `omo.dag.updated` is a wholesale run-list replacement.
 *
 * `dag.stream.overflow` says the live queue dropped entries: normal application stops, the gap is read
 * back from history bounded by `recoverAfterSeq` (exclusive lower bound) and the overflow's own `seq`
 * (upper bound), then deduplicated by `(runId, seq)`. `droppedCount` is a count of evicted queue
 * entries, never a cursor. Source: upstream/oh-my-openagent/docs/reference/mass-ulw-protocol.md.
 */
export type DagEvent = {
  readonly runId: string;
  readonly seq: number;
  readonly payload: unknown;
};

export type DagRun = {
  readonly runId: string;
  readonly status: string;
  readonly raw: unknown;
};

export type DagGap = {
  /** Exclusive lower bound: entries with seq <= after are already held or must never be replayed. */
  readonly after: number;
  /** Inclusive upper bound, taken from the overflow event's own seq. */
  readonly through: number;
  /** The evicted-entry count the host reported; recorded, never used as a cursor. */
  readonly droppedCount: number;
};

export type DagApplyOutcome =
  | { readonly kind: "applied"; readonly event: DagEvent }
  | { readonly kind: "duplicate"; readonly event: DagEvent }
  | { readonly kind: "pending-gap"; readonly event: DagEvent; readonly gap: DagGap }
  | { readonly kind: "rejected"; readonly reason: string };

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value;
}

export function decodeDagEvent(raw: unknown): DagEvent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const runId = text(field(raw, "runId"));
  const seq = integer(field(raw, "seq"));
  if (runId === undefined || seq === undefined || seq < 1) return undefined;
  return { runId: runId, seq: seq, payload: raw };
}

export type DagLedger = {
  /** A reactive revision the view reads so a mutation redraws it. */
  readonly version: () => number;
  readonly events: (runId: string) => readonly DagEvent[];
  readonly head: (runId: string) => number;
  readonly gap: (runId: string) => DagGap | undefined;
  readonly heartbeatAt: () => string | null;
  readonly activity: () => readonly unknown[];
  readonly runs: () => readonly DagRun[];
  readonly applyEvent: (raw: unknown) => DagApplyOutcome;
  readonly applyHeartbeat: (raw: unknown) => boolean;
  readonly noteActivity: (raw: unknown) => void;
  readonly replaceRuns: (raw: unknown) => void;
  readonly applyOverflow: (raw: unknown) => DagGap | undefined;
  readonly applyHistoryPage: (runId: string, rawPage: unknown) => "filled" | "partial" | "rejected";
};

/**
 * The ledger holds one ordered list per run and never merges channels: a heartbeat refreshes liveness,
 * an activity note is telemetry, and only `omo.dag.event` rows (or a history page filling a gap) enter
 * the ordered list.
 */
export function createDagLedger(): DagLedger {
  const [revision, setRevision] = createSignal(0);
  const bump = () => setRevision((value: number) => value + 1);
  const order = new Map<string, DagEvent[]>();
  const heads = new Map<string, number>();
  const gaps = new Map<string, DagGap>();
  const notes: unknown[] = [];
  let runs: DagRun[] = [];
  let heartbeat: string | null = null;

  const insert = (event: DagEvent): "applied" | "duplicate" => {
    const list = order.get(event.runId) ?? [];
    if (list.some((held) => held.seq === event.seq)) return "duplicate";
    list.push(event);
    list.sort((a, b) => a.seq - b.seq);
    order.set(event.runId, list);
    const head = heads.get(event.runId) ?? 0;
    if (event.seq > head) heads.set(event.runId, event.seq);
    bump();
    return "applied";
  };

  return {
    version: () => revision(),
    events: (runId) => order.get(runId) ?? [],
    head: (runId) => heads.get(runId) ?? 0,
    gap: (runId) => gaps.get(runId),
    heartbeatAt: () => heartbeat,
    activity: () => notes,
    runs: () => runs,
    applyEvent(raw) {
      const event = decodeDagEvent(raw);
      if (event === undefined) return { kind: "rejected", reason: "the event has no string runId and positive integer seq" };
      const gap = gaps.get(event.runId);
      const headBefore = heads.get(event.runId) ?? 0;
      /* an event inside a known gap is held for history, unless it is behind the head and simply late */
      if (gap !== undefined && event.seq > headBefore && event.seq <= gap.through)
        return { kind: "pending-gap", event: event, gap: gap };
      const previousHead = heads.get(event.runId) ?? 0;
      const outcome = insert(event);
      if (outcome === "duplicate") return { kind: "duplicate", event: event };
      if (event.seq > previousHead + 1) {
        const opened: DagGap = { after: previousHead, through: event.seq - 1, droppedCount: 0 };
        gaps.set(event.runId, opened);
        return { kind: "pending-gap", event: event, gap: opened };
      }
      return { kind: "applied", event: event };
    },
    applyHeartbeat(raw) {
      if (typeof raw !== "object" || raw === null) return false;
      const at = text(field(raw, "at"));
      if (at === undefined) return false;
      heartbeat = at;
      bump();
      return true;
    },
    noteActivity(raw) {
      notes.push(raw);
      if (notes.length > 200) notes.shift();
      bump();
    },
    replaceRuns(raw) {
      if (!Array.isArray(raw)) return;
      const next: DagRun[] = [];
      for (const item of raw) {
        if (typeof item !== "object" || item === null) continue;
        const runId = text(field(item, "runId"));
        const status = text(field(item, "status"));
        if (runId === undefined || status === undefined) continue;
        next.push({ runId: runId, status: status, raw: item });
      }
      runs = next;
      bump();
    },
    applyOverflow(raw) {
      if (typeof raw !== "object" || raw === null) return undefined;
      const runId = text(field(raw, "runId"));
      const seq = integer(field(raw, "seq"));
      const recoverAfter = integer(field(raw, "recoverAfterSeq"));
      const dropped = integer(field(raw, "droppedCount"));
      if (runId === undefined || seq === undefined || recoverAfter === undefined) return undefined;
      const gap: DagGap = {
        after: recoverAfter,
        through: seq,
        droppedCount: dropped === undefined ? 0 : dropped,
      };
      gaps.set(runId, gap);
      bump();
      return gap;
    },
    applyHistoryPage(runId, rawPage) {
      if (!Array.isArray(rawPage)) return "rejected";
      let applied = 0;
      for (const item of rawPage) {
        const event = decodeDagEvent(item);
        if (event === undefined) return "rejected";
        if (event.runId !== runId) return "rejected";
        if (insert(event) === "applied") applied += 1;
      }
      const gap = gaps.get(runId);
      if (gap === undefined) return applied === 0 ? "partial" : "filled";
      const covered = everySeqHeld(order.get(runId) ?? [], gap.after + 1, gap.through);
      if (!covered) return "partial";
      gaps.delete(runId);
      bump();
      return "filled";
    },
  };
}

/** True when every seq in [from, through] is present; a hole means the gap is not closed yet. */
function everySeqHeld(list: readonly DagEvent[], from: number, through: number): boolean {
  for (let seq = from; seq <= through; seq += 1) {
    if (!list.some((held) => held.seq === seq)) return false;
  }
  return true;
}
