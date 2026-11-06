import type { EventSink, OpenCodeEvent, TranslateContext } from "./types";

// Projects senpi's tool lifecycle frames onto the opencode session events the TUI renders.
//
// Three wire differences shape this code:
// - `toolcall_delta` names no call id, only its `contentIndex`, so the id announced by
//   `toolcall_start` is remembered per block until that block's `toolcall_end`.
// - `tool_execution_*` frames arrive after the assistant `message_end`, so the last assistant id
//   is retained past the end of the message and reused for execution events.
// - A step streams under the provisional id the runtime minted until its durable entry lands, so
//   every id written into an event is resolved through `ctx.identity.aliases`: toolcall frames
//   arrive under the provisional id and execution frames after the re-key, and both must land on
//   the same row.
// - `tool_execution_update.partialResult` is already the cumulative snapshot; it is forwarded
//   unchanged and never accumulated here.
//
// Unknown event types and toolcall kinds are counted in `stats.ignored`, never thrown.

export type PendingToolCall = {
  name: string;
  startedAt: number;
};

export type ToolProjectorStats = {
  ignored: number;
};

export type ToolProjector = {
  handle: (event: unknown) => void;
  pendingToolCalls: () => ReadonlyMap<string, PendingToolCall>;
  readonly stats: ToolProjectorStats;
};

// Block-level kinds owned by the stream translator; skipped silently so both projectors can
// consume the same frame stream without inflating each other's ignored counts.
const STREAM_BLOCK_KINDS = new Set([
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
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

function asNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function stringifyArguments(value: unknown): string | undefined {
  try {
    const text = JSON.stringify(value ?? {});
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

function firstText(content: unknown[]): string | undefined {
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "text") continue;
    const text = asString(record.text);
    if (text !== undefined && text.trim().length > 0) return text;
  }
  return undefined;
}

export function createToolProjector(ctx: TranslateContext, sink: EventSink = () => {}): ToolProjector {
  const stats: ToolProjectorStats = { ignored: 0 };
  const pending = new Map<string, PendingToolCall>();
  const messageOfCall = new Map<string, string>();
  const callAt = new Map<number, string>();
  let assistantMessageID: string | undefined;

  const ignore = (): void => {
    stats.ignored += 1;
  };

  // An id is resolved at the moment it is written into an event, never stored resolved: a call
  // announced before the entry still has to answer under the durable id after the re-key.
  const resolveMessageID = (id: string | undefined): string | undefined =>
    id === undefined ? undefined : (ctx.identity?.aliases.get(id) ?? id);

  const emit = (type: string, data: Record<string, unknown>): number => {
    const event: OpenCodeEvent = { id: ctx.nextID(), type, created: ctx.now(), data };
    sink(event);
    return event.created;
  };

  // Execution frames carry no message identity; prefer the id remembered for the call itself over
  // the currently open message, since the call may belong to the previous assistant message.
  const messageOf = (callID: string): string | undefined =>
    resolveMessageID(messageOfCall.get(callID) ?? assistantMessageID);

  const handleMessageStart = (record: Record<string, unknown>): void => {
    const message = asRecord(record.message);
    if (message?.role !== "assistant") return;
    // A message without an id cannot be correlated with the stream translator's message, so tool
    // frames for it are dropped rather than emitted against a guessed id.
    assistantMessageID = asNonEmptyString(message.id);
    callAt.clear();
  };

  const startToolCall = (record: Record<string, unknown>, update: Record<string, unknown>, contentIndex: number): void => {
    const id = asNonEmptyString(update.id);
    const name = asNonEmptyString(update.toolName) ?? asNonEmptyString(record.resolvedToolName);
    const messageID = assistantMessageID;
    if (id === undefined || name === undefined || messageID === undefined) {
      ignore();
      return;
    }
    const startedAt = emit("session.tool.input.started", {
      sessionID: ctx.sessionID,
      assistantMessageID: resolveMessageID(messageID),
      id,
      name,
    });
    pending.set(id, { name, startedAt });
    messageOfCall.set(id, messageID);
    callAt.set(contentIndex, id);
  };

  const deltaToolCall = (update: Record<string, unknown>, contentIndex: number): void => {
    const id = callAt.get(contentIndex);
    const delta = asString(update.delta);
    const messageID = id === undefined ? undefined : messageOfCall.get(id);
    if (id === undefined || delta === undefined || messageID === undefined) {
      ignore();
      return;
    }
    emit("session.tool.input.delta", { sessionID: ctx.sessionID, assistantMessageID: messageID, id, delta });
  };

  const endToolCall = (update: Record<string, unknown>, contentIndex: number): void => {
    const toolCall = asRecord(update.toolCall);
    const id = asNonEmptyString(toolCall?.id) ?? callAt.get(contentIndex);
    const messageID = id === undefined ? undefined : messageOfCall.get(id);
    const text = stringifyArguments(toolCall?.arguments);
    if (id === undefined || messageID === undefined || text === undefined) {
      ignore();
      return;
    }
    emit("session.tool.input.ended", { sessionID: ctx.sessionID, assistantMessageID: messageID, id, text });
    // The block is settled: a late delta for it is dropped, like the stream translator does.
    callAt.delete(contentIndex);
  };

  const handleMessageUpdate = (record: Record<string, unknown>): void => {
    const update = asRecord(record.assistantMessageEvent);
    const kind = asString(update?.type);
    if (update === undefined || kind === undefined) {
      ignore();
      return;
    }
    if (STREAM_BLOCK_KINDS.has(kind)) return;
    const contentIndex = asNonNegativeInteger(update.contentIndex);
    if (contentIndex === undefined) {
      ignore();
      return;
    }
    if (kind === "toolcall_start") {
      startToolCall(record, update, contentIndex);
      return;
    }
    if (kind === "toolcall_delta") {
      deltaToolCall(update, contentIndex);
      return;
    }
    if (kind === "toolcall_end") {
      endToolCall(update, contentIndex);
      return;
    }
    ignore();
  };

  const handleExecutionStart = (record: Record<string, unknown>): void => {
    const id = asNonEmptyString(record.toolCallId);
    const messageID = id === undefined ? undefined : messageOf(id);
    if (id === undefined || messageID === undefined) {
      ignore();
      return;
    }
    const input = asRecord(record.args) ?? {};
    const name = asNonEmptyString(record.toolName) ?? "unknown";
    // A call can be discovered at execution time when no `toolcall_start` was streamed. The TUI
    // only creates a tool row from `session.tool.input.started`, so a discovered call has to
    // announce the same two input events a streamed toolcall would before the execution event.
    const discovered = !pending.has(id);
    const startedAt = discovered
      ? emit("session.tool.input.started", {
          sessionID: ctx.sessionID,
          assistantMessageID: messageID,
          id,
          name,
        })
      : undefined;
    if (discovered) {
      emit("session.tool.input.ended", {
        sessionID: ctx.sessionID,
        assistantMessageID: messageID,
        id,
        text: stringifyArguments(input) ?? "{}",
      });
      pending.set(id, { name, startedAt: startedAt ?? ctx.now() });
      messageOfCall.set(id, messageID);
    }
    emit("session.tool.called", {
      sessionID: ctx.sessionID,
      assistantMessageID: messageID,
      id,
      input,
      executed: true,
    });
  };

  const handleExecutionUpdate = (record: Record<string, unknown>): void => {
    const id = asNonEmptyString(record.toolCallId);
    const messageID = id === undefined ? undefined : messageOf(id);
    const partial = asRecord(record.partialResult);
    const content = partial?.content;
    if (id === undefined || messageID === undefined || !Array.isArray(content)) {
      ignore();
      return;
    }
    const metadata: Record<string, unknown> = { content };
    const details = asRecord(partial?.details);
    if (details !== undefined) metadata.details = details;
    emit("session.tool.progress", { sessionID: ctx.sessionID, assistantMessageID: messageID, id, metadata });
  };

  const handleExecutionEnd = (record: Record<string, unknown>): void => {
    const id = asNonEmptyString(record.toolCallId);
    const messageID = id === undefined ? undefined : messageOf(id);
    const result = asRecord(record.result);
    const content = result?.content;
    if (id === undefined || messageID === undefined || !Array.isArray(content)) {
      ignore();
      return;
    }
    const metadata = asRecord(result?.details);
    if (record.isError === true) {
      emit("session.tool.failed", {
        sessionID: ctx.sessionID,
        assistantMessageID: messageID,
        id,
        // The TUI's `SessionError.Error` requires an object; a bare string renders as no error at all.
        error: { type: "tool_error", message: firstText(content) ?? "tool failed" },
        ...(content.length === 0 ? {} : { content }),
        executed: true,
      });
    } else {
      emit("session.tool.success", {
        sessionID: ctx.sessionID,
        assistantMessageID: messageID,
        id,
        // The TUI's completed state requires a non-empty model representation.
        content: content.length === 0 ? [{ type: "text", text: "" }] : content,
        ...(metadata === undefined ? {} : { metadata }),
        executed: true,
      });
    }
    pending.delete(id);
    messageOfCall.delete(id);
    for (const [index, call] of callAt) if (call === id) callAt.delete(index);
  };

  const handle = (event: unknown): void => {
    const record = asRecord(event);
    const type = asString(record?.type);
    if (record === undefined || type === undefined) {
      ignore();
      return;
    }
    if (type === "message_start") {
      handleMessageStart(record);
      return;
    }
    // The identity is retained on purpose: `tool_execution_*` follows the message end.
    if (type === "message_end") return;
    if (type === "message_update") {
      handleMessageUpdate(record);
      return;
    }
    if (type === "tool_execution_start") {
      handleExecutionStart(record);
      return;
    }
    if (type === "tool_execution_update") {
      handleExecutionUpdate(record);
      return;
    }
    if (type === "tool_execution_end") {
      handleExecutionEnd(record);
      return;
    }
    ignore();
  };

  return { handle, pendingToolCalls: () => new Map(pending), stats };
}
