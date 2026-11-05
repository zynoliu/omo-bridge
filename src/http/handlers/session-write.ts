import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  MAX_LIST_LIMIT,
  projectFor,
  toPublicSessionInfo,
  type SessionListRow,
  type SessionListPage,
  type SessionMap,
  type SessionPermission,
  type SessionRecord,
} from "../../model/session-map";
import type { SenpiSessionSummary } from "../../senpi/transport";
import { eventBus } from "../events";
import { HandlerProblem, jsonResponse, noContent, messageOf, respond } from "./problem";

// Session management writes: rename, archive, delete, fork, move, compact, revert and the shell
// environment. Handlers take (request, url) and read ids from url.pathname, so the senpi transport
// and the bridge-side session map are injected once instead of arriving through a router.
//
// Every capability the senpi facade cannot express is declared optional on the seam. A write that
// the attached host cannot perform answers the endpoint's declared error instead of a fake 204:
// `InvalidRequestError` at 400 (the tag every one of these endpoints declares).

const MAX_DELETED_TOMBSTONES = 4096;
const ENVIRONMENT_METADATA_KEY = "environment";

export type Delivery = "steer" | "queue";

/**
 * The slice of `SenpiTransport` these handlers drive, plus the optional mutation capabilities an
 * older facade may not wrap yet. Each optional member is a real host command: `compact`, `fork`,
 * `clone`, `closeSession` and `unloadSession` all exist on `RpcClient`.
 */
export type SessionManagementTransport = {
  readonly sessionId?: string | undefined;
  listSessions?: () => Promise<SenpiSessionSummary[]>;
  openSession?: (options: {
    sessionPath?: string;
    cwd?: string;
    retainOnDisconnect?: boolean;
  }) => Promise<unknown>;
  setSessionName?: (name: string) => Promise<void>;
  compact?: (customInstructions?: string) => Promise<unknown>;
  fork?: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled?: boolean; text?: string }>;
  clone?: () => Promise<{ cancelled?: boolean }>;
  closeSession?: (sessionId?: string) => Promise<void>;
  unloadSession?: (options: {
    sessionId?: string;
    force?: boolean;
    children?: "refuse" | "detach";
  }) => Promise<unknown>;
  revertStage?: (options: { messageID: string; files?: boolean }) => Promise<{ data: Record<string, unknown> }>;
  revertClear?: () => Promise<void>;
  revertCommit?: () => Promise<void>;
};

/** The bridge-side session state these handlers mutate; `SessionMap` backs it in production. */
export type SessionManagementStore = {
  get: (key: string) => SessionRecord | undefined;
  list: (options?: { limit?: number; cursor?: string; includeArchived?: boolean }) => SessionListPage;
  rename: (key: string, title: string) => SessionRecord | undefined;
  archive: (key: string, archived?: boolean) => SessionRecord | undefined;
  remove: (key: string) => boolean;
  upsert: (row: SessionListRow, seenAt?: string) => SessionRecord;
  update: (key: string, patch: SessionManagementPatch) => SessionRecord | undefined;
};

export type SessionManagementPatch = {
  metadata?: Record<string, unknown>;
  permissions?: SessionPermission[];
  cwd?: string;
};

export type PublicSessionInfo = ReturnType<typeof toPublicSessionInfo>;

let transport: SessionManagementTransport | undefined;
let store: SessionManagementStore | undefined;

export function setSessionManagementTransport(next: SessionManagementTransport | undefined): void {
  transport = next;
}

export function getSessionManagementTransport(): SessionManagementTransport | undefined {
  return transport;
}

export function setSessionManagementStore(next: SessionManagementStore | undefined): void {
  store = next;
}

export function getSessionManagementStore(): SessionManagementStore | undefined {
  return store;
}

// A deleted durable session must stay deleted: senpi keeps its session file and a host that failed
// to unload still lists the handle, so a plain re-adoption would resurrect it. The tombstone is
// in-process only, and routing ids are never tombstoned because the host recycles them.
const deletedKeys = new Set<string>();

/** Test seam: forget the deleted-session tombstones (and nothing else). */
export function resetSessionManagementState(): void {
  deletedKeys.clear();
}

function markDeleted(...keys: Array<string | undefined>): void {
  for (const key of keys) {
    if (key === undefined || key.length === 0) continue;
    if (deletedKeys.size >= MAX_DELETED_TOMBSTONES) {
      const oldest = deletedKeys.values().next();
      if (!oldest.done) deletedKeys.delete(oldest.value);
    }
    deletedKeys.add(key);
  }
}

/**
 * Adapts `SessionMap` to the write surface. Rename, archive, remove and upsert are the map's own
 * mutators; they are flushed here because a management write is only durable once persisted.
 *
 * Metadata, permissions and cwd are bridge-side state the map carries on every record but exposes
 * no setter for in this wave, so they are applied to the live record — the map's single source of
 * truth — and flushed. A map whose record store is not reachable fails loudly (503) rather than
 * silently dropping the write, so a future `SessionMap` shape change cannot fake success.
 */
export function sessionManagementStore(map: SessionMap): SessionManagementStore {
  return {
    get: (key) => map.get(key),
    list: (options) => map.list(options),
    rename: (key, title) => {
      const record = map.rename(key, title);
      if (record !== undefined) map.flush();
      return record;
    },
    archive: (key, archived = true) => {
      const record = map.archive(key, archived);
      if (record !== undefined) map.flush();
      return record;
    },
    remove: (key) => {
      const removed = map.remove(key);
      if (removed) map.flush();
      return removed;
    },
    upsert: (row, seenAt) => {
      const record = seenAt === undefined ? map.upsert(row) : map.upsert(row, seenAt);
      map.flush();
      return record;
    },
    update: (key, patch) => {
      const record = liveRecords(map).get(key);
      if (record === undefined) return undefined;
      if (patch.metadata !== undefined) record.metadata = { ...patch.metadata };
      if (patch.permissions !== undefined) record.permissions = patch.permissions.map((entry) => ({ ...entry }));
      if (patch.cwd !== undefined) {
        record.cwd = patch.cwd;
        record.projectID = projectFor(patch.cwd).id;
      }
      map.flush();
      return map.get(key);
    },
  };
}

function liveRecords(map: SessionMap): Map<string, SessionRecord> {
  const candidate = (map as unknown as { records?: unknown }).records;
  if (!(candidate instanceof Map)) {
    throw new HandlerProblem(
      503,
      "ServiceUnavailableError",
      "the session map exposes no mutable record store to persist this write",
      { service: "session-map" },
    );
  }
  return candidate as Map<string, SessionRecord>;
}

function requireTransport(): SessionManagementTransport {
  if (transport === undefined) {
    throw new HandlerProblem(503, "ServiceUnavailableError", "no senpi transport is wired into the http layer", {
      service: "senpi",
    });
  }
  return transport;
}

function requireStore(): SessionManagementStore {
  if (store === undefined) {
    throw new HandlerProblem(503, "ServiceUnavailableError", "no session map is wired into the http layer", {
      service: "session-map",
    });
  }
  return store;
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

/**
 * A host that cannot perform the write at all. `InvalidRequestError` is declared at 400 by every
 * endpoint that calls this; 501 is not in their `declaredStatuses`, so the client would report an
 * UnexpectedStatus instead of the declared error.
 */
function unsupportedCapability(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field, kind: "unsupported" });
}

/** A revert the bridge cannot express: the endpoint declares `InvalidRequestError` at 400. */
function declaredUnsupported(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field, kind: "unsupported" });
}

function sessionNotFound(sessionID: string): HandlerProblem {
  return new HandlerProblem(404, "SessionNotFoundError", `session not found: ${sessionID}`, { sessionID });
}

function conflict(message: string, sessionID: string): HandlerProblem {
  return new HandlerProblem(409, "ConflictError", message, { sessionID });
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

async function readBody(request: Request, options: { required?: boolean } = {}): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw invalidRequest("request body must be readable", "body");
  }
  if (text.trim().length === 0) {
    if (options.required === true) throw invalidRequest("request body must be JSON", "body");
    return {};
  }
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
    throw invalidRequest(`no session id in path ${url.pathname}`, "sessionID");
  }
  return sessionID;
}

function parseDelivery(value: unknown): Delivery | undefined {
  if (value === "steer") return "steer";
  if (value === "queue") return "queue";
  return undefined;
}

function parsePermissions(value: unknown): SessionPermission[] {
  if (!Array.isArray(value)) throw invalidRequest("permissions must be an array", "permissions");
  const parsed: SessionPermission[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const action = asNonEmptyString(record?.action);
    const resource = asNonEmptyString(record?.resource);
    const effect = record?.effect;
    if (action === undefined || resource === undefined) {
      throw invalidRequest("each permission needs an action and a resource", "permissions");
    }
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") {
      throw invalidRequest(`permission effect must be "allow", "deny" or "ask" (found ${JSON.stringify(effect)})`, "permissions");
    }
    parsed.push({ action, resource, effect });
  }
  return parsed;
}

type SessionTarget = {
  key: string;
  record: SessionRecord | undefined;
  row: SenpiSessionSummary | undefined;
};

function rowKeyOf(row: SenpiSessionSummary): string {
  return row.durableSessionId ?? row.sessionPath ?? row.sessionId;
}

function rowMatches(row: SenpiSessionSummary, sessionID: string): boolean {
  return row.durableSessionId === sessionID || row.sessionId === sessionID || row.sessionPath === sessionID;
}

function rowOf(record: SessionRecord, rows: SenpiSessionSummary[]): SenpiSessionSummary | undefined {
  return rows.find(
    (row) =>
      row.durableSessionId === record.key ||
      (record.sessionPath !== undefined && row.sessionPath === record.sessionPath) ||
      (record.routingId.length > 0 && row.sessionId === record.routingId),
  );
}

/**
 * Resolves an opencode session id to the durable key the session map is filed under. The map wins
 * because it carries the bridge-side state; a session the map has not seen yet is adopted from the
 * host listing. A tombstoned key answers 404 instead of being re-adopted.
 */
async function resolveTarget(
  sessionID: string,
  caller: SessionManagementTransport | undefined = transport,
): Promise<SessionTarget> {
  const map = requireStore();
  if (deletedKeys.has(sessionID)) throw sessionNotFound(sessionID);

  const rows = caller?.listSessions === undefined ? [] : await caller.listSessions();

  const direct = map.get(sessionID);
  if (direct !== undefined) {
    if (deletedKeys.has(direct.key)) throw sessionNotFound(sessionID);
    return { key: direct.key, record: direct, row: rowOf(direct, rows) };
  }

  const row = rows.find((candidate) => rowMatches(candidate, sessionID));
  if (row !== undefined) {
    const key = rowKeyOf(row);
    if (deletedKeys.has(key)) throw sessionNotFound(sessionID);
    return { key, record: map.get(key) ?? map.upsert(row), row };
  }

  const known = map
    .list({ limit: MAX_LIST_LIMIT, includeArchived: true })
    .data.find((record) => record.routingId === sessionID || record.sessionPath === sessionID);
  if (known !== undefined) {
    if (deletedKeys.has(known.key)) throw sessionNotFound(sessionID);
    return { key: known.key, record: known, row: rowOf(known, rows) };
  }

  throw sessionNotFound(sessionID);
}

/**
 * The transport holds exactly one session open. Renaming, compacting or forking another session
 * would hit the wrong transcript, so re-attach by path when possible and refuse when there is no
 * durable path to resume.
 */
async function ensureAttached(caller: SessionManagementTransport, row: SenpiSessionSummary): Promise<void> {
  const current = caller.sessionId;
  if (current === undefined || current === row.sessionId) return;
  if (row.sessionPath === undefined) {
    throw conflict("the bridge holds a different session open and this one has no path to reopen", rowKeyOf(row));
  }
  if (typeof caller.openSession !== "function") {
    throw unsupportedCapability("the bridge cannot re-attach the target session", "sessionID");
  }
  await caller.openSession({ sessionPath: row.sessionPath, retainOnDisconnect: true });
}

/**
 * Makes a session the transport's open session before a write scoped to it. senpi's `setModel`
 * applies to whichever session the connection holds, so switching the model of another session
 * would otherwise change the wrong transcript while answering 204.
 */
export async function attachSessionTarget(
  caller: SessionManagementTransport,
  sessionID: string,
): Promise<string> {
  const target = await resolveTarget(sessionID, caller);
  if (target.row !== undefined) await ensureAttached(caller, target.row);
  return target.key;
}

/**
 * Refuses a session the bridge does not know without moving the transport's attachment, so a
 * session-scoped route that only records bridge-side state (an agent selection, a pending form)
 * still agrees with the session routes that do resolve it.
 */
export async function requireKnownSession(sessionID: string): Promise<void> {
  const caller = getSessionManagementTransport();
  if (caller === undefined || store === undefined) return;
  await resolveTarget(sessionID, caller);
}

function publish(type: string, data: Record<string, unknown>): void {
  eventBus.publish({ type, data });
}

export async function handleSessionUpdate(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request);

    const rawTitle = body.title;
    if (rawTitle !== undefined && asString(rawTitle) === undefined) {
      throw invalidRequest("title must be a string", "title");
    }
    const title = rawTitle === undefined ? undefined : asNonEmptyString(rawTitle);
    if (rawTitle !== undefined && title === undefined) {
      throw invalidRequest("title must be a non-empty string", "title");
    }
    const rawMetadata = body.metadata;
    if (rawMetadata !== undefined && asRecord(rawMetadata) === undefined) {
      throw invalidRequest("metadata must be a JSON object", "metadata");
    }
    const permissions = body.permissions === undefined ? undefined : parsePermissions(body.permissions);
    const archived = body.archived;
    if (archived !== undefined && typeof archived !== "boolean") {
      throw invalidRequest("archived must be a boolean", "archived");
    }

    const target = await resolveTarget(sessionID);
    const map = requireStore();

    if (title !== undefined) {
      const caller = requireTransport();
      const rename = caller.setSessionName;
      if (typeof rename !== "function") {
        throw unsupportedCapability("the senpi transport cannot rename a session", "title");
      }
      if (target.row !== undefined) await ensureAttached(caller, target.row);
      await rename.call(caller, title);
      map.rename(target.key, title);
      publish("session.renamed", { sessionID: target.key, title });
    }

    if (typeof archived === "boolean") {
      // Repeating the current state is a no-op and publishes nothing, exactly like the contract.
      if ((target.record?.archived === true) !== archived) {
        map.archive(target.key, archived);
        publish(archived ? "session.archived" : "session.unarchived", { sessionID: target.key });
      }
    }

    if (rawMetadata !== undefined) {
      const metadata = rawMetadata as Record<string, unknown>;
      map.update(target.key, { metadata });
      publish("session.metadata.updated", { sessionID: target.key, metadata });
    }

    if (permissions !== undefined) {
      map.update(target.key, { permissions });
      publish("session.permissions", { sessionID: target.key, permissions });
    }

    return noContent();
  });
}

export async function handleSessionRemove(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const target = await resolveTarget(sessionID);
    const map = requireStore();
    const caller = transport;

    // The bridge-side delete must survive a refused unload: the tombstone below stops re-adoption.
    if (caller !== undefined) {
      const routingId = target.row?.sessionId;
      try {
        if (typeof caller.unloadSession === "function" && routingId !== undefined) {
          await caller.unloadSession({ sessionId: routingId, force: true });
        } else if (typeof caller.closeSession === "function") {
          await caller.closeSession(routingId);
        } else {
          console.warn(`omo-bridge: session ${target.key} removed from the bridge without unloading it from senpi`);
        }
      } catch (error) {
        console.warn(`omo-bridge: session ${target.key} removed from the bridge but not unloaded: ${messageOf(error)}`);
      }
    }

    map.remove(target.key);
    markDeleted(target.key, target.record?.sessionPath);
    publish("session.deleted", { sessionID: target.key });
    return noContent();
  });
}

export async function handleSessionMove(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request, { required: true });
    const location = asRecord(body.location);
    const directory = asNonEmptyString(location?.directory) ?? asNonEmptyString(body.directory);
    if (directory === undefined) throw invalidRequest("move needs location.directory", "location");
    if (!isAbsolute(directory)) throw invalidRequest("location.directory must be an absolute path", "location");
    if (body.delivery !== undefined && parseDelivery(body.delivery) === undefined) {
      throw invalidRequest(`delivery must be "steer" or "queue" (found ${JSON.stringify(body.delivery)})`, "delivery");
    }

    const target = await resolveTarget(sessionID);
    requireStore().update(target.key, { cwd: directory });
    publish("session.moved", {
      sessionID: target.key,
      location: { directory },
      projectID: projectFor(directory).id,
    });
    return noContent();
  });
}

export async function handleSessionCompact(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request);
    const customInstructions = body.customInstructions;
    if (customInstructions !== undefined && asString(customInstructions) === undefined) {
      throw invalidRequest("customInstructions must be a string", "customInstructions");
    }
    const delivery = body.delivery === undefined ? "steer" : parseDelivery(body.delivery);
    if (delivery === undefined) {
      throw invalidRequest(`delivery must be "steer" or "queue" (found ${JSON.stringify(body.delivery)})`, "delivery");
    }

    const target = await resolveTarget(sessionID);
    const caller = requireTransport();
    const compact = caller.compact;
    if (typeof compact !== "function") {
      throw unsupportedCapability("the senpi transport cannot compact a session", "compact");
    }
    if (target.row !== undefined) await ensureAttached(caller, target.row);
    if (typeof customInstructions === "string") await compact.call(caller, customInstructions);
    else await compact.call(caller);
    // `session.compact` answers 200 `{data: Session.Inbox.Compaction}`, not an empty 204. The receipt
    // names the compaction this request performed; the host compacts in place, so the inbox is empty
    // immediately afterwards and nothing is left pending.
    return jsonResponse(200, {
      data: {
        id: asNonEmptyString(body.id) ?? `msg_${randomUUID()}`,
        sessionID: target.key,
        time: { created: Date.now() },
        type: "compaction",
        payload: {},
        delivery,
      },
    });
  });
}

export async function handleSessionFork(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request);
    const rawBefore = body.before;
    if (rawBefore !== undefined && asNonEmptyString(rawBefore) === undefined) {
      throw invalidRequest("before must be a non-empty message id", "before");
    }
    const before = rawBefore === undefined ? undefined : asNonEmptyString(rawBefore);

    const target = await resolveTarget(sessionID);
    const caller = requireTransport();
    if (target.row !== undefined) await ensureAttached(caller, target.row);

    const rowsBefore = caller.listSessions === undefined ? undefined : await caller.listSessions();
    const knownKeys = new Set((rowsBefore ?? []).map(rowKeyOf));

    let cancelled = false;
    if (before !== undefined) {
      const fork = caller.fork;
      if (typeof fork !== "function") {
        throw unsupportedCapability("the senpi transport cannot fork a session at a message", "before");
      }
      const result = await fork.call(caller, before, { position: "before" });
      cancelled = result?.cancelled === true;
    } else {
      const clone = caller.clone;
      if (typeof clone !== "function") {
        throw unsupportedCapability("the senpi transport cannot copy a full session history", "before");
      }
      const result = await clone.call(caller);
      cancelled = result?.cancelled === true;
    }
    if (cancelled) throw conflict("the session fork was cancelled", target.key);

    if (rowsBefore === undefined || caller.listSessions === undefined) {
      throw new HandlerProblem(500, "UnknownError", "the senpi host did not list the forked session", {
        sessionID: target.key,
      });
    }
    const created = (await caller.listSessions()).find((row) => !knownKeys.has(rowKeyOf(row)));
    if (created === undefined) {
      throw new HandlerProblem(500, "UnknownError", "the fork produced no new session the host lists", {
        sessionID: target.key,
      });
    }
    const record = requireStore().upsert(created);
    return jsonResponse(200, { data: toPublicSessionInfo(record) });
  });
}

export async function handleSessionRevertStage(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request, { required: true });
    const messageID = asNonEmptyString(body.messageID);
    if (messageID === undefined) throw invalidRequest("revert stage needs messageID", "messageID");
    const files = body.files;
    if (files !== undefined && typeof files !== "boolean") {
      throw invalidRequest("files must be a boolean", "files");
    }

    const target = await resolveTarget(sessionID);
    const caller = requireTransport();
    const revertStage = caller.revertStage;
    if (typeof revertStage !== "function") {
      throw declaredUnsupported("the bridge cannot stage a revert: senpi has no reversible file boundary", "messageID");
    }
    if (target.row !== undefined) await ensureAttached(caller, target.row);
    const result = await revertStage.call(caller, {
      messageID,
      ...(files === undefined ? {} : { files }),
    });
    return jsonResponse(200, { data: result.data });
  });
}

export async function handleSessionRevertClear(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const target = await resolveTarget(sessionID);
    const caller = requireTransport();
    const revertClear = caller.revertClear;
    if (typeof revertClear !== "function") {
      throw declaredUnsupported("the bridge cannot clear a staged revert: no revert is ever staged", "sessionID");
    }
    if (target.row !== undefined) await ensureAttached(caller, target.row);
    await revertClear.call(caller);
    return noContent();
  });
}

export async function handleSessionRevertCommit(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const target = await resolveTarget(sessionID);
    const caller = requireTransport();
    const revertCommit = caller.revertCommit;
    if (typeof revertCommit !== "function") {
      throw declaredUnsupported("the bridge cannot commit a staged revert: no revert is ever staged", "sessionID");
    }
    if (target.row !== undefined) await ensureAttached(caller, target.row);
    await revertCommit.call(caller);
    return noContent();
  });
}

export async function handleSessionEnvironment(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request, { required: true });
    const variables = asRecord(body.variables);
    if (variables === undefined) throw invalidRequest("environment needs a variables object", "variables");

    const environment: Record<string, string> = {};
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value !== "string") {
        throw invalidRequest(`environment variable ${name} must be a string`, "variables");
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw invalidRequest(`environment variable name ${JSON.stringify(name)} is not a valid shell name`, "variables");
      }
      environment[name] = value;
    }

    const target = await resolveTarget(sessionID);
    const metadata = { ...(target.record?.metadata ?? {}), [ENVIRONMENT_METADATA_KEY]: environment };
    // The prompt path reads this back from the record once the transport's openSession accepts an
    // `env` option; senpi exposes no per-session environment command today.
    requireStore().update(target.key, { metadata });
    return noContent();
  });
}
