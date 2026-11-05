import { DEFAULT_AGENT } from "../model/message-projection";
import type { EventSink, OpenCodeEvent, TranslateContext } from "./types";

// Projects senpi's assistant streaming frames onto the opencode session events the TUI renders.
//
// Two wire differences shape this code:
// - `message_update` carries no message identity, so the id from `message_start` is remembered
//   until `message_end` (a message without an id gets one from `ctx.nextID()`).
// - `*_end.content` is authoritative on the wire, but the TUI overwrites the block with
//   `session.*.ended.text`, so that text must be the accumulation of the deltas it already
//   rendered.
//
// Tool calls belong to the tool lifecycle translator: `toolcall_*` frames are skipped silently.
// Unknown event types and delta kinds are counted in `stats.ignored`, never thrown.

export type StreamProjectorStats = {
  ignored: number;
};

export type StreamProjector = {
  handle: (event: unknown) => void;
  currentMessageID: () => string | undefined;
  readonly stats: StreamProjectorStats;
};

type BlockKind = "text" | "reasoning";

type DraftBlock = { text: string; streamed: boolean };

const FINISH_REASONS: Record<string, string> = {
  stop: "stop",
  length: "length",
  toolUse: "tool-calls",
  "content-filter": "content-filter",
  error: "error",
  aborted: "error",
};

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

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finishOf(value: unknown): string {
  const reason = asString(value);
  return reason === undefined ? "unknown" : (FINISH_REASONS[reason] ?? "unknown");
}

function blockKey(kind: BlockKind, ordinal: number): string {
  return `${kind}:${ordinal}`;
}

export function createStreamProjector(ctx: TranslateContext, sink: EventSink = () => {}): StreamProjector {
  const stats: StreamProjectorStats = { ignored: 0 };
  let assistantMessageID: string | undefined;
  const drafts = new Map<string, DraftBlock>();
  const settled = new Set<string>();

  const ignore = (): void => {
    stats.ignored += 1;
  };

  const emit = (type: string, data: Record<string, unknown>): void => {
    const event: OpenCodeEvent = { id: ctx.nextID(), type, created: ctx.now(), data };
    sink(event);
  };

  const startBlock = (id: string, kind: BlockKind, ordinal: number): void => {
    const key = blockKey(kind, ordinal);
    drafts.set(key, { text: "", streamed: false });
    settled.delete(key);
    emit(`session.${kind}.started`, { sessionID: ctx.sessionID, assistantMessageID: id, ordinal });
  };

  const deltaBlock = (id: string, kind: BlockKind, ordinal: number, delta: string): void => {
    const key = blockKey(kind, ordinal);
    if (settled.has(key)) return;
    const draft = drafts.get(key) ?? { text: "", streamed: false };
    drafts.set(key, { text: `${draft.text}${delta}`, streamed: true });
    emit(`session.${kind}.delta`, { sessionID: ctx.sessionID, assistantMessageID: id, ordinal, delta });
  };

  const endBlock = (id: string, kind: BlockKind, ordinal: number, content: string | undefined): void => {
    const key = blockKey(kind, ordinal);
    const draft = drafts.get(key);
    const text = draft?.streamed === true ? draft.text : (content ?? draft?.text ?? "");
    emit(`session.${kind}.ended`, { sessionID: ctx.sessionID, assistantMessageID: id, ordinal, text });
    drafts.delete(key);
    settled.add(key);
  };

  const handleMessageStart = (record: Record<string, unknown>): void => {
    const message = asRecord(record.message);
    if (message?.role !== "assistant") return;
    const id = asNonEmptyString(message.id) ?? ctx.nextID();
    assistantMessageID = id;
    drafts.clear();
    settled.clear();

    const agent = asNonEmptyString(message.agent) ?? DEFAULT_AGENT;
    const modelID = asNonEmptyString(message.model);
    const providerID = asNonEmptyString(message.provider);
    emit("session.step.started", {
      sessionID: ctx.sessionID,
      assistantMessageID: id,
      // The TUI's AssistantFooter title-cases the agent on every assistant row; an assistant frame
      // without one crashes the session view, and the durable message projection already says build.
      agent,
      ...(modelID === undefined || providerID === undefined ? {} : { model: { id: modelID, providerID } }),
      started: asNonNegativeInteger(message.timestamp) ?? ctx.now(),
    });
  };

  const handleMessageUpdate = (record: Record<string, unknown>): void => {
    const update = asRecord(record.assistantMessageEvent);
    const kind = asString(update?.type);
    if (update === undefined || kind === undefined) {
      ignore();
      return;
    }
    if (kind.startsWith("toolcall_")) return;
    const id = assistantMessageID;
    if (id === undefined) {
      ignore();
      return;
    }
    const ordinal = asNonNegativeInteger(update.contentIndex);
    if (ordinal === undefined) {
      ignore();
      return;
    }
    if (kind === "text_start") {
      startBlock(id, "text", ordinal);
      return;
    }
    if (kind === "text_delta") {
      const delta = asString(update.delta);
      if (delta === undefined) ignore();
      else deltaBlock(id, "text", ordinal, delta);
      return;
    }
    if (kind === "text_end") {
      endBlock(id, "text", ordinal, asString(update.content));
      return;
    }
    if (kind === "thinking_start") {
      startBlock(id, "reasoning", ordinal);
      return;
    }
    if (kind === "thinking_delta") {
      const delta = asString(update.delta);
      if (delta === undefined) ignore();
      else deltaBlock(id, "reasoning", ordinal, delta);
      return;
    }
    if (kind === "thinking_end") {
      endBlock(id, "reasoning", ordinal, asString(update.content));
      return;
    }
    ignore();
  };

  const handleMessageEnd = (record: Record<string, unknown>): void => {
    const message = asRecord(record.message);
    if (message?.role !== "assistant") return;
    const id = assistantMessageID;
    if (id === undefined) return;
    const usage = asRecord(message.usage) ?? asRecord(record.usage);
    const cost = asRecord(usage?.cost);
    emit("session.step.ended", {
      sessionID: ctx.sessionID,
      assistantMessageID: id,
      finish: finishOf(message.stopReason),
      tokens: {
        input: numberOrZero(usage?.input),
        output: numberOrZero(usage?.output),
        reasoning: numberOrZero(usage?.reasoning),
        cache: { read: numberOrZero(usage?.cacheRead), write: numberOrZero(usage?.cacheWrite) },
      },
      cost: numberOrZero(cost?.total),
    });
    assistantMessageID = undefined;
    drafts.clear();
    settled.clear();
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
    if (type === "message_update") {
      handleMessageUpdate(record);
      return;
    }
    if (type === "message_end") {
      handleMessageEnd(record);
      return;
    }
    ignore();
  };

  return { handle, currentMessageID: () => assistantMessageID, stats };
}
