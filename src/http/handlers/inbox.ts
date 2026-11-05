import type { SenpiSessionSummary, SenpiTransport } from "../../senpi/transport";
import { STOP_REQUIRES_INTERACTIVE_CLIENT } from "../../senpi/errors";

// Interrupt, background and pending-inbox (queue) endpoints, plus the `queue_update` diff that turns
// senpi's full-queue snapshots into per-item opencode events.
//
// The transport is injected once with setSessionInboxTransport(), the same seam the read and write
// handlers use, so handlers stay `(request, url)` and the http layer owns no connection.
//
// Wire protocol note (docs/rpc.md, senpi 2026.11.4-2):
// - A queued input is addressed by its session-unique `queuedId` (`q_<n>`), not by a client id.
//   `dequeue_message` requires `queuedId`; `edit_queued_message` requires `queuedId` AND a non-empty
//   `text`, and it keeps the input's mode. There is no host command that changes a queued input's
//   delivery, so a `delivery` change is a move: dequeue the input and re-enqueue it on the other
//   native queue (steer / follow_up) with its original text and enqueue order. That is the only
//   supported route; sending `edit_queued_message` with a `delivery` field would be refused by the
//   host's input validation (it insists on `text`) and would not change the mode.
// - A refused user Stop arrives as `stop_requires_interactive_client` (already mapped by
//   mapSenpiError) and must surface as 409, never as a generic 503.

const JSON_CONTENT_TYPE = "application/json";

export type Delivery = "steer" | "queue";
export type PendingInputType = "user" | "synthetic";

export type PendingInput = {
  id: string;
  sessionID: string;
  type: PendingInputType;
  text: string;
  delivery: Delivery;
  time: { created: string };
};

export type QueueEntry = {
  queuedId: string;
  clientMessageId?: string;
  text: string;
  mode: "steer" | "followUp";
  enqueueOrder: number;
  revision: number;
};

export type InboxEvent =
  | {
      type: "session.inbox.enqueued";
      created: number;
      data: {
        sessionID: string;
        inboxID: string;
        item: { type: PendingInputType; payload: { text: string }; delivery: Delivery };
      };
    }
  | {
      type: "session.inbox.cancelled";
      created: number;
      data: { sessionID: string; inboxID: string };
    }
  | {
      type: "session.inbox.delivery.changed";
      created: number;
      data: { sessionID: string; inboxID: string; delivery: Delivery };
    };

export interface TranslateQueueUpdateContext {
  emit?: (event: InboxEvent) => void;
  now?: () => number;
}

export type InboxCommand =
  | { type: "dequeue_message"; queuedId: string; expectedRevision?: number }
  | { type: "steer"; message: string; enqueueOrder?: number }
  | { type: "follow_up"; message: string; enqueueOrder?: number }
  | { type: "resume_session"; mode?: "continue" | "release" };

export interface InboxCommandChannel {
  request<T = unknown>(command: InboxCommand): Promise<T>;
}

export type SessionInboxTransport = Pick<
  SenpiTransport,
  "abort" | "getState" | "listSessions" | "openSession"
> & {
  readonly sessionId?: string | undefined;
  readonly raw: InboxCommandChannel;
  getPendingInputs?: (knownClientMessageIds?: readonly string[]) => Promise<unknown>;
};

let transport: SessionInboxTransport | undefined;

export function setSessionInboxTransport(next: SessionInboxTransport | undefined): void {
  transport = next;
}

export function getSessionInboxTransport(): SessionInboxTransport | undefined {
  return transport;
}

const backgrounded = new Set<string>();
const lastQueues = new Map<string, QueueEntry[]>();
const firstSeen = new Map<string, string>();

export function markSessionBackgrounded(sessionID: string): void {
  backgrounded.add(sessionID);
}

export function isSessionBackgrounded(sessionID: string): boolean {
  return backgrounded.has(sessionID);
}

export function backgroundedSessionIDs(): string[] {
  return [...backgrounded];
}

export function resetQueueSnapshots(sessionID?: string): void {
  if (sessionID === undefined) lastQueues.clear();
  else lastQueues.delete(sessionID);
}

export function snapshotQueue(sessionID: string): QueueEntry[] | undefined {
  const entries = lastQueues.get(sessionID);
  return entries === undefined ? undefined : entries.map((entry) => ({ ...entry }));
}

export function resetSessionInboxState(): void {
  backgrounded.clear();
  lastQueues.clear();
  firstSeen.clear();
}

function rememberQueue(sessionID: string, entries: readonly QueueEntry[]): void {
  lastQueues.set(
    sessionID,
    entries.map((entry) => ({ ...entry })),
  );
}

function forgetQueuedEntry(sessionID: string, queuedId: string): void {
  const entries = lastQueues.get(sessionID);
  if (entries === undefined) return;
  lastQueues.set(
    sessionID,
    entries.filter((entry) => entry.queuedId !== queuedId),
  );
}

function createdOf(sessionID: string, inboxID: string): string {
  const key = `${sessionID}\u0000${inboxID}`;
  const known = firstSeen.get(key);
  if (known !== undefined) return known;
  const created = new Date().toISOString();
  firstSeen.set(key, created);
  return created;
}

class HandlerProblem extends Error {
  readonly status: number;
  readonly tag: string;
  readonly fields: Record<string, unknown>;

  constructor(status: number, tag: string, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = "HandlerProblem";
    this.status = status;
    this.tag = tag;
    this.fields = fields;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function errorResponse(status: number, tag: string, message: string, fields: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { _tag: tag, message, ...fields });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function respond(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HandlerProblem) return errorResponse(error.status, error.tag, error.message, error.fields);
    return errorResponse(503, "ServiceUnavailableError", messageOf(error), { service: "senpi" });
  }
}

function requireTransport(): SessionInboxTransport {
  if (transport === undefined) {
    throw new HandlerProblem(503, "ServiceUnavailableError", "no senpi transport is wired into the http layer", {
      service: "senpi",
    });
  }
  return transport;
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

function sessionNotFound(sessionID: string): HandlerProblem {
  return new HandlerProblem(404, "SessionNotFoundError", `session not found: ${sessionID}`, { sessionID });
}

function inboxNotFound(sessionID: string, inboxID: string): HandlerProblem {
  return new HandlerProblem(404, "NotFoundError", `no pending input ${inboxID} in session ${sessionID}`, {
    sessionID,
    inboxID,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmed(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseDelivery(value: unknown): Delivery | undefined {
  if (value === "steer") return "steer";
  if (value === "queue" || value === "followUp" || value === "follow_up") return "queue";
  return undefined;
}

function deliveryOfMode(mode: string): Delivery {
  return mode === "steer" ? "steer" : "queue";
}

function codeOf(error: unknown): string | undefined {
  const code = asRecord(error)?.code;
  if (typeof code === "string") return code;
  const message = messageOf(error);
  return message.startsWith(STOP_REQUIRES_INTERACTIVE_CLIENT) ? STOP_REQUIRES_INTERACTIVE_CLIENT : undefined;
}

function segmentsOf(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function sessionIdFromPath(url: URL): string {
  const segments = segmentsOf(url);
  const at = segments.indexOf("session");
  const sessionID = at >= 0 ? segments[at + 1] : undefined;
  if (sessionID === undefined || sessionID.length === 0) {
    throw invalidRequest(`no session id in path ${url.pathname}`, "sessionID");
  }
  return sessionID;
}

function inboxIdFromPath(url: URL): string {
  const segments = segmentsOf(url);
  const at = segments.lastIndexOf("inbox");
  const inboxID = at >= 0 ? segments[at + 1] : undefined;
  if (inboxID === undefined || inboxID.length === 0) {
    throw invalidRequest(`no inbox id in path ${url.pathname}`, "inboxID");
  }
  return inboxID;
}

async function readOptionalBody(request: Request): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw invalidRequest("request body must be readable", "body");
  }
  if (text.trim().length === 0) return {};
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw invalidRequest("request body must be JSON", "body");
  }
  const record = asRecord(payload);
  if (record === undefined) throw invalidRequest("request body must be a JSON object", "body");
  return record;
}

function queryBoolean(url: URL, name: string): boolean | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  return value === "" || value === "true" || value === "1";
}

function queueEntryOf(value: unknown): QueueEntry | undefined {
  const row = asRecord(value);
  if (row === undefined) return undefined;
  const queuedId = asTrimmed(row.queuedId);
  const text = asString(row.text);
  const mode = row.mode;
  if (queuedId === undefined || text === undefined) return undefined;
  if (mode !== "steer" && mode !== "followUp") return undefined;
  const clientMessageId = asTrimmed(row.clientMessageId);
  return {
    queuedId,
    ...(clientMessageId === undefined ? {} : { clientMessageId }),
    text,
    mode,
    enqueueOrder: asNumber(row.enqueueOrder) ?? 0,
    revision: asNumber(row.revision) ?? 0,
  };
}

function queueEntriesOf(value: unknown): QueueEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: QueueEntry[] = [];
  for (const item of value) {
    const entry = queueEntryOf(item);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

function stateBelongsTo(state: unknown, row: SenpiSessionSummary): boolean {
  const stateId = asTrimmed(asRecord(state)?.sessionId);
  if (stateId === undefined) return true;
  return stateId === row.sessionId || stateId === row.durableSessionId;
}

/**
 * The attached session's queue. A state naming a different session says nothing about this target,
 * and acting on it would cancel another session's input, so it is refused instead of guessed at.
 */
async function readQueue(caller: SessionInboxTransport, row: SenpiSessionSummary, key: string): Promise<QueueEntry[]> {
  const state = await caller.getState();
  if (!stateBelongsTo(state, row)) {
    throw new HandlerProblem(
      503,
      "ServiceUnavailableError",
      "the attached session reported another session's state; refusing to read its queue",
      { sessionID: key },
    );
  }
  const entries = queueEntriesOf(asRecord(state)?.ordered);
  if (entries === undefined) {
    throw new HandlerProblem(503, "ServiceUnavailableError", "the host did not report an ordered queue", {
      sessionID: key,
    });
  }
  rememberQueue(key, entries);
  return entries;
}

async function resolveQueuedEntry(
  caller: SessionInboxTransport,
  row: SenpiSessionSummary,
  key: string,
  inboxID: string,
): Promise<QueueEntry> {
  const entries = await readQueue(caller, row, key);
  for (const entry of entries) {
    if (entry.queuedId === inboxID || entry.clientMessageId === inboxID) return entry;
  }
  throw inboxNotFound(key, inboxID);
}

function assertRemoved(answer: unknown, sessionID: string, inboxID: string): void {
  const status = asTrimmed(asRecord(answer)?.status);
  if (status === undefined || status === "removed" || status === "edited") return;
  if (status === "not_found" || status === "already_delivered") throw inboxNotFound(sessionID, inboxID);
  throw new HandlerProblem(409, "ConflictError", `the host refused to dequeue ${inboxID}: ${status}`, {
    sessionID,
    inboxID,
    status,
  });
}

function durableKeyOf(row: SenpiSessionSummary): string {
  return row.durableSessionId ?? row.sessionPath ?? row.sessionId;
}

function matchesRow(row: SenpiSessionSummary, sessionID: string): boolean {
  return row.durableSessionId === sessionID || row.sessionId === sessionID || row.sessionPath === sessionID;
}

async function resolveTarget(
  caller: SessionInboxTransport,
  sessionID: string,
): Promise<{ row: SenpiSessionSummary; key: string }> {
  const rows = await caller.listSessions();
  for (const row of rows) {
    if (matchesRow(row, sessionID)) return { row, key: durableKeyOf(row) };
  }
  throw sessionNotFound(sessionID);
}

/**
 * The transport holds exactly one session open; every command below acts on it. Acting on the wrong
 * session would abort or dequeue another transcript's work, so re-attach by path first and refuse
 * when there is no durable path to resume.
 */
async function ensureAttached(caller: SessionInboxTransport, row: SenpiSessionSummary): Promise<void> {
  const current = caller.sessionId;
  if (current === undefined || current === row.sessionId) return;
  if (row.sessionPath === undefined) {
    throw new HandlerProblem(
      409,
      "ConflictError",
      "the bridge holds a different session open and this one has no path to reopen",
      { sessionID: row.durableSessionId ?? row.sessionId },
    );
  }
  await caller.openSession({ sessionPath: row.sessionPath, retainOnDisconnect: true });
}

/**
 * POST /api/session/:sessionID/interrupt
 *
 * A user Stop is `abort({intent:"stop"})`, which pauses the session until human input or an explicit
 * resume (senpi#3811). A bare `abort()` is non-user cleanup and must never back this endpoint.
 */
export async function handleSessionInterrupt(request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const target = await resolveTarget(caller, sessionID);
    const body = await readOptionalBody(request);
    const resume = queryBoolean(url, "resume") ?? body.resume === true;

    await ensureAttached(caller, target.row);
    try {
      await caller.abort({ intent: "stop" });
    } catch (error) {
      if (codeOf(error) === STOP_REQUIRES_INTERACTIVE_CLIENT) {
        throw new HandlerProblem(409, "ConflictError", messageOf(error), { sessionID: target.key });
      }
      throw error;
    }
    if (resume) {
      await caller.raw.request({ type: "resume_session", mode: "continue" });
    }
    return noContent();
  });
}

/**
 * POST /api/session/:sessionID/background
 *
 * Marks the session as backgrounded in-process. senpi has no command for this and the running turn
 * is deliberately untouched: the mark is state for the active-session projection, not an operation.
 */
export async function handleSessionBackground(_request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const target = await resolveTarget(caller, sessionID);
    markSessionBackgrounded(target.key);
    return noContent();
  });
}

/**
 * GET /api/session/:sessionID/inbox
 *
 * Pending inputs from the host's durable ledger. A transport without `getPendingInputs` (the facade
 * today) answers an empty list rather than fabricating entries.
 */
export async function handleSessionInboxList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const target = await resolveTarget(caller, sessionID);
    const reader = caller.getPendingInputs;
    if (reader === undefined) return jsonResponse(200, { data: [] });

    await ensureAttached(caller, target.row);
    const answer = await reader.call(caller);
    return jsonResponse(200, { data: pendingInputsOf(answer, target.key) });
  });
}

function pendingInputsOf(answer: unknown, sessionID: string): PendingInput[] {
  const rows = Array.isArray(answer) ? answer : asRecord(answer)?.inputs;
  if (!Array.isArray(rows)) return [];
  const items: PendingInput[] = [];
  for (const row of rows) {
    const record = asRecord(row);
    if (record === undefined) continue;
    const sameSession = asTrimmed(record.sessionID);
    if (sameSession !== undefined && sameSession !== sessionID) continue;
    const text = asString(record.text) ?? asString(asRecord(record.payload)?.text);
    const id = asTrimmed(record.id) ?? asTrimmed(record.queuedId) ?? asTrimmed(record.clientMessageId);
    if (text === undefined || id === undefined) continue;
    const type = record.type === "synthetic" ? "synthetic" : "user";
    const declared = asRecord(record.time)?.created;
    const delivery = parseDelivery(record.delivery) ?? parseDelivery(record.requestedMode) ?? parseDelivery(record.mode) ?? "queue";
    items.push({
      id,
      sessionID,
      type,
      text,
      delivery,
      time: { created: asString(declared) ?? createdOf(sessionID, id) },
    });
  }
  return items;
}

/**
 * DELETE /api/session/:sessionID/inbox/:inboxID
 *
 * Removes exactly one queued input. `clear_queue` would drop every unrelated item and is never used.
 */
export async function handleSessionInboxCancel(_request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const inboxID = inboxIdFromPath(url);
    const target = await resolveTarget(caller, sessionID);

    await ensureAttached(caller, target.row);
    const entry = await resolveQueuedEntry(caller, target.row, target.key, inboxID);
    const answer = await caller.raw.request({ type: "dequeue_message", queuedId: entry.queuedId });
    assertRemoved(answer, target.key, inboxID);
    forgetQueuedEntry(target.key, entry.queuedId);
    return noContent();
  });
}

/**
 * PATCH /api/session/:sessionID/inbox/:inboxID
 *
 * Moves one queued input between the two native queues. senpi has no in-place delivery change, so
 * the move is a dequeue plus a re-enqueue carrying the original text and enqueue order. A move is
 * two commands, not one atomic step: if the host refuses the re-enqueue the input is already gone,
 * and the 503 says so instead of hiding it.
 */
export async function handleSessionInboxUpdate(request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const inboxID = inboxIdFromPath(url);
    const body = await readOptionalBody(request);
    const delivery = parseDelivery(body.delivery);
    if (delivery === undefined) {
      throw invalidRequest(`delivery must be "steer" or "queue" (found ${JSON.stringify(body.delivery)})`, "delivery");
    }

    const target = await resolveTarget(caller, sessionID);
    await ensureAttached(caller, target.row);
    const entry = await resolveQueuedEntry(caller, target.row, target.key, inboxID);
    if (deliveryOfMode(entry.mode) === delivery) return noContent();

    const answer = await caller.raw.request({ type: "dequeue_message", queuedId: entry.queuedId });
    assertRemoved(answer, target.key, inboxID);
    forgetQueuedEntry(target.key, entry.queuedId);

    const command: InboxCommand =
      delivery === "steer"
        ? { type: "steer", message: entry.text, enqueueOrder: entry.enqueueOrder }
        : { type: "follow_up", message: entry.text, enqueueOrder: entry.enqueueOrder };
    try {
      await caller.raw.request(command);
    } catch (error) {
      throw new HandlerProblem(
        503,
        "ServiceUnavailableError",
        `pending input ${inboxID} was removed but could not be re-queued as ${delivery}: ${messageOf(error)}`,
        { sessionID: target.key, inboxID, delivery },
      );
    }
    return noContent();
  });
}

/**
 * Diffs one `queue_update` frame against the queue last seen for this session and returns the
 * per-item opencode events. `ordered` is the only list that carries ids; a frame without it (older
 * hosts, derived fixtures) produces no events and leaves the snapshot alone.
 */
export function translateQueueUpdate(
  event: unknown,
  sessionID: string,
  ctx: TranslateQueueUpdateContext = {},
): InboxEvent[] {
  const frame = asRecord(event);
  if (frame === undefined || frame.type !== "queue_update") return [];
  const ordered = queueEntriesOf(frame.ordered);
  if (ordered === undefined) return [];

  const previous = lastQueues.get(sessionID) ?? [];
  const previousById = new Map(previous.map((entry) => [entry.queuedId, entry]));
  const nextById = new Map(ordered.map((entry) => [entry.queuedId, entry]));
  const created = ctx.now?.() ?? Date.now();
  const events: InboxEvent[] = [];

  for (const entry of ordered) {
    const before = previousById.get(entry.queuedId);
    if (before === undefined) {
      events.push({
        type: "session.inbox.enqueued",
        created,
        data: {
          sessionID,
          inboxID: entry.queuedId,
          item: { type: "user", payload: { text: entry.text }, delivery: deliveryOfMode(entry.mode) },
        },
      });
      continue;
    }
    if (before.mode !== entry.mode) {
      events.push({
        type: "session.inbox.delivery.changed",
        created,
        data: { sessionID, inboxID: entry.queuedId, delivery: deliveryOfMode(entry.mode) },
      });
    }
  }
  for (const entry of previous) {
    if (!nextById.has(entry.queuedId)) {
      events.push({
        type: "session.inbox.cancelled",
        created,
        data: { sessionID, inboxID: entry.queuedId },
      });
    }
  }

  rememberQueue(sessionID, ordered);
  if (ctx.emit !== undefined) {
    for (const produced of events) ctx.emit(produced);
  }
  return events;
}
