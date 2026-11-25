import type { LocationRef, OpenCodeEvent } from "@opencode/client";
import { Result, Schema, SchemaIssue, SchemaParser } from "../../schema/node_modules/effect/dist/index.js";
import { BridgeIdScheme } from "./id-scheme.ts";
import { EventManifest } from "../../schema/src/event-manifest.ts";

/**
 * Projects the frames the bridge launcher receives into the client event vocabulary, so an
 * `event.subscribe()` subscriber sees host activity instead of only the connection handshake.
 *
 * Inputs and their sources:
 *
 * - stream frames (`{ kind }`) are the cumulative frames `stream.ts` projects into the message view;
 * - `session_status`, `session_opened`, `session_closed`, `agent_start` and `agent_idle` are the
 *   host's lifecycle records (`upstream/senpi/packages/coding-agent/docs/rpc.md`, "Session status
 *   stream" and "Event Types");
 * - `extension_ui_request` / `extension_ui_response` are the dialog sub-protocol, and
 *   `question_resolved` its terminal outcome (`spec/host-frame-vocabulary.md`, citing
 *   `rpc-question-types.ts` and `rpc.md`).
 *
 * The host's live event records (`docs/rpc.md` "Event Types") are projected as the fork's own events:
 *
 * | host frame | client event |
 * | --- | --- |
 * | `turn_start` / `turn_end` | `session.step.started` / `session.step.ended` |
 * | `turn_end` outcome | `session.execution.succeeded`, `.interrupted` (`reason: "user"`) when the message was aborted |
 * | `compaction_start` / `compaction_end` | `session.compaction.started` / `.delta` / `.ended` (`failed` when aborted) |
 * | `message_start`, `message_update` (`assistantMessageEvent`) | `session.text.*` and `session.reasoning.*` block events |
 * | `message_end`, `entry_appended` | the authoritative `session.text.ended` / `session.reasoning.ended` for that message |
 * | `entry_appended` with an assistant message | `session.message.content.updated` carrying the entry's message id and its text/reasoning parts |
 * | `tool_execution_start` | `session.tool.input.started`, `.input.ended`, `session.tool.called` |
 * | `tool_execution_update` | `session.tool.progress` |
 * | `tool_execution_end` | `session.tool.success` when `isError` is false, `session.tool.failed` when true |
 * | `queue_update` / `pending_input_update` | `session.inbox.enqueued` / `.delivered` / `.cancelled` / `.delivery.changed` |
 * | `extension_event` | `agent.custom.<name>`, and `rpc.extension.<name>` for consumers already on the fork's extension channel |
 * | `loaded_surfaces_changed` | `mcp.tools.changed`, and `mcp.status.changed` whose catalogue resync is the substitute's |
 *
 * The wire `turn_end` record is the agent's own (`upstream/senpi/packages/agent/src/types.ts`,
 * `{ type: "turn_end", message, toolResults }`), and it carries no outcome field. The host computes
 * its own turn outcome from `message.stopReason` (`core/agent-session.ts`,
 * `_dispatchTurnEndBoundary`), so the bridge reads the same field: `"aborted"` is a user abort, every
 * other stop reason is a completed turn, and an `"error"` stop is left to the retry failure records
 * (`auto_retry_end` -> `session.execution.failed`). The frame carries no abort provenance, so an abort
 * is reported as `reason: "user"` whatever stopped the turn (recorded under Unknowns in the spec).
 *
 * Three wanted event names were not in this fork's client stream manifest
 * (`packages/schema/src/event-manifest.ts`, `EventManifest.ServerDefinitions`). The manifest now carries
 * all three: `session.message.content.updated` moved into `SessionEvent.Definitions` (it was replay-only),
 * `McpEvent.ToolsChanged` joined the server stream, and `agent.custom.<name>` was added as a templated
 * member beside the literal definitions (`AgentCustomEvent.Definition`). The substitutes the projector
 * used to rely on keep travelling next to each new event -- `session.text.ended`/
 * `session.reasoning.ended` beside a content update, `mcp.status.changed` beside a catalogue change,
 * `rpc.extension.<name>` beside an extension event -- so a consumer on the older member does not break.
 *
 * Frames that are NOT projected, because the host has no such frame:
 *
 * - `permission.asked` / `permission.replied` and `form.created` / `form.replied` / `form.cancelled`
 *   are OpenCode-schema events this host never writes; they are synthesized from the dialog frames
 *   that do travel (`spec/host-frame-vocabulary.md`). Because nothing upstream validated them, each
 *   is published only when the client's own definition accepts its data: the client brands its ids
 *   (`per_`, `frm_`), and a form answer that leaves a `required` field empty is refused in the shape
 *   the client schema uses (`FormInvalidAnswerError`) instead of settling the form.
 * - `message.updated` and `message.part.updated` do not exist in this fork's event union. A
 *   cumulative `partial` frame is therefore projected as block events: `session.reasoning.delta` and
 *   `session.text.delta` carrying the appended suffix, with a block `started`/`ended` pair when the new
 *   text is not an extension of the previous one (a rewrite needs a new block to stay appending-safe).
 *   `message_end` ends the open block with the authoritative final text.
 * - `session_parked` and `session_replaced` are counted as unprojectable. A parked handle is not a
 *   deletion, and a replaced routing id keeps the same session.
 * - A session known only from a pull (`get_state` / `get_messages`) cannot be projected: those are
 *   responses, not frames. The launcher publishes the `session_status` records the subscription
 *   snapshot carried, which is the same lifecycle record.
 * - A frame type this file does not know is counted as ignored and never thrown: an unfamiliar record
 *   must not stop the stream.
 *
 * Identity fields the client union requires but a host frame does not carry are derived once, here:
 *
 * - event `id` is `bridge-<n>`, monotonic across the projector: `emit` allocates it in the order the
 *   events are emitted, so a subscriber never sees a later id before an earlier one. Host records
 *   carry no id (`rpc.md`: "Events do not generally include an `id` field"), so it is a bridge id and
 *   a consumer must not derive message identity from it.
 * - `session.created` needs `projectID`, `slug` and `version`; the host frame carries none, so
 *   `projectID` and `slug` are the durable session id and `version` is `"bridge"`.
 * - `assistantMessageID` and `messageID` are minted through `id-scheme.ts` rather than reused from the
 *   frame: the client brands every one of them (`SessionMessage.ID`) and the official host publishes no
 *   id on any live message record at all (measured: `message_start`, `message_update`, `message_end`,
 *   `turn_start` and `turn_end` carry none). An `entry_appended` entry id mints the same id the pulled
 *   transcript carries for that row, so a live `session.message.content.updated` names a message the
 *   transcript also has; a message the host has not named yet is minted from the bridge's per-session
 *   ordinal, client-shaped and distinct per message. The host entry id travels in `metadata.hostEntryID`
 *   where a frame carries one, never as an id.
 * - `session.step.started` needs an `agent` and a `model`; a `turn_start` record carries neither, so a
 *   frame or embedded-message value is used when present and `"bridge"` / `{ id: "bridge", providerID:
 *   "bridge" }` stand in otherwise -- the same declared-bridge-identity rule as `version: "bridge"`.
 * - A projected inbox item has no host id on a `queue_update` (its queue holds text), so the bridge
 *   mints one `msg_bridge_inbox_<n>` id per queued text and reuses it for that text's later delivery
 *   or cancellation.
 * - A frame with no `sessionId` routes to the only session seen so far; with none or several, it is
 *   ignored rather than attached to an arbitrary session. `extension_event` is the exception: it is
 *   routed by its documented `sessionId` only, and an unknown id leaves the event unattached rather
 *   than minting a session (`rpc.md`, "extension_event").
 */

export type HostProjectionStats = {
  readonly projected: number;
  readonly ignored: number;
  readonly ignoredReasons: readonly string[];
};

export type HostProjectionOptions = {
  /** The location every projected event carries; host frames carry none. */
  readonly location: LocationRef;
  /** Epoch milliseconds for synthetic timestamps; injected so a test is deterministic. */
  readonly now?: () => number;
  /**
   * The client's identity scheme. The shipping stream passes the bridge's own (`BridgeData.ids`), so a
   * live message and the same message pulled from the host mint one id; a projection with no scheme
   * still mints through its own, because the client accepts no other shape.
   */
  readonly ids?: BridgeIdScheme;
};

type Frame = Record<string, unknown>;

const PERMISSION_TITLE_PREFIX = "Permission required:";

/**
 * The client brands the ids it publishes (`Permission.ID` starts `per_`, `Form.ID` starts `frm_`), so a
 * host request id travels as the suffix of a client id instead of being reused verbatim.
 */
const PERMISSION_ID_PREFIX = "per_";
const FORM_ID_PREFIX = "frm_";

function clientIdOf(prefix: string, hostId: string): string {
  return hostId.startsWith(prefix) ? hostId : prefix + hostId;
}

const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * The client schema's verdict on one synthesized dialog event, as the reason a consumer validating the
 * same definition would report. A synthesized event the client would refuse is never published: the
 * dialog frames carry no OpenCode event of their own to fall back on.
 */
function dataRejection(type: string, data: Frame): string | undefined {
  const definition = EventManifest.Server.get(type);
  if (definition === undefined) return "the client event manifest has no definition for " + type;
  const decoded = SchemaParser.decodeUnknownResult(Schema.toEncoded(definition.data))(data);
  return Result.isSuccess(decoded) ? undefined : formatIssue(decoded.failure);
}

const PERMISSION_REPLIES: Readonly<Record<string, "once" | "always" | "reject">> = {
  "Allow once": "once",
  "Always allow": "always",
  "Allow always": "always",
  Deny: "reject",
  "Deny with feedback": "reject",
};

const MESSAGE_KINDS = new Set(["prompt_started", "partial", "message_end", "tool_call", "tool_result", "agent_idle"]);

type SessionState = {
  readonly durableId: string;
  routingId: string | undefined;
  messageId: string;
  /** How many bridge-minted message ids this session has produced, so none of them repeats. */
  streamOrdinal: number;
  announced: boolean;
  /** The last `queue_update` snapshot, keyed by the queued text. */
  queue: Map<string, Delivery>;
  /** The bridge inbox id minted for a queued text, so its delivery or cancellation can name it. */
  inboxIds: Map<string, string>;
};

/** `hostId` is the frame id an answer correlates by; `clientId` is the branded id events carry. */
type PendingPermission = {
  readonly hostId: string;
  readonly clientId: string;
  readonly sessionId: string;
};

type PendingForm = {
  /** The host's question `requestId`: what `question_resolved` names. */
  readonly requestId: string;
  readonly dialogId: string;
  readonly clientId: string;
  readonly sessionId: string;
  readonly questionIds: readonly string[];
  /** Field keys whose host question declared `required`, enforced on the answer. */
  readonly requiredKeys: readonly string[];
};

type MessageState = {
  messageId: string;
  /** Whether an event already went out under `messageId`; a message that starts again then gets a new one. */
  used: boolean;
  text: string;
  thinking: string;
  textOrdinal: number;
  reasoningOrdinal: number;
  textOpen: boolean;
  reasoningOpen: boolean;
};

function asRecord(value: unknown): Frame | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Frame;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A queue's delivery: steering text is applied now, follow-up text waits for the turn to end. */
type Delivery = "steer" | "queue";

type Finish = "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown";
const FINISH_REASONS = new Set<string>(["stop", "length", "tool-calls", "content-filter", "error", "unknown"]);

type ModelRefShape = { readonly id: string; readonly providerID: string; readonly variant?: string };

type TokenShape = {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
};

function stringArrayOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The plain text a host result carries: a string, or the text parts of a `{ content }` record. */
function contentTextOf(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  if (record === undefined) return "";
  const direct = textOf(record.text) ?? textOf(record.summary) ?? textOf(record.output);
  if (direct !== undefined) return direct;
  if (!Array.isArray(record.content)) return "";
  return record.content
    .flatMap((part) => {
      const text = textOf(asRecord(part)?.text);
      return text === undefined ? [] : [text];
    })
    .join("\n");
}

function zeroTokens(): TokenShape {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function tokensOf(value: unknown): TokenShape {
  const record = asRecord(value);
  if (record === undefined) return zeroTokens();
  const cache = asRecord(record.cache);
  return {
    input: numberOr(record.input, 0),
    output: numberOr(record.output, 0),
    reasoning: numberOr(record.reasoning, 0),
    cache: { read: numberOr(cache?.read, 0), write: numberOr(cache?.write, 0) },
  };
}

function modelOf(value: unknown): ModelRefShape | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = textOf(record.id);
  const providerID = textOf(record.providerID) ?? textOf(record.providerId) ?? textOf(record.provider);
  if (id === undefined || providerID === undefined) return undefined;
  const variant = textOf(record.variant);
  return { id: id, providerID: providerID, ...(variant === undefined ? {} : { variant: variant }) };
}

/** The client's finish vocabulary, from the host's provider-facing one. */
function finishOf(value: unknown): Finish {
  const finish = textOf(value);
  if (finish === "tool_use" || finish === "tool-use" || finish === "tool_calls") return "tool-calls";
  if (finish === "max_tokens" || finish === "max-tokens") return "length";
  if (finish === "end_turn") return "stop";
  return finish !== undefined && FINISH_REASONS.has(finish) ? (finish as Finish) : "stop";
}

/**
 * How a `turn_end` ended, read from the stop reason the wire record carries: the agent's own
 * `turn_end` message (`message.stopReason`, the field the host's boundary dispatch reads) with the
 * already-declared top-level `stopReason` as the declared-vocabulary fallback. A record that names no
 * reason still ends a turn, so it counts as completed.
 */
function turnOutcomeOf(frame: Frame): "completed" | "aborted" | "error" {
  const reason = textOf(asRecord(frame.message)?.stopReason) ?? textOf(frame.stopReason);
  if (reason === "aborted") return "aborted";
  if (reason === "error") return "error";
  return "completed";
}

/**
 * The fork's `rpc.<id>.<name>` channel is its extension-event surface; only the extension name is
 * dynamic, so the literal prefix keeps the derived type inside that template.
 */
function rpcEventType(name: string): `rpc.${string}` {
  return `rpc.extension.${name}` as `rpc.${string}`;
}

/** The extension surface's per-name event; the name is its dynamic suffix (`agent.custom.<name>`). */
function agentCustomType(name: string): `agent.custom.${string}` {
  return `agent.custom.${name}` as `agent.custom.${string}`;
}

/**
 * A projected event before `emit` stamps its id. Event builders leave `id` off, and `emit` is the
 * single place an id is allocated: the number an event carries is its emission position, whatever
 * order its fields were built in.
 */
type WithoutId<Type> = Type extends unknown ? Omit<Type, "id"> : never;
type PendingEvent = WithoutId<OpenCodeEvent>;

function eventOf<Type extends PendingEvent["type"]>(event: Extract<PendingEvent, { type: Type }>): PendingEvent {
  return event;
}

function statusOf(value: unknown): { type: "busy" } | { type: "idle" } {
  const status = typeof value === "string" ? value : "";
  if (status === "running" || status === "compacting" || status === "waiting_input" || status === "opening") return { type: "busy" };
  return { type: "idle" };
}

export class HostEventProjector {
  private readonly location: LocationRef;
  private readonly now: () => number;
  private readonly ids: BridgeIdScheme;
  private idCount = 0;
  private seqCount = 0;
  private projectedCount = 0;
  private ignoredCount = 0;
  private inboxCount = 0;
  private readonly reasons: string[] = [];
  private readonly sessions = new Map<string, SessionState>();
  private readonly routing = new Map<string, string>();
  private readonly messages = new Map<string, MessageState>();
  private readonly sequences = new Map<string, number>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly forms = new Map<string, PendingForm>();

  constructor(options: HostProjectionOptions) {
    this.location = options.location;
    this.now = options.now ?? (() => Date.now());
    this.ids = options.ids ?? new BridgeIdScheme();
  }

  stats(): HostProjectionStats {
    return { projected: this.projectedCount, ignored: this.ignoredCount, ignoredReasons: [...this.reasons] };
  }

  project(frame: unknown): readonly OpenCodeEvent[] {
    const record = asRecord(frame);
    if (record === undefined) return this.ignore("frame is not an object");
    if (this.isStale(record)) return [];
    const type = textOf(record.type);
    if (type !== undefined) return this.projectHostFrame(type, record);
    const kind = textOf(record.kind);
    if (kind !== undefined) return this.projectStreamFrame(kind, record);
    return this.ignore("frame has neither a string type nor a string kind");
  }

  /**
   * A stream frame's `sequence` counts per session and a `session_status` record's `seq` counts per
   * subscription, so each is tracked on its own key; a repeat or a step backwards is dropped.
   */
  private isStale(record: Frame): boolean {
    if (typeof record.sequence === "number") {
      const key = "stream:" + (textOf(record.sessionId) ?? "");
      const last = this.sequences.get(key);
      if (last !== undefined && record.sequence <= last) {
        this.ignore("duplicate or out-of-order stream sequence " + String(record.sequence));
        return true;
      }
      this.sequences.set(key, record.sequence);
      return false;
    }
    const subscription = textOf(record.subscriptionId);
    if (subscription !== undefined && typeof record.seq === "number") {
      const key = "subscription:" + subscription;
      const last = this.sequences.get(key);
      if (last !== undefined && record.seq <= last) {
        this.ignore("duplicate or out-of-order subscription seq " + String(record.seq));
        return true;
      }
      this.sequences.set(key, record.seq);
    }
    return false;
  }

  private projectStreamFrame(kind: string, frame: Frame): readonly OpenCodeEvent[] {
    if (!MESSAGE_KINDS.has(kind) && kind !== "auto_retry_start" && kind !== "auto_retry_end")
      return this.ignore("stream kind not projected: " + kind);
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const message = this.messageFor(session.durableId);
    const metadata = this.metadataOf(frame);
    if (kind === "prompt_started") this.beginMessage(session, frame);
    else this.nameMessage(session, frame);
    if (kind === "prompt_started") {
      message.text = "";
      message.thinking = "";
      message.textOrdinal = 0;
      message.reasoningOrdinal = 0;
      message.textOpen = false;
      message.reasoningOpen = false;
      return this.emit([this.event(session.durableId, metadata, { type: "session.execution.started", version: 1, data: {} })]);
    }
    if (kind === "partial") {
      const text = textOf(frame.text);
      const thinking = textOf(frame.thinking);
      if (text === undefined && thinking === undefined) return this.ignore("partial frame carries neither text nor thinking");
      const events: PendingEvent[] = [];
      if (thinking !== undefined && thinking !== message.thinking) {
        events.push(...this.blockEvents(session.durableId, message, "reasoning", message.thinking, thinking, metadata));
        message.thinking = thinking;
      }
      if (text !== undefined && text !== message.text) {
        events.push(...this.blockEvents(session.durableId, message, "text", message.text, text, metadata));
        message.text = text;
      }
      return this.emit(events);
    }
    if (kind === "message_end") {
      const final = textOf(frame.text) ?? message.text;
      const events: PendingEvent[] = [];
      if (message.reasoningOpen) events.push(...this.endBlock(session.durableId, message, "reasoning", message.thinking, metadata));
      events.push(...this.blockEvents(session.durableId, message, "text", message.text, final, metadata));
      events.push(...this.endBlock(session.durableId, message, "text", final, metadata));
      message.text = final;
      return this.emit(events);
    }
    if (kind === "tool_call") {
      const callId = textOf(frame.callId);
      if (callId === undefined) return this.ignore("tool_call frame has no string callId");
      const argumentsText = textOf(frame.arguments) ?? "";
      const parsed = this.parseArguments(argumentsText);
      return this.emit([
        eventOf({
          created: this.now(),
          metadata: { ...metadata, rawArguments: argumentsText },
          type: "session.tool.called",
          durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
          location: this.location,
          data: { sessionID: session.durableId, assistantMessageID: this.idOfMessage(session.durableId, message), id: callId, input: parsed, executed: false },
        }),
      ]);
    }
    if (kind === "tool_result") {
      const callId = textOf(frame.callId);
      const result = textOf(frame.result);
      if (callId === undefined) return this.ignore("tool_result frame has no string callId");
      if (result === undefined) return this.ignore("tool_result frame has no string result");
      /* The stream declares a result, not its outcome; `isError` is the only signal a producer has for
         a failed call, and without it the error text would be reported as a success. */
      if (frame.isError === true)
        return this.emit([
          this.toolFailed(session.durableId, message, callId, textOf(frame.error) ?? result, metadata),
        ]);
      return this.emit([this.toolSucceeded(session.durableId, message, callId, result, metadata)]);
    }
    if (kind === "agent_idle") return this.emit([this.idle(session.durableId, metadata)]);
    if (kind === "auto_retry_start") {
      const attempt = typeof frame.attempt === "number" && Number.isFinite(frame.attempt) ? frame.attempt : undefined;
      if (attempt === undefined) return this.ignore("auto_retry_start frame has no numeric attempt");
      return this.emit([
        eventOf({
          created: this.now(),
          metadata: metadata,
          type: "session.retry.scheduled",
          durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
          location: this.location,
          data: {
            sessionID: session.durableId,
            assistantMessageID: this.idOfMessage(session.durableId, message),
            attempt: attempt,
            at: this.now() + numberOr(frame.delayMs, 0),
            error: { type: "auto_retry", message: textOf(frame.errorMessage) ?? "" },
          },
        }),
      ]);
    }
    if (frame.success === true)
      return this.emit([this.status(session.durableId, { type: "busy" }, metadata)]);
    if (frame.success !== false) return this.ignore("auto_retry_end frame has no boolean success");
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: "session.execution.failed",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: {
          sessionID: session.durableId,
          error: { type: "auto_retry", message: textOf(frame.finalError) ?? textOf(frame.errorMessage) ?? "" },
        },
      }),
    ]);
  }

  private projectHostFrame(type: string, frame: Frame): readonly OpenCodeEvent[] {
    if (type === "session_status") return this.projectSessionStatus(frame);
    if (type === "session_opened") return this.projectSessionOpened(frame);
    if (type === "session_closed") return this.projectSessionClosed(frame);
    if (type === "extension_ui_request") return this.projectUiRequest(frame);
    if (type === "extension_ui_response") return this.projectUiResponse(frame);
    if (type === "question_resolved") return this.projectQuestionResolved(frame);
    if (type === "agent_start") {
      const session = this.sessionForFrame(frame);
      if (session === undefined) return [];
      return this.emit([this.event(session.durableId, this.metadataOf(frame), { type: "session.execution.started", version: 1, data: {} })]);
    }
    if (type === "agent_idle" || type === "agent_settled") {
      const session = this.sessionForFrame(frame);
      if (session === undefined) return [];
      return this.emit([this.idle(session.durableId, this.metadataOf(frame))]);
    }
    if (type === "auto_retry_start" || type === "auto_retry_end") return this.projectStreamFrame(type, frame);
    if (type === "turn_start") return this.projectTurnStart(frame);
    if (type === "turn_end") return this.projectTurnEnd(frame);
    if (type === "compaction_start") return this.projectCompactionStart(frame);
    if (type === "compaction_end") return this.projectCompactionEnd(frame);
    if (type === "message_start") return this.projectMessageStart(frame);
    if (type === "message_update") return this.projectMessageUpdate(frame);
    if (type === "message_end") return this.projectHostMessageEnd(frame);
    if (type === "entry_appended") return this.projectEntryAppended(frame);
    if (type === "extension_event") return this.projectExtensionEvent(frame);
    if (type === "loaded_surfaces_changed") return this.projectLoadedSurfaces(frame);
    if (type === "queue_update") return this.projectQueueUpdate(frame);
    if (type === "pending_input_update") return this.projectPendingInputUpdate(frame);
    if (type === "tool_execution_start") return this.projectToolExecutionStart(frame);
    if (type === "tool_execution_update") return this.projectToolExecutionUpdate(frame);
    if (type === "tool_execution_end") return this.projectToolExecutionEnd(frame);
    return this.ignore("host frame type not projected: " + type);
  }

  private projectSessionStatus(frame: Frame): readonly OpenCodeEvent[] {
    const routingId = textOf(frame.sessionId);
    const durableId = textOf(frame.durableSessionId);
    if (routingId === undefined || durableId === undefined) return this.ignore("session_status frame has no sessionId / durableSessionId");
    const created = this.learnSession(durableId, routingId, true);
    const metadata = this.metadataOf(frame);
    const status = this.status(durableId, statusOf(frame.status), metadata);
    if (!created) return this.emit([status]);
    return this.emit([this.sessionCreated(durableId, metadata), status]);
  }

  private projectSessionOpened(frame: Frame): readonly OpenCodeEvent[] {
    const routingId = textOf(frame.sessionId);
    const durableId = textOf(frame.durableSessionId) ?? routingId;
    if (durableId === undefined) return this.ignore("session_opened frame has no session id");
    const created = this.learnSession(durableId, routingId ?? durableId, true);
    if (!created) return this.ignore("session_opened for a session already announced");
    return this.emit([this.sessionCreated(durableId, this.metadataOf(frame))]);
  }

  private projectSessionClosed(frame: Frame): readonly OpenCodeEvent[] {
    const routingId = textOf(frame.sessionId);
    const durableId = this.resolveSession(routingId);
    if (durableId === undefined) return this.ignore("session_closed frame names no known session");
    const metadata = { ...this.metadataOf(frame), reason: frame.reason };
    if (frame.reason !== "session_dir_removed") return this.emit([this.status(durableId, { type: "idle" }, metadata)]);
    this.sessions.delete(durableId);
    if (routingId !== undefined) this.routing.delete(routingId);
    this.messages.delete(durableId);
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: "session.deleted",
        durable: { aggregateID: durableId, seq: this.nextSeq(), version: 2 },
        location: this.location,
        data: { sessionID: durableId },
      }),
    ]);
  }

  private projectUiRequest(frame: Frame): readonly OpenCodeEvent[] {
    const method = textOf(frame.method);
    if (method === "select") return this.projectPermissionRequest(frame);
    if (method === "question") return this.projectFormRequest(frame);
    return this.ignore("extension_ui_request method not projected: " + String(method ?? "(missing)"));
  }

  private projectPermissionRequest(frame: Frame): readonly OpenCodeEvent[] {
    const title = textOf(frame.title);
    const requestId = textOf(frame.id);
    if (title === undefined) return this.ignore("select dialog has no string title");
    if (requestId === undefined) return this.ignore("select dialog has no string id");
    if (!title.startsWith(PERMISSION_TITLE_PREFIX)) return this.ignore("select dialog is not a permission prompt");
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const clientId = clientIdOf(PERMISSION_ID_PREFIX, requestId);
    this.permissions.set(requestId, { hostId: requestId, clientId: clientId, sessionId: session.durableId });
    return this.emitDialog([
      eventOf({
        created: this.now(),
        metadata: {
          ...this.metadataOf(frame),
          options: Array.isArray(frame.options) ? frame.options.filter((option): option is string => typeof option === "string") : [],
          toolCallId: frame.toolCallId,
          parentToolCallId: frame.parentToolCallId,
        },
        type: "permission.asked",
        location: this.location,
        data: {
          id: clientId,
          sessionID: session.durableId,
          action: title.slice(PERMISSION_TITLE_PREFIX.length).split("\n", 1)[0]?.trim() ?? "",
          /* the dialog frame carries no permission resources; the path text lives in the title */
          resources: [],
          message: title,
        },
      }),
    ]);
  }

  private projectFormRequest(frame: Frame): readonly OpenCodeEvent[] {
    const dialogId = textOf(frame.id);
    const requestId = textOf(frame.requestId) ?? dialogId;
    if (dialogId === undefined || requestId === undefined) return this.ignore("question dialog has no string id / requestId");
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const questions = Array.isArray(frame.questions) ? frame.questions : [];
    const fields = questions.flatMap((raw, index) => {
      const question = asRecord(raw);
      if (question === undefined) return [];
      const options = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
            const parsed = asRecord(option);
            const label = parsed === undefined ? undefined : textOf(parsed.label);
            if (label === undefined) return [];
            const description = textOf(parsed?.description);
            return [{ value: label, label: label, ...(description === undefined ? {} : { description: description }) }];
          })
        : [];
      return [
        {
          key: "q" + String(index),
          title: textOf(question.header) ?? "Question " + String(index + 1),
          description: textOf(question.question) ?? "",
          type: question.multiSelect === true ? ("multiselect" as const) : ("string" as const),
          options: options,
          custom: true,
          /* the question wire type has no required flag; a host that declares one is honored, and every
             other question stays answerable with nothing, the way the question tool's own form is */
          ...(question.required === true ? { required: true } : {}),
        },
      ];
    });
    /* FormFields is a non-empty tuple, so a prompt with no usable question cannot be a form. */
    const [first, ...rest] = fields;
    if (first === undefined) return this.ignore("question dialog has no usable question");
    const clientId = clientIdOf(FORM_ID_PREFIX, requestId);
    this.forms.set(requestId, {
      requestId: requestId,
      dialogId: dialogId,
      clientId: clientId,
      sessionId: session.durableId,
      questionIds: questions.map((raw, index) => textOf(asRecord(raw)?.id) ?? "q" + String(index)),
      requiredKeys: fields.flatMap((field) => (field.required === true ? [field.key] : [])),
    });
    return this.emitDialog([
      eventOf({
        created: this.now(),
        metadata: { ...this.metadataOf(frame), dialogId: dialogId },
        type: "form.created",
        location: this.location,
        data: {
          form: {
            id: clientId,
            sessionID: session.durableId,
            title: first.title,
            metadata: { kind: "question", toolCallId: frame.toolCallId, dialogId: dialogId, questions: questions },
            fields: [first, ...rest],
          },
        },
      }),
    ]);
  }

  private projectUiResponse(frame: Frame): readonly OpenCodeEvent[] {
    const answered = textOf(frame.uiRequestId) ?? textOf(frame.id);
    if (answered === undefined) return this.ignore("extension_ui_response names no request");
    const permission = this.permissions.get(answered);
    if (permission !== undefined) {
      const reply = frame.cancelled === true ? "reject" : PERMISSION_REPLIES[textOf(frame.value) ?? ""];
      if (reply === undefined) return this.ignore("permission answer carries no reply this bridge can map");
      this.permissions.delete(answered);
      return this.emitDialog([
        eventOf({
          created: this.now(),
          metadata: this.metadataOf(frame),
          type: "permission.replied",
          location: this.location,
          data: { sessionID: permission.sessionId, requestID: permission.clientId, reply: reply },
        }),
      ]);
    }
    const form = [...this.forms.values()].find((candidate) => candidate.dialogId === answered || candidate.requestId === answered);
    if (form === undefined) return this.ignore("dialog answer names no pending permission or form");
    if (frame.cancelled === true) {
      this.forms.delete(form.requestId);
      return this.emitDialog([this.formCancelled(form, this.metadataOf(frame))]);
    }
    const answers = asRecord(frame.answers);
    if (answers === undefined) return this.ignore("dialog answer carries neither answers nor cancelled");
    return this.settleForm(form, this.answerOf(form, answers), this.metadataOf(frame));
  }

  private projectQuestionResolved(frame: Frame): readonly OpenCodeEvent[] {
    const requestId = textOf(frame.requestId);
    if (requestId === undefined) return this.ignore("question_resolved frame has no string requestId");
    const form = this.forms.get(requestId);
    if (form === undefined) return this.ignore("question_resolved names no pending form");
    const metadata = { ...this.metadataOf(frame), outcome: textOf(frame.outcome) };
    if (textOf(frame.outcome) !== "answered" && textOf(frame.outcome) !== "comment-submitted") {
      this.forms.delete(requestId);
      return this.emitDialog([this.formCancelled(form, metadata)]);
    }
    return this.settleForm(form, this.answerOf(form, asRecord(frame.answers) ?? {}), metadata);
  }

  /**
   * Settles an answered form, unless the answer leaves a required field empty: that is the client's own
   * `FormInvalidAnswerError` rule, and the form stays pending rather than being settled on an answer the
   * published form declared incomplete.
   */
  private settleForm(
    form: PendingForm,
    answer: Record<string, string | string[]>,
    metadata: Frame,
  ): readonly OpenCodeEvent[] {
    const missing = this.missingRequired(form, answer);
    if (missing !== undefined)
      return this.ignore(
        "form reply rejected: " + JSON.stringify({ _tag: "FormInvalidAnswerError", id: form.clientId, message: missing }),
      );
    this.forms.delete(form.requestId);
    return this.emitDialog([this.formReplied(form, answer, metadata)]);
  }

  /** The required-field rule of the client's form service, over the fields this projection publishes. */
  private missingRequired(form: PendingForm, answer: Record<string, string | string[]>): string | undefined {
    for (const key of form.requiredKeys) {
      const value = answer[key];
      if (value === undefined || value.length === 0) return "Missing required form field: " + key;
    }
    return undefined;
  }

  /** Maps the host's per-question-id answers onto the field keys the form was published with. */
  private answerOf(form: PendingForm, answers: Frame): Record<string, string | string[]> {
    const mapped: Record<string, string | string[]> = {};
    for (let index = 0; index < form.questionIds.length; index += 1) {
      const answer = asRecord(answers[form.questionIds[index] ?? ""]);
      if (answer === undefined) continue;
      const selected = Array.isArray(answer.selected) ? answer.selected.filter((value): value is string => typeof value === "string") : [];
      const text = textOf(answer.text);
      if (selected.length === 0 && text === undefined) continue;
      mapped["q" + String(index)] = text !== undefined && selected.length === 0 ? text : selected;
    }
    return mapped;
  }

  /** The client's `rpc.` channel is the fork's extension-event surface; only the name is dynamic. */
  private projectExtensionEvent(frame: Frame): readonly OpenCodeEvent[] {
    const name = textOf(frame.name);
    if (name === undefined) return this.ignore("extension_event has no string name");
    const routingId = textOf(frame.sessionId);
    /* Routed by the documented `sessionId` only: an id the bridge has not been told about is not proof
       of a session, so the event travels unattached instead of minting one. */
    const durableId =
      routingId === undefined ? undefined : (this.routing.get(routingId) ?? (this.sessions.has(routingId) ? routingId : undefined));
    const metadata = {
      ...this.metadataOf(frame),
      eventName: name,
      ...(routingId === undefined ? {} : { sessionId: routingId }),
    };
    const payload = frame.data ?? {};
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: agentCustomType(name),
        location: this.location,
        data: {
          name: name,
          ...(routingId === undefined ? {} : { sessionId: routingId }),
          ...(durableId === undefined ? {} : { sessionID: durableId }),
          payload: payload,
        },
      }),
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: rpcEventType(name),
        location: this.location,
        data: { name: name, ...(durableId === undefined ? {} : { sessionID: durableId }), payload: payload },
      }),
    ]);
  }

  /**
   * A loaded-surface change is the host's MCP catalogue refresh: `mcp.tools.changed` is the record that
   * names it, and `mcp.status.changed` keeps travelling because that is the member a client on the older
   * substitute resyncs from.
   */
  private projectLoadedSurfaces(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const server = textOf(frame.server) ?? textOf(frame.name) ?? "";
    const metadata = this.metadataOf(frame);
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: "mcp.tools.changed",
        location: this.location,
        data: { server: server },
      }),
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: "mcp.status.changed",
        location: this.location,
        data: { server: server },
      }),
    ]);
  }

  private projectTurnStart(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const message = this.messageFor(session.durableId);
    this.beginMessage(session, frame);
    this.resetBlocks(message);
    const model = modelOf(frame.model) ?? modelOf(asRecord(frame.message)?.model) ?? { id: "bridge", providerID: "bridge" };
    const agent = textOf(frame.agent) ?? textOf(asRecord(frame.message)?.agent) ?? "bridge";
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: this.metadataOf(frame),
        type: "session.step.started",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: {
          sessionID: session.durableId,
          assistantMessageID: this.idOfMessage(session.durableId, message, false),
          agent: agent,
          model: model,
          started: Math.round(numberOr(frame.startedAtMs, this.now())),
        },
      }),
    ]);
  }

  private projectTurnEnd(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const message = this.messageFor(session.durableId);
    this.nameMessage(session, frame);
    const metadata = this.metadataOf(frame);
    const events = [
      ...this.endBlock(session.durableId, message, "reasoning", message.thinking, metadata),
      ...this.endBlock(session.durableId, message, "text", message.text, metadata),
    ];
    const snapshot = textOf(frame.snapshot);
    const rawFinish = textOf(frame.rawFinish) ?? textOf(frame.stopReason);
    events.push(
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: "session.step.ended",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: {
          sessionID: session.durableId,
          assistantMessageID: this.idOfMessage(session.durableId, message, false),
          finish: finishOf(frame.finish ?? frame.finishReason ?? frame.stopReason),
          ...(rawFinish === undefined ? {} : { rawFinish: rawFinish }),
          ...(snapshot === undefined ? {} : { snapshot: snapshot }),
          cost: numberOr(frame.cost, numberOr(asRecord(frame.message)?.cost, 0)),
          tokens: tokensOf(frame.tokens ?? asRecord(frame.message)?.tokens),
        },
      }),
    );
    /* The turn's terminal execution outcome, from the stop reason the message carries: an abort
       ends the execution as interrupted, a normal stop as succeeded. An `"error"` stop emits neither
       here -- the retry records (`auto_retry_end`) already carry the failed outcome. */
    const outcome = turnOutcomeOf(frame);
    if (outcome === "aborted")
      events.push(
        eventOf({
          created: this.now(),
          metadata: metadata,
          type: "session.execution.interrupted",
          durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
          location: this.location,
          data: { sessionID: session.durableId, reason: "user" },
        }),
      );
    if (outcome === "completed")
      events.push(
        eventOf({
          created: this.now(),
          metadata: metadata,
          type: "session.execution.succeeded",
          durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
          location: this.location,
          data: { sessionID: session.durableId },
        }),
      );
    return this.emit(events);
  }

  private projectCompactionStart(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const inputID = textOf(frame.inputID);
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: this.metadataOf(frame),
        type: "session.compaction.started",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: {
          sessionID: session.durableId,
          reason: textOf(frame.reason) === "manual" ? "manual" : "auto",
          ...(inputID === undefined ? {} : { inputID: inputID }),
        },
      }),
    ]);
  }

  /**
   * The host streams no compaction delta record, so the completed summary is delivered as one delta
   * followed by the authoritative `ended` event; an aborted run ends as `failed` instead.
   */
  private projectCompactionEnd(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const reason = textOf(frame.reason) === "manual" ? "manual" : "auto";
    const metadata = this.metadataOf(frame);
    if (frame.aborted === true)
      return this.emit([
        eventOf({
          created: this.now(),
          metadata: metadata,
          type: "session.compaction.failed",
          durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
          location: this.location,
          data: {
            sessionID: session.durableId,
            reason: reason,
            error: { type: "compaction_aborted", message: "the host aborted the compaction" },
          },
        }),
      ]);
    const text = contentTextOf(frame.result);
    const model = modelOf(frame.model);
    const cost = typeof frame.cost === "number" && Number.isFinite(frame.cost) ? frame.cost : undefined;
    const events: PendingEvent[] = [];
    if (text.length > 0)
      events.push(
        eventOf({
          created: this.now(),
          metadata: metadata,
          type: "session.compaction.delta",
          location: this.location,
          data: { sessionID: session.durableId, text: text },
        }),
      );
    events.push(
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: "session.compaction.ended",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: {
          sessionID: session.durableId,
          reason: reason,
          text: text,
          ...(model === undefined ? {} : { model: model }),
          ...(cost === undefined ? {} : { cost: cost }),
          ...(frame.tokens === undefined ? {} : { tokens: tokensOf(frame.tokens) }),
        },
      }),
    );
    return this.emit(events);
  }

  private projectMessageStart(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const message = this.messageFor(session.durableId);
    this.beginMessage(session, frame);
    this.resetBlocks(message);
    return [];
  }

  /**
   * The host's `message_update` carries one `assistantMessageEvent` fragment; appending it to the
   * block state keeps the same started/delta/ended vocabulary the cumulative `partial` frame uses.
   */
  private projectMessageUpdate(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const assistant = asRecord(frame.assistantMessageEvent);
    if (assistant === undefined) return this.ignore("message_update carries no assistantMessageEvent");
    const message = this.messageFor(session.durableId);
    this.nameMessage(session, frame, assistant);
    const metadata = this.metadataOf(frame);
    const kind = textOf(assistant.type);
    if (kind === "start" || kind === "message_start") {
      this.resetBlocks(message);
      return [];
    }
    if (kind === "text_delta" || kind === "text") return this.appendBlock(session.durableId, message, "text", assistant, metadata);
    if (kind === "thinking_delta" || kind === "thinking")
      return this.appendBlock(session.durableId, message, "reasoning", assistant, metadata);
    if (kind === "text_end") return this.emit(this.endBlock(session.durableId, message, "text", message.text, metadata));
    if (kind === "thinking_end")
      return this.emit(this.endBlock(session.durableId, message, "reasoning", message.thinking, metadata));
    if (kind === "done" || kind === "message_end" || kind === "error") {
      const events = [
        ...this.endBlock(session.durableId, message, "reasoning", message.thinking, metadata),
        ...this.endBlock(session.durableId, message, "text", message.text, metadata),
      ];
      return events.length === 0 ? [] : this.emit(events);
    }
    return this.ignore("assistantMessageEvent kind not projected: " + String(kind ?? "(missing)"));
  }

  private appendBlock(
    sessionID: string,
    message: MessageState,
    block: "text" | "reasoning",
    assistant: Frame,
    metadata: Frame,
  ): readonly OpenCodeEvent[] {
    const delta = textOf(assistant.delta) ?? textOf(assistant.text);
    if (delta === undefined || delta.length === 0) return this.ignore("message_update delta is empty");
    const previous = block === "text" ? message.text : message.thinking;
    const next = previous + delta;
    if (block === "text") message.text = next;
    else message.thinking = next;
    return this.emit(this.blockEvents(sessionID, message, block, previous, next, metadata));
  }

  /** The host's own `message_end`: the assembled message is authoritative for the open blocks. */
  private projectHostMessageEnd(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const message = this.messageFor(session.durableId);
    this.nameMessage(session, frame);
    const content = asRecord(frame.message)?.content;
    const parts = Array.isArray(content) ? content : [];
    const finalText = this.joinParts(parts, "text") ?? message.text;
    const finalThinking = this.joinParts(parts, "reasoning") ?? this.joinParts(parts, "thinking") ?? message.thinking;
    const metadata = this.metadataOf(frame);
    const events = [
      ...this.endBlock(session.durableId, message, "reasoning", finalThinking, metadata),
      ...this.endBlock(session.durableId, message, "text", finalText, metadata),
    ];
    message.text = finalText;
    message.thinking = finalThinking;
    if (events.length === 0) return this.ignore("message_end closed no open block");
    return this.emit(events);
  }

  private joinParts(parts: readonly unknown[], type: string): string | undefined {
    const texts = parts.flatMap((raw) => {
      const part = asRecord(raw);
      if (part === undefined || textOf(part.type) !== type) return [];
      const text = textOf(part.text);
      return text === undefined ? [] : [text];
    });
    return texts.length === 0 ? undefined : texts.join("\n");
  }

  /**
   * An appended entry is the replay-safe content boundary for its message: its id is authoritative,
   * and each content part replaces the open block (or opens one when no block was streamed). An
   * assistant entry also publishes the client's `session.message.content.updated` with that id.
   */
  private projectEntryAppended(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const entry = asRecord(frame.entry);
    if (entry === undefined) return this.ignore("entry_appended carries no entry record");
    const appended = asRecord(entry.message);
    const message = this.messageFor(session.durableId);
    const entryID = textOf(entry.id);
    const messageId = this.hostNamedID(session, frame, appended ?? entry);
    if (messageId !== undefined) {
      message.messageId = messageId;
      message.used = false;
    }
    const content = Array.isArray(appended?.content) ? appended.content : [];
    const metadata = entryID === undefined ? this.metadataOf(frame) : { ...this.metadataOf(frame), hostEntryID: entryID };
    const events: PendingEvent[] = [];
    const parts = content.flatMap((raw): { readonly type: "text" | "reasoning"; readonly text: string }[] => {
      const part = asRecord(raw);
      const kind = textOf(part?.type);
      const text = textOf(part?.text);
      if (text === undefined) return [];
      if (kind === "text") return [{ type: "text", text: text }];
      if (kind === "reasoning" || kind === "thinking") return [{ type: "reasoning", text: text }];
      return [];
    });
    /* Only an assistant entry carries assistant content, and only a host-named id is a real message
       identity; a tool part has no reproducible client shape, so it stays on `session.tool.*`. */
    if (textOf(appended?.role) === "assistant" && messageId !== undefined && parts.length > 0)
      events.push(this.contentUpdated(session.durableId, messageId, parts, metadata));
    events.push(
      ...content.flatMap((raw): PendingEvent[] => {
        const part = asRecord(raw);
        const kind = textOf(part?.type);
        const text = textOf(part?.text);
        if (text === undefined) return [];
        if (kind === "text") return this.contentUpdate(session.durableId, message, "text", text, metadata);
        if (kind === "reasoning" || kind === "thinking")
          return this.contentUpdate(session.durableId, message, "reasoning", text, metadata);
        return [];
      }),
    );
    return events.length === 0 ? [] : this.emit(events);
  }

  private contentUpdated(
    sessionID: string,
    messageID: string,
    content: { readonly type: "text" | "reasoning"; readonly text: string }[],
    metadata: Frame,
  ): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.message.content.updated",
      durable: { aggregateID: sessionID, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: { sessionID: sessionID, messageID: messageID, content: content },
    });
  }

  private contentUpdate(
    sessionID: string,
    message: MessageState,
    block: "text" | "reasoning",
    text: string,
    metadata: Frame,
  ): PendingEvent[] {
    const open = block === "text" ? message.textOpen : message.reasoningOpen;
    if (block === "text") message.text = text;
    else message.thinking = text;
    if (open) return [this.blockEnded(sessionID, message, block, text, metadata)];
    return [this.blockStarted(sessionID, message, block, metadata), this.blockEnded(sessionID, message, block, text, metadata)];
  }

  private projectQueueUpdate(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const steering = frame.steering;
    const followUp = frame.followUp;
    if (!Array.isArray(steering) && !Array.isArray(followUp))
      return this.ignore("queue_update carries neither steering nor followUp");
    const next = new Map<string, Delivery>();
    for (const text of stringArrayOf(steering)) next.set(text, "steer");
    for (const text of stringArrayOf(followUp)) if (!next.has(text)) next.set(text, "queue");
    const metadata = this.metadataOf(frame);
    const events: PendingEvent[] = [];
    for (const [text, delivery] of next) {
      const before = session.queue.get(text);
      const inboxID = this.inboxIdOf(session, text);
      if (before === undefined) events.push(this.inboxEnqueued(session, inboxID, text, delivery, metadata));
      else if (before !== delivery) events.push(this.inboxDeliveryChanged(session, inboxID, delivery, metadata));
    }
    /* A queued text that left the snapshot was applied to the turn; the fork's inbox vocabulary has no
       third terminal for "removed from the queue". */
    for (const text of session.queue.keys())
      if (!next.has(text)) events.push(this.inboxDelivered(session, this.inboxIdOf(session, text), metadata));
    session.queue = next;
    return events.length === 0 ? [] : this.emit(events);
  }

  private projectPendingInputUpdate(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const changes = frame.changes;
    if (!Array.isArray(changes)) return this.ignore("pending_input_update carries no changes array");
    const metadata = this.metadataOf(frame);
    const events: PendingEvent[] = [];
    for (const raw of changes) {
      const change = asRecord(raw);
      if (change === undefined) {
        this.ignore("pending_input_update change is not an object");
        continue;
      }
      const kind = textOf(change.type) ?? textOf(change.kind) ?? textOf(change.status) ?? textOf(change.op);
      const text = textOf(change.text);
      const named = textOf(change.inboxID) ?? textOf(change.inboxId) ?? textOf(change.id);
      const inboxID = named ?? (text === undefined ? undefined : this.inboxIdOf(session, text));
      if (inboxID === undefined) {
        this.ignore("pending_input_update change names no inbox item");
        continue;
      }
      const delivery: Delivery = textOf(change.delivery) === "steer" ? "steer" : "queue";
      if (kind === "enqueued" || kind === "added" || kind === "queued") {
        const payload = asRecord(change.item) ?? asRecord(change.payload);
        const queuedText = text ?? textOf(payload?.text) ?? "";
        events.push(this.inboxEnqueued(session, inboxID, queuedText, delivery, metadata));
        session.queue.set(queuedText, delivery);
        continue;
      }
      if (kind === "delivered" || kind === "started") {
        events.push(this.inboxDelivered(session, inboxID, metadata));
        if (text !== undefined) session.queue.delete(text);
        continue;
      }
      if (kind === "cancelled" || kind === "canceled" || kind === "removed") {
        events.push(this.inboxCancelled(session, inboxID, metadata));
        if (text !== undefined) {
          session.queue.delete(text);
          session.inboxIds.delete(text);
        }
        continue;
      }
      if (kind === "delivery" || kind === "delivery_changed" || kind === "delivery.changed") {
        events.push(this.inboxDeliveryChanged(session, inboxID, delivery, metadata));
        if (text !== undefined) session.queue.set(text, delivery);
        continue;
      }
      this.ignore("pending_input_update change kind not projected: " + String(kind ?? "(missing)"));
    }
    return events.length === 0 ? [] : this.emit(events);
  }

  private projectToolExecutionStart(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const callId = textOf(frame.toolCallId);
    if (callId === undefined) return this.ignore("tool_execution_start frame has no string toolCallId");
    const message = this.messageFor(session.durableId);
    const name = textOf(frame.toolName) ?? textOf(frame.tool) ?? "tool";
    const declared = textOf(frame.args) ?? textOf(frame.input);
    const input = declared !== undefined ? this.parseArguments(declared) : (asRecord(frame.args) ?? asRecord(frame.input) ?? {});
    const argumentsText = declared ?? JSON.stringify(input);
    const metadata = this.metadataOf(frame);
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: { ...metadata, toolName: name },
        type: "session.tool.input.started",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: { sessionID: session.durableId, assistantMessageID: this.idOfMessage(session.durableId, message), id: callId, name: name },
      }),
      eventOf({
        created: this.now(),
        metadata: metadata,
        type: "session.tool.input.ended",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: { sessionID: session.durableId, assistantMessageID: this.idOfMessage(session.durableId, message), id: callId, text: argumentsText },
      }),
      eventOf({
        created: this.now(),
        metadata: { ...metadata, rawArguments: argumentsText, toolName: name },
        type: "session.tool.called",
        durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
        location: this.location,
        data: { sessionID: session.durableId, assistantMessageID: this.idOfMessage(session.durableId, message), id: callId, input: input, executed: false },
      }),
    ]);
  }

  private projectToolExecutionUpdate(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const callId = textOf(frame.toolCallId);
    if (callId === undefined) return this.ignore("tool_execution_update frame has no string toolCallId");
    const partial = contentTextOf(frame.partialResult);
    if (partial.length === 0) return this.ignore("tool_execution_update carries no partial output");
    const message = this.messageFor(session.durableId);
    const toolName = textOf(frame.toolName);
    return this.emit([
      eventOf({
        created: this.now(),
        metadata: this.metadataOf(frame),
        type: "session.tool.progress",
        location: this.location,
        data: {
          sessionID: session.durableId,
          assistantMessageID: this.idOfMessage(session.durableId, message),
          id: callId,
          metadata: { partial: partial, ...(toolName === undefined ? {} : { toolName: toolName }) },
        },
      }),
    ]);
  }

  private projectToolExecutionEnd(frame: Frame): readonly OpenCodeEvent[] {
    const session = this.sessionForFrame(frame);
    if (session === undefined) return [];
    const callId = textOf(frame.toolCallId);
    if (callId === undefined) return this.ignore("tool_execution_end frame has no string toolCallId");
    const message = this.messageFor(session.durableId);
    const text = contentTextOf(frame.result);
    const metadata = this.metadataOf(frame);
    if (frame.isError === true)
      return this.emit([
        this.toolFailed(session.durableId, message, callId, text.length === 0 ? "tool execution failed" : text, metadata),
      ]);
    return this.emit([this.toolSucceeded(session.durableId, message, callId, text, metadata)]);
  }

  private toolSucceeded(sessionID: string, message: MessageState, callId: string, text: string, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.tool.success",
      durable: { aggregateID: sessionID, seq: this.nextSeq(), version: 2 },
      location: this.location,
      data: {
        sessionID: sessionID,
        assistantMessageID: this.idOfMessage(sessionID, message),
        id: callId,
        content: [{ type: "text", text: text }],
        executed: true,
      },
    });
  }

  private toolFailed(sessionID: string, message: MessageState, callId: string, reason: string, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.tool.failed",
      durable: { aggregateID: sessionID, seq: this.nextSeq(), version: 2 },
      location: this.location,
      data: {
        sessionID: sessionID,
        assistantMessageID: this.idOfMessage(sessionID, message),
        id: callId,
        error: { type: "tool_error", message: reason },
        ...(reason.length === 0 ? {} : { content: [{ type: "text", text: reason }] }),
        executed: true,
      },
    });
  }

  private inboxIdOf(session: SessionState, text: string): string {
    const existing = session.inboxIds.get(text);
    if (existing !== undefined) return existing;
    this.inboxCount += 1;
    const id = "msg_bridge_inbox_" + String(this.inboxCount);
    session.inboxIds.set(text, id);
    return id;
  }

  private inboxEnqueued(session: SessionState, inboxID: string, text: string, delivery: Delivery, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.inbox.enqueued",
      durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: {
        sessionID: session.durableId,
        inboxID: inboxID,
        item: { type: "user", payload: { text: text }, delivery: delivery },
      },
    });
  }

  private inboxDelivered(session: SessionState, inboxID: string, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.inbox.delivered",
      durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: { sessionID: session.durableId, inboxID: inboxID },
    });
  }

  private inboxCancelled(session: SessionState, inboxID: string, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.inbox.cancelled",
      durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: { sessionID: session.durableId, inboxID: inboxID },
    });
  }

  private inboxDeliveryChanged(session: SessionState, inboxID: string, delivery: Delivery, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.inbox.delivery.changed",
      durable: { aggregateID: session.durableId, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: { sessionID: session.durableId, inboxID: inboxID, delivery: delivery },
    });
  }

  private messageIdOf(frame: Frame, assistant?: Frame): string | undefined {
    return (
      textOf(assistant?.messageId) ??
      textOf(asRecord(assistant?.message)?.id) ??
      textOf(asRecord(assistant?.partial)?.id) ??
      textOf(frame.messageId) ??
      textOf(asRecord(frame.message)?.id)
    );
  }

  /** The record whose `timestamp` is the message's own, the value the pull mints that message's id from. */
  private messageRecordOf(frame: Frame, assistant?: Frame): Frame | undefined {
    return asRecord(frame.message) ?? asRecord(assistant?.partial) ?? asRecord(assistant?.message);
  }

  /**
   * The client id of a message the host named: the session-tree entry id when the frame carries one
   * (`entry_appended`), else the frame's own message id. Minted with the message's own timestamp, which
   * is what the pull mints from, so the live stream and the pulled transcript answer one id for it.
   */
  private hostNamedID(session: SessionState, frame: Frame, record: Frame | undefined): string | undefined {
    const timestamp = typeof record?.timestamp === "number" && Number.isFinite(record.timestamp) ? record.timestamp : this.now();
    const entryID = textOf(asRecord(frame.entry)?.id);
    if (entryID !== undefined) return this.ids.messageID({ sessionID: session.durableId, entryID: entryID }, timestamp);
    const hostID = this.messageIdOf(frame);
    return hostID === undefined ? undefined : this.ids.hostMessageID(session.durableId, hostID, timestamp);
  }

  /**
   * Starts the message a frame belongs to. A message that already emitted an event gets a fresh bridge
   * id, so two messages of one session never share one; a host-named identity always wins, because it is
   * the id the pulled transcript mints for the same row.
   */
  private beginMessage(session: SessionState, frame: Frame, assistant?: Frame): void {
    const state = this.messageFor(session.durableId);
    const named = this.hostNamedID(session, frame, this.messageRecordOf(frame, assistant));
    if (named !== undefined) {
      state.messageId = named;
      state.used = false;
      return;
    }
    if (!state.used) return;
    state.messageId = "";
    state.used = false;
  }

  /** Records the identity a frame publishes for the message already in flight. */
  private nameMessage(session: SessionState, frame: Frame, assistant?: Frame): void {
    const state = this.messageFor(session.durableId);
    const named = this.hostNamedID(session, frame, this.messageRecordOf(frame, assistant));
    if (named === undefined) return;
    state.messageId = named;
    state.used = false;
  }

  /**
   * The id of the message in flight. The host names no live message record, so the first event of a
   * message mints the bridge's next per-session id and every later event reuses it. `burns` is false for
   * a turn-level event: a step is not a message, so it must not make the next message start a new id.
   */
  private idOfMessage(sessionID: string, message: MessageState, burns = true): string {
    if (burns) message.used = true;
    if (message.messageId.length > 0) return message.messageId;
    const session = this.sessions.get(sessionID);
    const ordinal = (session?.streamOrdinal ?? 0) + 1;
    if (session !== undefined) session.streamOrdinal = ordinal;
    message.messageId = this.ids.streamMessageID(sessionID, ordinal, this.now());
    return message.messageId;
  }

  private resetBlocks(message: MessageState): void {
    message.text = "";
    message.thinking = "";
    message.textOrdinal = 0;
    message.reasoningOrdinal = 0;
    message.textOpen = false;
    message.reasoningOpen = false;
  }

  private blockEvents(
    sessionID: string,
    message: MessageState,
    block: "text" | "reasoning",
    previous: string,
    next: string,
    metadata: Frame,
  ): PendingEvent[] {
    if (next === previous) return [];
    const open = block === "text" ? message.textOpen : message.reasoningOpen;
    if (!open) return [this.blockStarted(sessionID, message, block, metadata), this.blockDelta(sessionID, message, block, next, metadata)];
    if (next.startsWith(previous)) {
      const delta = next.slice(previous.length);
      return delta.length === 0 ? [] : [this.blockDelta(sessionID, message, block, delta, metadata)];
    }
    return [
      this.blockEnded(sessionID, message, block, previous, metadata),
      this.blockStarted(sessionID, message, block, metadata),
      this.blockDelta(sessionID, message, block, next, metadata),
    ];
  }

  private endBlock(sessionID: string, message: MessageState, block: "text" | "reasoning", text: string, metadata: Frame): PendingEvent[] {
    const open = block === "text" ? message.textOpen : message.reasoningOpen;
    if (!open) return [];
    return [this.blockEnded(sessionID, message, block, text, metadata)];
  }

  private blockStarted(sessionID: string, message: MessageState, block: "text" | "reasoning", metadata: Frame): PendingEvent {
    const ordinal = block === "text" ? ++message.textOrdinal : ++message.reasoningOrdinal;
    if (block === "text") message.textOpen = true;
    else message.reasoningOpen = true;
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: block === "text" ? "session.text.started" : "session.reasoning.started",
      durable: { aggregateID: sessionID, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: { sessionID: sessionID, assistantMessageID: this.idOfMessage(sessionID, message), ordinal: ordinal },
    });
  }

  private blockDelta(sessionID: string, message: MessageState, block: "text" | "reasoning", delta: string, metadata: Frame): PendingEvent {
    const ordinal = block === "text" ? message.textOrdinal : message.reasoningOrdinal;
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: block === "text" ? "session.text.delta" : "session.reasoning.delta",
      location: this.location,
      data: { sessionID: sessionID, assistantMessageID: this.idOfMessage(sessionID, message), ordinal: ordinal, delta: delta },
    });
  }

  private blockEnded(sessionID: string, message: MessageState, block: "text" | "reasoning", text: string, metadata: Frame): PendingEvent {
    const ordinal = block === "text" ? message.textOrdinal : message.reasoningOrdinal;
    if (block === "text") message.textOpen = false;
    else message.reasoningOpen = false;
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: block === "text" ? "session.text.ended" : "session.reasoning.ended",
      durable: { aggregateID: sessionID, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: { sessionID: sessionID, assistantMessageID: this.idOfMessage(sessionID, message), ordinal: ordinal, text: text },
    });
  }

  private sessionCreated(durableId: string, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.created",
      durable: { aggregateID: durableId, seq: this.nextSeq(), version: 1 },
      location: this.location,
      data: {
        sessionID: durableId,
        projectID: durableId,
        location: this.location,
        slug: durableId,
        version: "bridge",
      },
    });
  }

  private status(sessionID: string, status: { type: "busy" } | { type: "idle" }, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.status",
      location: this.location,
      data: { sessionID: sessionID, status: status },
    });
  }

  private idle(sessionID: string, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "session.idle",
      location: this.location,
      data: { sessionID: sessionID },
    });
  }

  private event(sessionID: string, metadata: Frame, spec: { readonly type: "session.execution.started"; readonly version: 1; readonly data: Frame }): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: spec.type,
      durable: { aggregateID: sessionID, seq: this.nextSeq(), version: spec.version },
      location: this.location,
      data: { sessionID: sessionID, ...spec.data },
    });
  }

  private metadataOf(frame: Frame): Frame {
    const metadata: Frame = {};
    if (typeof frame.sequence === "number") metadata.sequence = frame.sequence;
    if (typeof frame.seq === "number") metadata.seq = frame.seq;
    if (typeof frame.subscriptionId === "string") metadata.subscriptionId = frame.subscriptionId;
    return metadata;
  }

  private parseArguments(text: string): Frame {
    if (text.length === 0) return {};
    const parsed: unknown = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    })();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Frame;
  }

  private formReplied(form: PendingForm, answer: Record<string, string | string[]>, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "form.replied",
      location: this.location,
      data: { id: form.clientId, sessionID: form.sessionId, answer: answer },
    });
  }

  private formCancelled(form: PendingForm, metadata: Frame): PendingEvent {
    return eventOf({
      created: this.now(),
      metadata: metadata,
      type: "form.cancelled",
      location: this.location,
      data: { id: form.clientId, sessionID: form.sessionId },
    });
  }

  /** Records a session the first time a frame announces it; true means this call announced it. */
  private learnSession(durableId: string, routingId: string, announce: boolean): boolean {
    this.routing.set(routingId, durableId);
    const existing = this.sessions.get(durableId);
    if (existing !== undefined) {
      existing.routingId = routingId;
      if (!announce || existing.announced) return false;
      existing.announced = true;
      return true;
    }
    /* A stream frame can arrive before the status that pairs its routing id with the durable one; that
       placeholder was never announced, so its message state moves to the real id instead of leaving a
       second session behind. */
    const placeholder = routingId !== durableId ? this.sessions.get(routingId) : undefined;
    if (placeholder !== undefined) {
      this.sessions.delete(routingId);
      const messages = this.messages.get(routingId);
      if (messages !== undefined) {
        this.messages.delete(routingId);
        this.messages.set(durableId, messages);
      }
    }
    this.sessions.set(durableId, {
      durableId: durableId,
      routingId: routingId,
      messageId: placeholder?.messageId ?? "",
      streamOrdinal: placeholder?.streamOrdinal ?? 0,
      announced: announce,
      queue: placeholder?.queue ?? new Map<string, Delivery>(),
      inboxIds: placeholder?.inboxIds ?? new Map<string, string>(),
    });
    return announce;
  }

  /** The durable id for a routing id; without one, the only session the projector has seen. */
  private resolveSession(routingId: string | undefined): string | undefined {
    if (routingId !== undefined) return this.routing.get(routingId);
    return this.sessions.size === 1 ? [...this.sessions.keys()][0] : undefined;
  }

  /**
   * The session a frame belongs to. An unknown `sessionId` is taken to be the durable id: only
   * `session_status` can prove the difference, and dropping the frame until it arrives would lose
   * the message it carried.
   */
  private sessionForFrame(frame: Frame): SessionState | undefined {
    const routingId = textOf(frame.sessionId);
    if (routingId === undefined) {
      if (this.sessions.size === 1) return [...this.sessions.values()][0];
      this.ignore("frame carries no sessionId and there is no single session to route it to");
      return undefined;
    }
    const durableId = this.routing.get(routingId) ?? routingId;
    if (this.sessions.get(durableId) === undefined) this.learnSession(durableId, routingId, false);
    return this.sessions.get(durableId);
  }

  private messageFor(sessionID: string): MessageState {
    const existing = this.messages.get(sessionID);
    if (existing !== undefined) return existing;
    const created: MessageState = {
      messageId: "",
      used: false,
      text: "",
      thinking: "",
      textOrdinal: 0,
      reasoningOrdinal: 0,
      textOpen: false,
      reasoningOpen: false,
    };
    this.messages.set(sessionID, created);
    return created;
  }

  /** Allocates the ids, in the order the events are emitted, and counts what goes out. */
  private emit(events: readonly PendingEvent[]): readonly OpenCodeEvent[] {
    this.projectedCount += events.length;
    return events.map((event): OpenCodeEvent => ({ ...event, id: this.nextId() }));
  }

  /**
   * The dialog events are synthesized, so nothing upstream has validated them: each one is published
   * only when the client's own definition accepts its payload, and a refusal is reported in that
   * schema's words instead of handing a consumer an event it would reject.
   */
  private emitDialog(events: readonly PendingEvent[]): readonly OpenCodeEvent[] {
    const accepted: OpenCodeEvent[] = [];
    for (const event of events) {
      const rejection = dataRejection(event.type, event.data as Frame);
      if (rejection !== undefined) {
        this.ignore("dialog event rejected by the client schema: " + rejection);
        continue;
      }
      accepted.push({ ...event, id: this.nextId() });
    }
    this.projectedCount += accepted.length;
    return accepted;
  }

  private ignore(reason: string): readonly OpenCodeEvent[] {
    this.ignoredCount += 1;
    this.reasons.push(reason);
    return [];
  }

  private nextId(): string {
    this.idCount += 1;
    return "bridge-" + String(this.idCount);
  }

  private nextSeq(): number {
    this.seqCount += 1;
    return this.seqCount;
  }
}
