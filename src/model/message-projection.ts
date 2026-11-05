// Projects senpi session entries (the JSONL transcript and `get_entries` rows) onto the opencode
// message/part shape the session read handlers serve. Only shapes opencode consumes are emitted;
// senpi-only roles and unknown entry types are dropped and counted, never thrown.

export const DEFAULT_AGENT = "build";
const TITLE_MAX_LENGTH = 120;

export type PublicMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; state: PublicToolState; time: { created: string } };

export type PublicToolState =
  | { status: "running"; input: Record<string, unknown>; metadata: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: Array<{ type: "text"; text: string }> }
  | {
      status: "error";
      input: Record<string, unknown>;
      error: { type: string; message: string };
      content: Array<{ type: "text"; text: string }>;
    };

export type PublicMessageFile = { data: string; mime: string; source: { type: "inline" } };

export type PublicUserMessage = {
  id: string;
  time: { created: string };
  type: "user";
  text: string;
  files?: PublicMessageFile[];
};

export type PublicAssistantMessage = {
  id: string;
  time: { created: string };
  type: "assistant";
  agent: string;
  model: { id: string; providerID: string };
  content: PublicMessagePart[];
};

export type PublicModelSwitchedMessage = {
  id: string;
  time: { created: string };
  type: "model-switched";
  model: { id: string; providerID: string };
};

export type PublicShellMessage = {
  id: string;
  time: { created: string };
  type: "shell";
  shellID: string;
  command: string;
  status: "running" | "exited" | "timeout" | "killed";
  exit?: number;
  output?: string;
};

export type PublicCompactionMessage = {
  id: string;
  time: { created: string };
  type: "compaction";
  status: "completed";
  reason: "auto" | "manual";
  summary: string;
};

export type PublicSessionMessage =
  | PublicUserMessage
  | PublicAssistantMessage
  | PublicModelSwitchedMessage
  | PublicShellMessage
  | PublicCompactionMessage;

export interface ProjectionStats {
  skipped: number;
  skippedTypes: string[];
}

export interface ProjectionResult extends ProjectionStats {
  messages: PublicSessionMessage[];
}

interface Stats {
  skipped: number;
  seen: Set<string>;
  skippedTypes: string[];
}

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

function isoTimestamp(value: unknown): string {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return new Date(0).toISOString();
}

function textOfUserContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (asRecord(block)?.type !== "text") continue;
    const text = asString((block as Record<string, unknown>).text);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

function filesOfUserContent(content: unknown): PublicMessageFile[] {
  if (!Array.isArray(content)) return [];
  const files: PublicMessageFile[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "image") continue;
    const data = asString(record.data);
    const mime = asString(record.mimeType);
    if (data === undefined || mime === undefined) continue;
    files.push({ data, mime, source: { type: "inline" } });
  }
  return files;
}

function toolResultText(result: Record<string, unknown>): string {
  if (!Array.isArray(result.content)) return "";
  const parts: string[] = [];
  for (const block of result.content) {
    const record = asRecord(block);
    if (record?.type !== "text") continue;
    const text = asString(record.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

function toolResultsById(entries: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const results = new Map<string, Record<string, unknown>>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "toolResult") continue;
    const toolCallId = asNonEmptyString(message.toolCallId);
    if (toolCallId === undefined) continue;
    results.set(toolCallId, message);
  }
  return results;
}

function mapToolState(
  block: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): PublicToolState {
  const input = asRecord(block.arguments) ?? {};
  if (result === undefined) return { status: "running", input, metadata: {} };
  const text = toolResultText(result);
  const content = [{ type: "text" as const, text }];
  return result.isError === true
    ? { status: "error", input, error: { type: "tool", message: text }, content }
    : { status: "completed", input, content };
}

function mapAssistantContent(
  message: Record<string, unknown>,
  createdAt: string,
  toolResults: Map<string, Record<string, unknown>>,
): PublicMessagePart[] {
  if (!Array.isArray(message.content)) return [];
  const parts: PublicMessagePart[] = [];
  for (const block of message.content) {
    const record = asRecord(block);
    if (record === undefined) continue;
    if (record.type === "text") {
      const text = asString(record.text);
      if (text !== undefined) parts.push({ type: "text", text });
      continue;
    }
    if (record.type === "thinking") {
      const text = asString(record.thinking);
      if (text !== undefined) parts.push({ type: "reasoning", text });
      continue;
    }
    if (record.type === "toolCall") {
      const id = asNonEmptyString(record.id);
      if (id === undefined) continue;
      parts.push({
        type: "tool",
        id,
        name: asString(record.name) ?? "unknown",
        state: mapToolState(record, toolResults.get(id)),
        time: { created: createdAt },
      });
    }
  }
  return parts;
}

function skip(stats: Stats, kind: string): void {
  stats.skipped += 1;
  if (!stats.seen.has(kind)) {
    stats.seen.add(kind);
    stats.skippedTypes.push(kind);
  }
}

function textOfUserEntry(message: Record<string, unknown>): string {
  const text = textOfUserContent(message.content);
  return text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH) : text;
}

function shellMessageOf(entry: Record<string, unknown>, message: Record<string, unknown>, createdAt: string): PublicShellMessage | undefined {
  const id = asNonEmptyString(entry.id);
  const command = asString(message.command);
  if (id === undefined || command === undefined) return undefined;
  const exitCode = typeof message.exitCode === "number" && Number.isFinite(message.exitCode) ? message.exitCode : undefined;
  const status =
    message.cancelled === true ? "killed" : exitCode !== undefined ? "exited" : "running";
  const output = asString(message.output);
  return {
    id,
    time: { created: createdAt },
    type: "shell",
    shellID: id,
    command,
    status,
    ...(exitCode === undefined ? {} : { exit: exitCode }),
    ...(output === undefined ? {} : { output }),
  };
}

function compactionMessageOf(
  id: string,
  summary: string,
  createdAt: string,
): PublicCompactionMessage {
  return { id, time: { created: createdAt }, type: "compaction", status: "completed", reason: "auto", summary };
}

export function projectEntries(entries: unknown[]): PublicSessionMessage[] {
  return projectEntriesWithStats(entries).messages;
}

export function projectEntriesWithStats(entries: unknown[]): ProjectionResult {
  const stats: Stats = { skipped: 0, seen: new Set(), skippedTypes: [] };
  const records: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (record === undefined) {
      skip(stats, "invalid-entry");
      continue;
    }
    records.push(record);
  }
  const toolResults = toolResultsById(records);
  const messages: PublicSessionMessage[] = [];

  for (const entry of records) {
    const type = asString(entry.type);
    const id = asNonEmptyString(entry.id);
    if (type === undefined || id === undefined) {
      skip(stats, type ?? "missing-type");
      continue;
    }
    if (type === "model_change") {
      const providerID = asString(entry.provider);
      const modelID = asString(entry.modelId);
      if (providerID === undefined || modelID === undefined) {
        skip(stats, type);
        continue;
      }
      messages.push({
        id,
        time: { created: isoTimestamp(entry.timestamp) },
        type: "model-switched",
        model: { id: modelID, providerID },
      });
      continue;
    }
    if (type === "compaction") {
      const summary = asString(entry.summary);
      if (summary === undefined) {
        skip(stats, type);
        continue;
      }
      messages.push(compactionMessageOf(id, summary, isoTimestamp(entry.timestamp)));
      continue;
    }
    if (type !== "message") {
      skip(stats, type);
      continue;
    }

    const message = asRecord(entry.message);
    if (message === undefined) {
      skip(stats, "message");
      continue;
    }
    const createdAt = isoTimestamp(entry.timestamp ?? message.timestamp);
    const role = asString(message.role);
    if (role === "user") {
      const files = filesOfUserContent(message.content);
      messages.push({
        id,
        time: { created: createdAt },
        type: "user",
        text: textOfUserEntry(message),
        ...(files.length > 0 ? { files } : {}),
      });
      continue;
    }
    if (role === "assistant") {
      messages.push({
        id,
        time: { created: createdAt },
        type: "assistant",
        agent: DEFAULT_AGENT,
        model: { id: asString(message.model) ?? "unknown", providerID: asString(message.provider) ?? "unknown" },
        content: mapAssistantContent(message, createdAt, toolResults),
      });
      continue;
    }
    if (role === "toolResult") {
      if (asNonEmptyString(message.toolCallId) === undefined) skip(stats, "toolResult");
      continue;
    }
    if (role === "bashExecution") {
      const shell = shellMessageOf(entry, message, createdAt);
      if (shell === undefined) {
        skip(stats, "bashExecution");
        continue;
      }
      messages.push(shell);
      continue;
    }
    if (role === "compactionSummary") {
      const summary = asString(message.summary);
      if (summary === undefined) {
        skip(stats, "compactionSummary");
        continue;
      }
      messages.push(compactionMessageOf(id, summary, createdAt));
      continue;
    }
    skip(stats, `message:${role ?? "unknown"}`);
  }

  return { messages, skipped: stats.skipped, skippedTypes: stats.skippedTypes };
}
