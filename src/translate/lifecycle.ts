import type { EventSink, OpenCodeEvent, TranslateContext } from "./types";

// Projects senpi's run-level frames onto the opencode session events the TUI derives busy/idle,
// usage totals and compaction rows from.
//
// Boundaries:
// - `stream.ts` owns per-message step/text/reasoning events. This projector reads `message_start`
//   only to remember the assistant id and model, and `message_end` only for its usage. Usage is
//   summed per run and emitted once at `agent_end`, never per message.
// - `agent_start` opens a run; `turn_start` opens one only for engines that omit `agent_start`.
//   A duplicate start inside one run is ignored.
// - `compaction_end` may arrive without a `compaction_start` (a reattach), so its own reason wins
//   and the tracked start reason is the fallback.
// - Unknown frames are counted in `stats.ignored`; no frame shape may throw.

export type LifecycleProjectorStats = {
  ignored: number;
};

export type LifecycleProjector = {
  handle: (event: unknown) => void;
  readonly stats: LifecycleProjectorStats;
};

type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

type UsageTotals = {
  cost: number;
  tokens: TokenTotals;
};

type ModelRef = { id: string; providerID: string };
type CompactionReason = "auto" | "manual";
type InterruptReason = "user" | "shutdown" | "superseded" | "inactivity";

// senpi abort sources are `user`, `system` and `provider`; a session replacement arrives as an
// `abortCause`. The opencode vocabulary has four reasons, so a non-user host stop is reported as
// `shutdown` (the process/host stopped the run) and a raw deadline marker as `inactivity`.
const INTERRUPT_REASONS: Record<string, InterruptReason> = {
  user: "user",
  system: "shutdown",
  provider: "shutdown",
  shutdown: "shutdown",
  host_shutdown: "shutdown",
  superseded: "superseded",
  session_replaced: "superseded",
  replaced: "superseded",
  inactivity: "inactivity",
  deadline: "inactivity",
  idle: "inactivity",
};

// Frames the bridge forwards but this projector has no work for. A frame outside this set and
// outside the handled types is the only kind counted as unknown.
const PASSIVE_FRAMES = new Set([
  "agent_settled",
  "auto_retry_end",
  "auto_retry_start",
  "extension_ui_request",
  "host_memory_pressure",
  "host_shutdown",
  "host_stalled",
  "host_superseded",
  "message_update",
  "model_changed",
  "queue_update",
  "session_closed",
  "session_error",
  "session_info_changed",
  "session_opened",
  "session_released",
  "session_replaced",
  "session_shutdown",
  "tool_execution_end",
  "tool_execution_start",
  "tool_execution_update",
  "turn_end",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function emptyUsage(): UsageTotals {
  return { cost: 0, tokens: emptyTokens() };
}

function readUsage(value: unknown): UsageTotals | undefined {
  const usage = asRecord(value);
  if (usage === undefined) return undefined;
  const cost = asRecord(usage.cost);
  return {
    cost: numberOrZero(cost?.total),
    tokens: {
      input: numberOrZero(usage.input),
      output: numberOrZero(usage.output),
      reasoning: numberOrZero(usage.reasoning),
      cache: { read: numberOrZero(usage.cacheRead), write: numberOrZero(usage.cacheWrite) },
    },
  };
}

function addUsage(into: UsageTotals, usage: UsageTotals): void {
  into.cost += usage.cost;
  into.tokens.input += usage.tokens.input;
  into.tokens.output += usage.tokens.output;
  into.tokens.reasoning += usage.tokens.reasoning;
  into.tokens.cache.read += usage.tokens.cache.read;
  into.tokens.cache.write += usage.tokens.cache.write;
}

function modelRef(value: unknown): ModelRef | undefined {
  const record = asRecord(value);
  if (record !== undefined) {
    const id = asNonEmptyString(record.id);
    const providerID = asNonEmptyString(record.providerID) ?? asNonEmptyString(record.provider);
    return id === undefined || providerID === undefined ? undefined : { id, providerID };
  }
  const text = asNonEmptyString(value);
  if (text === undefined) return undefined;
  const slash = text.indexOf("/");
  if (slash <= 0 || slash === text.length - 1) return undefined;
  return { id: text.slice(slash + 1), providerID: text.slice(0, slash) };
}

function compactionReason(value: unknown): CompactionReason {
  // senpi reports `manual`, `threshold` and `overflow`; only `manual` is user-initiated.
  return asNonEmptyString(value)?.toLowerCase() === "manual" ? "manual" : "auto";
}

function interruptReason(record: Record<string, unknown>): InterruptReason {
  const causeKind = asNonEmptyString(asRecord(record.abortCause)?.kind)?.toLowerCase();
  if (causeKind !== undefined) {
    const mapped = INTERRUPT_REASONS[causeKind];
    if (mapped !== undefined) return mapped;
  }
  const source = asNonEmptyString(record.abortSource)?.toLowerCase();
  return source === undefined ? "user" : (INTERRUPT_REASONS[source] ?? "user");
}

function failureError(failure: Record<string, unknown>): Record<string, unknown> {
  const type = asNonEmptyString(failure.category) ?? "unknown";
  const message = asNonEmptyString(failure.reason) ?? asNonEmptyString(failure.message) ?? "the run failed";
  const httpStatus = failure.httpStatus;
  const status =
    typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? httpStatus
      : undefined;
  // The host's failure carries the provider attribution (describeProviderFailure): keeping it on the
  // event is what tells a provider fault apart from a bridge bug. Absent fields stay absent so the
  // event shape does not lie about what the host said.
  const provider = asNonEmptyString(failure.provider);
  const model = asNonEmptyString(failure.model);
  const code = asNonEmptyString(failure.code);
  const resetsAt =
    typeof failure.resetsAt === "number" && Number.isFinite(failure.resetsAt) ? failure.resetsAt : undefined;
  const action = asNonEmptyString(failure.action);
  return {
    type,
    message,
    ...(status === undefined ? {} : { status }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(code === undefined ? {} : { code }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(action === undefined ? {} : { action }),
  };
}

/**
 * The one line a failed run writes to the bridge's log. `bridge.log` is the bridge's stderr, so this
 * is how an operator (or the QA evidence) sees the host's attribution without reading the SSE stream.
 */
function failureLogLine(sessionID: string, error: Record<string, unknown>): string {
  const parts = [`omo-bridge: session.execution.failed sessionID=${sessionID}`];
  for (const key of ["type", "provider", "model", "code", "status", "resetsAt"] as const) {
    if (error[key] !== undefined) parts.push(`${key}=${String(error[key])}`);
  }
  if (error.action !== undefined) parts.push(`action=${JSON.stringify(error.action)}`);
  parts.push(`message=${JSON.stringify(error.message)}`);
  return parts.join(" ");
}

export type LifecycleProjectorOptions = {
  /** Sink for the failure attribution line; the bridge process's stderr (its log) by default. */
  log?: (message: string) => void;
};

export function createLifecycleProjector(
  ctx: TranslateContext,
  sink: EventSink = () => {},
  options: LifecycleProjectorOptions = {},
): LifecycleProjector {
  const log = options.log ?? ((message: string): void => console.warn(message));
  const stats: LifecycleProjectorStats = { ignored: 0 };
  let active = false;
  let usageSeen = false;
  let usage: UsageTotals = emptyUsage();
  let assistantMessageID: string | undefined;
  let model: ModelRef | undefined;
  let pendingCompaction: CompactionReason | undefined;

  const ignore = (): void => {
    stats.ignored += 1;
  };

  const emit = (type: string, data: Record<string, unknown>): void => {
    const event: OpenCodeEvent = { id: ctx.nextID(), type, created: ctx.now(), data };
    sink(event);
  };

  const startRun = (): void => {
    if (active) return;
    active = true;
    usageSeen = false;
    usage = emptyUsage();
    assistantMessageID = undefined;
    emit("session.execution.started", { sessionID: ctx.sessionID });
  };

  const handleTurnStart = (): void => {
    if (!active) {
      startRun();
      return;
    }
    emit("session.step.streamed", {
      sessionID: ctx.sessionID,
      ...(assistantMessageID === undefined ? {} : { assistantMessageID }),
    });
  };

  const handleMessageStart = (record: Record<string, unknown>): void => {
    const message = asRecord(record.message);
    if (message?.role !== "assistant") return;
    assistantMessageID = asNonEmptyString(message.id) ?? assistantMessageID;
    model = modelRef({ id: asNonEmptyString(message.model), providerID: asNonEmptyString(message.provider) }) ?? model;
  };

  const handleMessageEnd = (record: Record<string, unknown>): void => {
    const message = asRecord(record.message);
    if (message?.role === "assistant") assistantMessageID = asNonEmptyString(message.id) ?? assistantMessageID;
    if (!active) return;
    const messageUsage = readUsage(message?.usage) ?? readUsage(record.usage);
    if (messageUsage === undefined) return;
    usageSeen = true;
    addUsage(usage, messageUsage);
  };

  const handleAgentEnd = (record: Record<string, unknown>): void => {
    if (!active) return;
    active = false;
    if (usageSeen) {
      emit("session.usage.updated", {
        sessionID: ctx.sessionID,
        cost: usage.cost,
        tokens: usage.tokens,
      });
    }
    const failure = asRecord(record.failure);
    if (record.aborted === true) {
      emit("session.execution.interrupted", { sessionID: ctx.sessionID, reason: interruptReason(record) });
    } else if (failure !== undefined) {
      const error = failureError(failure);
      emit("session.execution.failed", { sessionID: ctx.sessionID, error });
      log(failureLogLine(ctx.sessionID, error));
    } else {
      emit("session.execution.succeeded", { sessionID: ctx.sessionID });
    }
    usageSeen = false;
    usage = emptyUsage();
    assistantMessageID = undefined;
  };

  const handleCompactionStart = (record: Record<string, unknown>): void => {
    const reason = compactionReason(record.reason);
    pendingCompaction = reason;
    emit("session.compaction.started", { sessionID: ctx.sessionID, reason });
  };

  const handleCompactionEnd = (record: Record<string, unknown>): void => {
    const reason = compactionReason(record.reason ?? pendingCompaction);
    const result = asRecord(record.result);
    const resultUsage = readUsage(result?.usage);
    const compactionModel = modelRef(record.model) ?? modelRef(result?.model) ?? model;
    // native is a provider record (Session.Message.Native), never a flag: forward a real record
    // and omit the optional field otherwise, or the TUI schema decode rejects the event.
    const native = asRecord(record.native) ?? asRecord(result?.native);
    emit("session.compaction.ended", {
      sessionID: ctx.sessionID,
      reason,
      ...(compactionModel === undefined ? {} : { model: compactionModel }),
      ...(native === undefined ? {} : { native }),
      text: asString(result?.summary) ?? asString(record.text) ?? "",
      cost: resultUsage?.cost ?? numberOrZero(record.cost),
      tokens: resultUsage?.tokens ?? emptyTokens(),
    });
    pendingCompaction = undefined;
  };

  const handle = (event: unknown): void => {
    const record = asRecord(event);
    const type = asString(record?.type);
    if (record === undefined || type === undefined) {
      ignore();
      return;
    }
    if (type === "agent_start") {
      startRun();
      return;
    }
    if (type === "turn_start") {
      handleTurnStart();
      return;
    }
    if (type === "agent_end") {
      handleAgentEnd(record);
      return;
    }
    if (type === "message_start") {
      handleMessageStart(record);
      return;
    }
    if (type === "message_end") {
      handleMessageEnd(record);
      return;
    }
    if (type === "compaction_start") {
      handleCompactionStart(record);
      return;
    }
    if (type === "compaction_end") {
      handleCompactionEnd(record);
      return;
    }
    if (!PASSIVE_FRAMES.has(type)) ignore();
  };

  return { handle, stats };
}
