export type ToolState = {
  readonly callId: string;
  readonly arguments: string;
  readonly result: string | null;
};

export type MessageStatus = "streaming" | "complete" | "idle";

export type MessageState = {
  readonly messageId: string | null;
  readonly text: string;
  readonly thinking: string;
  readonly tools: readonly ToolState[];
  readonly status: MessageStatus;
  readonly lastSequence: number;
  readonly ignored: readonly string[];
  /** A one-line host notice (a scheduled retry) the transcript should show while it applies. */
  readonly notice: string;
};

export const STREAM_EVENT_KINDS = [
  "prompt_started",
  "partial",
  "message_end",
  "tool_call",
  "tool_result",
  "agent_idle",
  "reset",
  "auto_retry_start",
  "auto_retry_end",
] as const;

export type StreamEventKind = (typeof STREAM_EVENT_KINDS)[number];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class MessageProjector {
  private messageId: string | null = null;
  private text = "";
  private thinking = "";
  private tools: ToolState[] = [];
  private status: MessageStatus = "streaming";
  private lastSequence = -1;
  private ignored: string[] = [];
  private notice = "";

  snapshot(): MessageState {
    return {
      messageId: this.messageId,
      text: this.text,
      thinking: this.thinking,
      tools: [...this.tools],
      status: this.status,
      lastSequence: this.lastSequence,
      ignored: [...this.ignored],
      notice: this.notice,
    };
  }

  apply(raw: unknown): MessageState {
    const event = asRecord(raw);
    if (event === undefined) {
      this.ignored.push("NOT_AN_OBJECT");
      return this.snapshot();
    }
    const kind = textOf(event.kind);
    if (kind === undefined || !(STREAM_EVENT_KINDS as readonly string[]).includes(kind)) {
      this.ignored.push("UNKNOWN_EVENT:" + String(kind ?? "missing"));
      return this.snapshot();
    }
    const sequence = typeof event.sequence === "number" && Number.isInteger(event.sequence) ? event.sequence : -1;
    if (sequence >= 0 && sequence < this.lastSequence) {
      this.ignored.push("OUT_OF_ORDER:" + String(sequence));
      return this.snapshot();
    }
    if (sequence >= 0) this.lastSequence = sequence;

    const messageId = textOf(event.messageId);
    if (messageId !== undefined) this.messageId = messageId;

    switch (kind as StreamEventKind) {
      case "prompt_started": {
        this.status = "streaming";
        break;
      }
      case "partial": {
        const text = textOf(event.text);
        if (text === undefined) {
          this.ignored.push("PARTIAL_WITHOUT_TEXT");
          break;
        }
        this.text = text;
        this.status = "streaming";
        const thinking = textOf(event.thinking);
        if (thinking !== undefined) this.thinking = thinking;
        break;
      }
      case "message_end": {
        const text = textOf(event.text);
        if (text !== undefined) this.text = text;
        this.status = "complete";
        break;
      }
      case "tool_call": {
        const callId = textOf(event.callId);
        const args = textOf(event.arguments);
        if (callId === undefined || args === undefined) {
          this.ignored.push("TOOL_CALL_INCOMPLETE");
          break;
        }
        const existing = this.tools.findIndex((tool) => tool.callId === callId);
        const next: ToolState = { callId: callId, arguments: args, result: null };
        if (existing >= 0) this.tools[existing] = next;
        else this.tools.push(next);
        break;
      }
      case "tool_result": {
        const callId = textOf(event.callId);
        const result = textOf(event.result);
        if (callId === undefined || result === undefined) {
          this.ignored.push("TOOL_RESULT_INCOMPLETE");
          break;
        }
        const existing = this.tools.findIndex((tool) => tool.callId === callId);
        if (existing < 0) {
          this.tools.push({ callId: callId, arguments: "", result: result });
        } else {
          const current = this.tools[existing];
          if (current) this.tools[existing] = { ...current, result: result };
        }
        break;
      }
      case "agent_idle": {
        this.status = "idle";
        this.notice = "";
        break;
      }
      case "auto_retry_start": {
        /* The host schedules a retry after a failed attempt; saying so beats an apparently stalled turn. */
        this.notice = "Retrying after a failed attempt…";
        this.status = "streaming";
        break;
      }
      case "auto_retry_end": {
        this.notice = "";
        break;
      }
      case "reset": {
        this.text = "";
        this.thinking = "";
        this.tools = [];
        this.status = "streaming";
        break;
      }
    }
    return this.snapshot();
  }
}
