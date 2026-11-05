import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { emptySessionUsage, readTranscriptEntries, sessionKeyOf, type SessionUsage } from "../../model/session-map";
import type { SenpiEntriesResult, SenpiMessages, SenpiTransport } from "../../senpi/transport";
import { mediaUriFor, wantsMediaRefs } from "./media";
import { getSessionManagementStore } from "./session-write";
import { HandlerProblem, jsonResponse, noContent, messageOf, respond } from "./problem";

// Read-only session endpoints. Handlers take (request, url) and read ids from url.pathname, so the
// transport is injected once with setSessionReadTransport() instead of arriving through a router.

const SSE_CONTENT_TYPE = "text/event-stream";
const DEFAULT_PAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;
export const SESSION_WAIT_TIMEOUT_MS = 5_000;
let sessionWaitTimeoutMs = SESSION_WAIT_TIMEOUT_MS;

/** Overrides the wait deadline (ms). Tests inject a short deadline; production keeps the default. */
export function setSessionWaitTimeoutMs(value: number): void {
  sessionWaitTimeoutMs = value;
}
const DEFAULT_AGENT = "build"; // senpi has no agent selection; this is the projection

export type SessionReadTransport = Pick<
  SenpiTransport,
  "listSessions" | "getState" | "getEntries" | "getMessages" | "openSession"
> & {
  readonly sessionId?: string | undefined;
  /** True while the attached session has a run in flight; a sibling read may not attach then. */
  readonly streaming: boolean;
  waitForIdle?: (timeout?: number) => Promise<void>;
};

let transport: SessionReadTransport | undefined;

export function setSessionReadTransport(next: SessionReadTransport | undefined): void {
  transport = next;
}

export function getSessionReadTransport(): SessionReadTransport | undefined {
  return transport;
}

export type PublicSessionInfo = {
  id: string;
  projectID: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  time: { created: number; updated: number; archived?: number };
  title: string;
  location: { directory: string };
};

export type PublicMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; state: PublicToolState; time: { created: number } };

export type PublicToolState =
  | { status: "running"; input: Record<string, unknown>; metadata: Record<string, unknown> }
  | { status: "completed"; input: Record<string, unknown>; content: Array<{ type: "text"; text: string }> }
  | {
      status: "error";
      input: Record<string, unknown>;
      error: { type: string; message: string };
      content: Array<{ type: "text"; text: string }>;
    };

export type PublicMessageFile =
  | { data: string; mime: string; source: { type: "inline" } }
  | { uri: string; mime: string; source: { type: "inline" }; bytes: number };

export type PublicSessionMessage = {
  id: string;
  time: { created: number };
  type: string;
  text?: string;
  agent?: string;
  model?: { id: string; providerID: string };
  previous?: { id: string; providerID: string };
  content?: PublicMessagePart[];
  files?: PublicMessageFile[];
};

type MappedSession = {
  id: string;
  routeId: string;
  info: PublicSessionInfo;
};

type SessionEntry = SenpiEntriesResult["entries"][number];
type AgentMessage = SenpiMessages[number];
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

export type PublicCursor = { previous?: string; next?: string };

function requireTransport(): SessionReadTransport {
  if (transport === undefined) {
    throw new HandlerProblem(503, "ServiceUnavailableError", "no senpi transport is wired into the http layer", {
      service: "senpi",
    });
  }
  return transport;
}

function sessionNotFound(sessionID: string): HandlerProblem {
  return new HandlerProblem(404, "SessionNotFoundError", `session not found: ${sessionID}`, { sessionID });
}

function messageNotFound(sessionID: string, messageID: string): HandlerProblem {
  return new HandlerProblem(404, "MessageNotFoundError", `message not found: ${messageID}`, {
    sessionID,
    messageID,
  });
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

function invalidCursor(message: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidCursorError", message);
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function sessionIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("session");
  const sessionID = at >= 0 ? segments[at + 1] : undefined;
  if (sessionID === undefined || sessionID.length === 0) {
    throw new HandlerProblem(400, "InvalidRequestError", `no session id in path ${url.pathname}`, { field: "sessionID" });
  }
  return sessionID;
}

function messageIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("session");
  const messageID = at >= 0 && segments[at + 2] === "message" ? segments[at + 3] : undefined;
  if (messageID === undefined || messageID.length === 0) {
    throw new HandlerProblem(400, "InvalidRequestError", `no message id in path ${url.pathname}`, { field: "messageID" });
  }
  return messageID;
}

function readLimit(url: URL, fallback: number, max?: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw invalidRequest(`limit must be a positive integer (found ${JSON.stringify(raw)})`, "limit");
  }
  if (max !== undefined && value > max) {
    throw invalidRequest(`limit must be at most ${max} (found ${value})`, "limit");
  }
  return value;
}

type MessageOrder = "asc" | "desc";

/** `session.message` declares `order=asc|desc` for the first page: desc is newest first. */
function readMessageOrder(url: URL): MessageOrder | undefined {
  const raw = url.searchParams.get("order");
  if (raw === null || raw.trim().length === 0) return undefined;
  const value = raw.trim();
  if (value !== "asc" && value !== "desc") {
    throw invalidRequest(`order must be asc or desc (found ${JSON.stringify(raw)})`, "order");
  }
  return value;
}

function encodeCursor(offset: number, order?: MessageOrder): string {
  return Buffer.from(JSON.stringify(order === undefined ? { offset } : { offset, order }), "utf8").toString(
    "base64url",
  );
}

/** Reads the offset plus the order a message cursor was issued with, so later pages keep its direction. */
function readMessageCursor(url: URL): { offset: number; order: MessageOrder | undefined } {
  const raw = url.searchParams.get("cursor");
  if (raw === null || raw.trim().length === 0) return { offset: 0, order: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor("cursor is not a cursor this endpoint issued");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as { offset?: unknown; order?: unknown }) : {};
  const offset = record.offset;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw invalidCursor("cursor is not a cursor this endpoint issued");
  }
  const order = record.order === "asc" || record.order === "desc" ? record.order : undefined;
  return { offset, order };
}

function pageCursor(
  offset: number,
  returned: number,
  total: number,
  limit: number,
  order?: MessageOrder,
): PublicCursor {
  const cursor: PublicCursor = {};
  if (offset > 0) cursor.previous = encodeCursor(Math.max(0, offset - limit), order);
  if (offset + returned < total) cursor.next = encodeCursor(offset + returned, order);
  return cursor;
}

function readCursor(url: URL): number {
  return readMessageCursor(url).offset;
}

function projectIdOf(cwd: string): string {
  return createHash("sha256").update(cwd, "utf8").digest("hex");
}

// Session.Info.time decodes from epoch millis; ISO strings reach the TUI as NaNy in every row.
function sessionTimes(id: string, sessionPath: string | undefined): { created: number; updated: number } {
  let created: number | undefined;
  let updated: number | undefined;
  if (sessionPath !== undefined) {
    try {
      const stat = statSync(sessionPath);
      const born = Math.max(0, Math.trunc(stat.birthtimeMs));
      const modified = Math.max(0, Math.trunc(stat.mtimeMs));
      created = born;
      updated = modified;
    } catch {
    }
  }
  if (created === undefined || updated === undefined) {
    const observedAt = Date.now();
    const previous = observed.get(id);
    created ??= previous?.created ?? observedAt;
    updated ??= previous?.updated ?? observedAt;
    observed.set(id, { created, updated });
  }
  return { created, updated };
}

const observed = new Map<string, { created: number; updated: number }>();

function sessionIdOf(row: SenpiEntriesRow): string {
  return row.durableSessionId ?? row.sessionPath ?? row.sessionId;
}

type SenpiEntriesRow = Awaited<ReturnType<SessionReadTransport["listSessions"]>>[number];

/** Archive state is bridge-side (`SessionMap`); the transport listing itself never carries it. */
function archivedAtOf(row: SenpiEntriesRow): number | undefined {
  const store = getSessionManagementStore();
  if (store === undefined) return undefined;
  const record = store.get(sessionKeyOf(row));
  if (record?.archived !== true) return undefined;
  const parsed = Date.parse(record.archivedAt ?? record.lastSeenAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Usage is bridge-side state: the dispatch path adds each run's `session.usage.updated` total to the
 * session map, and the map re-seeds from the transcript on reconnect. A row the map has not adopted
 * has no reported usage, so the contract's zero is the absence of data, not an estimate.
 */
function usageOf(row: SenpiEntriesRow): SessionUsage {
  return getSessionManagementStore()?.get(sessionKeyOf(row))?.usage ?? emptySessionUsage();
}

function toMappedSession(row: SenpiEntriesRow): MappedSession {
  const id = sessionIdOf(row);
  const time = sessionTimes(id, row.sessionPath);
  const archived = archivedAtOf(row);
  const usage = usageOf(row);
  const info: PublicSessionInfo = {
    id,
    projectID: projectIdOf(row.cwd),
    cost: usage.cost,
    tokens: { ...usage.tokens, cache: { ...usage.tokens.cache } },
    time: { ...time, ...(archived === undefined ? {} : { archived }) },
    title: row.name ?? basename(row.cwd),
    location: { directory: row.cwd },
  };
  return { id, routeId: row.sessionId, info };
}

function matchesSession(mapped: MappedSession, row: SenpiEntriesRow, sessionID: string): boolean {
  return mapped.id === sessionID || mapped.routeId === sessionID || row.durableSessionId === sessionID;
}

function listMappedSessions(caller: SessionReadTransport): Promise<MappedSession[]> {
  return caller.listSessions().then((rows) => {
    const mapped = rows.map(toMappedSession);
    mapped.sort((left, right) => {
      const byUpdated = right.info.time.updated - left.info.time.updated;
      return byUpdated !== 0 ? byUpdated : left.id.localeCompare(right.id);
    });
    return mapped;
  });
}

async function requireMappedSession(
  caller: SessionReadTransport,
  sessionID: string,
): Promise<{ mapped: MappedSession; row: SenpiEntriesRow }> {
  const rows = await caller.listSessions();
  for (const row of rows) {
    const mapped = toMappedSession(row);
    if (matchesSession(mapped, row, sessionID)) return { mapped, row };
  }
  throw sessionNotFound(sessionID);
}

// Entries and messages are read from the connection's attached session, not from an id in the
// request, so a read must never move that attachment while a run is in flight: the pinned client
// holds one routing id and drops every frame tagged with another, which silences the running turn.
// A sibling read during a run is therefore projected from the session's own transcript, and only an
// idle transport re-attaches the requested session before reading it.
function conflictFor(row: SenpiEntriesRow, message: string): HandlerProblem {
  return new HandlerProblem(409, "ConflictError", `session ${sessionIdOf(row)}: ${message}`, {
    sessionID: sessionIdOf(row),
  });
}

function entryOf(record: Record<string, unknown>): SessionEntry | undefined {
  return record.type === "message" || record.type === "model_change" ? (record as unknown as SessionEntry) : undefined;
}

function projectedMessages(row: SenpiEntriesRow, mediaRefs: boolean): PublicSessionMessage[] {
  if (row.sessionPath === undefined) throw conflictFor(row, "the host lists no transcript path to read");
  const records = readTranscriptEntries(row.sessionPath);
  if (records === undefined) throw conflictFor(row, "its transcript is not readable while another session runs");
  try {
    const entries = records.map(entryOf).filter((entry): entry is SessionEntry => entry !== undefined);
    return mapEntries(entries, mediaRefs);
  } catch (error) {
    throw conflictFor(row, `its transcript could not be projected (${messageOf(error)})`);
  }
}

async function readMessagesFor(
  caller: SessionReadTransport,
  row: SenpiEntriesRow,
  mediaRefs: boolean,
): Promise<PublicSessionMessage[]> {
  if (caller.sessionId !== undefined && caller.sessionId === row.sessionId) return readMessages(caller, mediaRefs);
  if (caller.streaming) return projectedMessages(row, mediaRefs);
  if (row.sessionPath === undefined) throw conflictFor(row, "it is not attached and the host lists no path to open");
  await caller.openSession({ sessionPath: row.sessionPath, retainOnDisconnect: true });
  const messages = await readMessages(caller, mediaRefs);
  if (caller.sessionId !== row.sessionId) throw conflictFor(row, "the attachment moved while it was being read");
  return messages;
}

function timestampMillis(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  return 0;
}

function textOfUserContent(content: Extract<AgentMessage, { role: "user" }>["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is Extract<(typeof content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function filesOfUserContent(
  content: Extract<AgentMessage, { role: "user" }>["content"],
  mediaRefs: boolean,
): PublicMessageFile[] {
  if (typeof content === "string") return [];
  const files: PublicMessageFile[] = [];
  for (const block of content) {
    if (block.type !== "image") continue;
    const source = { type: "inline" as const };
    if (!mediaRefs) {
      files.push({ data: block.data, mime: block.mimeType, source });
      continue;
    }
    const bytes = Buffer.from(block.data, "base64");
    files.push({ uri: mediaUriFor(bytes, block.mimeType), mime: block.mimeType, source, bytes: bytes.byteLength });
  }
  return files;
}

function toolResultText(result: ToolResultMessage): string {
  return result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolResultsById(entries: SessionEntry[]): Map<string, ToolResultMessage> {
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult") continue;
    results.set(message.toolCallId, message);
  }
  return results;
}

function mapAssistantContent(
  message: Extract<AgentMessage, { role: "assistant" }>,
  createdAt: number,
  toolResults: Map<string, ToolResultMessage>,
): PublicMessagePart[] {
  const parts: PublicMessagePart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "thinking") {
      parts.push({ type: "reasoning", text: block.thinking });
      continue;
    }
    if (block.type === "toolCall") {
      const result = toolResults.get(block.id);
      const input = block.arguments as Record<string, unknown>;
      let state: PublicToolState;
      if (result === undefined) {
        state = { status: "running", input, metadata: {} };
      } else {
        const text = toolResultText(result);
        const content = text.length > 0 ? [{ type: "text" as const, text }] : [{ type: "text" as const, text: "" }];
        state = result.isError
          ? { status: "error", input, error: { type: "tool", message: text }, content }
          : { status: "completed", input, content };
      }
      parts.push({ type: "tool", id: block.id, name: block.name, state, time: { created: createdAt } });
    }
  }
  return parts;
}

function mapEntries(entries: SessionEntry[], mediaRefs: boolean): PublicSessionMessage[] {
  const toolResults = toolResultsById(entries);
  const messages: PublicSessionMessage[] = [];
  for (const entry of entries) {
    if (entry.type === "model_change") {
      messages.push({
        id: entry.id,
        time: { created: timestampMillis(entry.timestamp) },
        type: "model-switched",
        model: { id: entry.modelId, providerID: entry.provider },
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    const createdAt = timestampMillis(entry.timestamp);
    if (message.role === "user") {
      const files = filesOfUserContent(message.content, mediaRefs);
      messages.push({
        id: entry.id,
        time: { created: createdAt },
        type: "user",
        text: textOfUserContent(message.content),
        ...(files.length > 0 ? { files } : {}),
      });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({
        id: entry.id,
        time: { created: createdAt },
        type: "assistant",
        agent: DEFAULT_AGENT,
        model: { id: message.model, providerID: message.provider },
        content: mapAssistantContent(message, createdAt, toolResults),
      });
    }
  }
  return messages;
}

// Entries carry durable ids; a host that refuses the unpaged read falls back to projected messages,
// whose ids are positional and stable only while the transcript stays append-only.
async function readMessages(caller: SessionReadTransport, mediaRefs: boolean): Promise<PublicSessionMessage[]> {
  let entries: SessionEntry[] | undefined;
  try {
    entries = (await caller.getEntries()).entries;
  } catch {
    entries = undefined;
  }
  if (entries !== undefined) return mapEntries(entries, mediaRefs);

  const messages = await caller.getMessages();
  const toolResults = new Map<string, ToolResultMessage>();
  for (const message of messages) if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
  const mapped: PublicSessionMessage[] = [];
  messages.forEach((message, index) => {
    const createdAt = timestampMillis(message.timestamp);
    const id = `message-${index}`;
    if (message.role === "user") {
      const files = filesOfUserContent(message.content, mediaRefs);
      mapped.push({
        id,
        time: { created: createdAt },
        type: "user",
        text: textOfUserContent(message.content),
        ...(files.length > 0 ? { files } : {}),
      });
      return;
    }
    if (message.role === "assistant") {
      mapped.push({
        id,
        time: { created: createdAt },
        type: "assistant",
        agent: DEFAULT_AGENT,
        model: { id: message.model, providerID: message.provider },
        content: mapAssistantContent(message, createdAt, toolResults),
      });
    }
  });
  return mapped;
}

function pageCursorFor<T>(items: T[], offset: number, limit: number, order?: MessageOrder): { page: T[]; cursor: PublicCursor } {
  const page = items.slice(offset, offset + limit);
  return { page, cursor: pageCursor(offset, page.length, items.length, limit, order) };
}

function paginate<T>(items: T[], offset: number, limit: number): { page: T[]; cursor: PublicCursor } {
  return pageCursorFor(items, offset, limit);
}

export async function handleSessionList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const limit = readLimit(url, DEFAULT_PAGE_LIMIT);
    const offset = readCursor(url);
    const archived = readArchived(url);
    const sessions = (await listMappedSessions(caller)).filter((session) =>
      archived === undefined ? true : (session.info.time.archived !== undefined) === archived,
    );
    const { page, cursor } = paginate(sessions, offset, limit);
    return jsonResponse(200, { data: page.map((session) => session.info), cursor });
  });
}

/** `archived` is the TUI's list filter: absent means both, matching the endpoint's schema. */
function readArchived(url: URL): boolean | undefined {
  const raw = url.searchParams.get("archived");
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

export async function handleSessionActive(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const rows = await caller.listSessions();
    const data: Record<string, { type: "running" }> = {};
    for (const row of rows) {
      let state: Awaited<ReturnType<SessionReadTransport["getState"]>>;
      try {
        state = await caller.getState();
      } catch {
        continue;
      }
      if (!state.isStreaming) continue;
      // The transport reads the session it holds open, so drop a state that belongs to another one.
      if (state.sessionId !== row.sessionId && state.sessionId !== row.durableSessionId) continue;
      data[sessionIdOf(row)] = { type: "running" };
    }
    return jsonResponse(200, { data });
  });
}

export async function handleSessionGet(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const { mapped } = await requireMappedSession(caller, sessionID);
    return jsonResponse(200, { data: mapped.info });
  });
}

export async function handleSessionMessages(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const { row } = await requireMappedSession(caller, sessionID);
    const limit = readLimit(url, DEFAULT_PAGE_LIMIT, MAX_MESSAGE_LIMIT);
    const cursor = readMessageCursor(url);
    const order = cursor.order ?? readMessageOrder(url) ?? "asc";
    const messages = await readMessagesFor(caller, row, wantsMediaRefs(request));
    const ordered = order === "desc" ? [...messages].reverse() : messages;
    const { page, cursor: next } = pageCursorFor(ordered, cursor.offset, limit, order);
    return jsonResponse(200, { data: page, cursor: next });
  });
}

// `session.export` is `{data: {info: PublicSessionInfo, messages: PublicSessionMessage[]}}`. The bridge
// already projects both halves for session.get and message.list, so the export composes them instead
// of leaving a TUI slash command (/export) on an unmounted route.
export async function handleSessionExport(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const { mapped, row } = await requireMappedSession(caller, sessionID);
    const messages = await readMessagesFor(caller, row, wantsMediaRefs(request));
    return jsonResponse(200, { data: { info: mapped.info, messages } });
  });
}

export async function handleSessionMessageGet(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const messageID = messageIdFromPath(url);
    const { row } = await requireMappedSession(caller, sessionID);
    const messages = await readMessagesFor(caller, row, wantsMediaRefs(request));
    const message = messages.find((candidate) => candidate.id === messageID);
    if (message === undefined) throw messageNotFound(sessionID, messageID);
    return jsonResponse(200, { data: message });
  });
}

export async function handleSessionDiff(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    await requireMappedSession(caller, sessionID);
    // A turn diff needs the snapshot the host took before the turn; senpi keeps none, and the
    // working-tree diff would answer a different question. DEGRADATIONS.md declares this empty read.
    return jsonResponse(200, { data: [] });
  });
}

async function waitWithDeadline(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([operation.catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function handleSessionWait(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    await requireMappedSession(caller, sessionID);
    const waitForIdle = caller.waitForIdle;
    if (typeof waitForIdle !== "function") return noContent();
    const deadlineMs = sessionWaitTimeoutMs;
    await waitWithDeadline(waitForIdle.call(caller, deadlineMs), deadlineMs);
    return noContent();
  });
}

const viewedAt = new Map<string, string | number>();

export function viewedAtFor(sessionID: string): string | number | undefined {
  return viewedAt.get(sessionID);
}

export async function handleSessionView(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    await requireMappedSession(caller, sessionID);
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      throw invalidRequest("view payload must be JSON", "idle");
    }
    const idle = typeof payload === "object" && payload !== null ? (payload as { idle?: unknown }).idle : undefined;
    if (typeof idle !== "number" && typeof idle !== "string") {
      throw invalidRequest("view payload needs an idle timestamp", "idle");
    }
    viewedAt.set(sessionID, idle);
    return noContent();
  });
}

export async function handleSessionLog(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    await requireMappedSession(caller, sessionID);
    // One comment frame, then the body ends: a minimal SSE stream the TUI can open and close.
    return new Response(": session log stream closed\n\n", {
      status: 200,
      headers: { "content-type": SSE_CONTENT_TYPE, "cache-control": "no-cache" },
    });
  });
}
