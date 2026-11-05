import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

// Session/location mapping between senpi and opencode.
//
// senpi's `list_sessions` only lists the handles a host holds right now, and a routing `sessionId` is
// recycled whenever a session is reopened. The durable identity is `durableSessionId` (the id in the
// session file header), with the session file path as the fallback, so this map never keys records on
// the routing id. Bridge-side state (archive flag, metadata, permissions, renames) lives in
// `<stateDir>/sessions.json`, written atomically, and the durable half can always be rebuilt by
// scanning `<agentDir>/sessions/**/*.jsonl`.

export const SESSION_MAP_VERSION = 1;
export const SESSION_STATE_FILE = "sessions.json";
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;
const SESSION_FILE_SUFFIX = ".jsonl";
/** In-memory only: rows with neither a durable id nor a path never reach `sessions.json`. */
const EPHEMERAL_KEY_PREFIX = "ephemeral:";
const TITLE_MAX_LENGTH = 120;

/** The subset of a senpi `list_sessions` row this layer understands; everything else is dropped. */
export interface SessionListRow {
  sessionId: string;
  durableSessionId?: string;
  sessionPath?: string;
  cwd: string;
  name?: string;
  status?: string;
  attachments?: number;
  retain_on_disconnect?: boolean;
}

export interface SessionPermission {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export type SessionTokenUsage = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

/** Cumulative usage the host reported for one session, summed across its executions. */
export type SessionUsage = {
  cost: number;
  tokens: SessionTokenUsage;
};

export function emptySessionUsage(): SessionUsage {
  return { cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } };
}

export interface SessionRecord {
  key: string;
  /** The routing id observed for this record; connection-scoped, never persisted nor exposed as the id. */
  routingId: string;
  sessionPath?: string;
  cwd: string;
  name?: string;
  projectID: string;
  firstSeenAt: string;
  lastSeenAt: string;
  archived?: boolean;
  /** When archive was set, ISO internal state; the public row converts it to epoch millis. */
  archivedAt?: string;
  metadata?: Record<string, unknown>;
  permissions?: SessionPermission[];
  /** Absent until the host reports usage for this session; zero is never fabricated here. */
  usage?: SessionUsage;
}

export interface SessionCursor {
  previous?: string;
  next?: string;
}

export interface SessionListPage {
  data: SessionRecord[];
  cursor: SessionCursor;
}

export interface SessionListOptions {
  limit?: number;
  cursor?: string;
  includeArchived?: boolean;
}

export interface ProjectRef {
  id: string;
  directory: string;
  canonical: string;
}

export interface RebuildResult {
  files: number;
  records: number;
  skippedFiles: number;
  skippedEntries: number;
}

export interface SessionMapOptions {
  stateDir: string;
  agentDir: string;
  /** Warning sink; tests pass a collector, the runtime keeps console.warn. */
  warn?: (message: string) => void;
}

/** The opencode `PublicSessionInfo` shape the read handlers serialize (kept in sync with
 * `src/http/handlers/sessions.ts` without importing across the module boundary). `time` values are
 * epoch millis: `Session.Info.time` decodes from numbers, and ISO strings render as NaNy in the TUI. */
export type PublicSessionInfo = {
  id: string;
  projectID: string;
  cost: number;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  time: { created: number; updated: number; archived?: number };
  title: string;
  location: { directory: string };
};

function defaultWarn(message: string): void {
  console.warn(message);
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

function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cloneUsage(usage: SessionUsage): SessionUsage {
  return { cost: usage.cost, tokens: { ...usage.tokens, cache: { ...usage.tokens.cache } } };
}

/**
 * Reads every shape the bridge meets: the host transcript and senpi wire (`cacheRead`/`cacheWrite`,
 * `cost.total`) and the opencode event/persisted form (`tokens.cache.read`/`tokens.cache.write`,
 * numeric `cost`). A record with no numeric field at all is not usage and returns undefined.
 */
export function readSessionUsage(value: unknown): SessionUsage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const tokens = asRecord(record.tokens) ?? record;
  const cache = asRecord(tokens.cache);
  const costRecord = asRecord(record.cost);
  const cost = usageNumber(record.cost) ?? usageNumber(costRecord?.total);
  const input = usageNumber(tokens.input);
  const output = usageNumber(tokens.output);
  const reasoning = usageNumber(tokens.reasoning);
  const cacheRead = usageNumber(tokens.cacheRead) ?? usageNumber(cache?.read);
  const cacheWrite = usageNumber(tokens.cacheWrite) ?? usageNumber(cache?.write);
  if ([cost, input, output, reasoning, cacheRead, cacheWrite].every((entry) => entry === undefined)) return undefined;
  return {
    cost: cost ?? 0,
    tokens: {
      input: input ?? 0,
      output: output ?? 0,
      reasoning: reasoning ?? 0,
      cache: { read: cacheRead ?? 0, write: cacheWrite ?? 0 },
    },
  };
}

function addUsageTotals(into: SessionUsage, usage: SessionUsage): SessionUsage {
  return {
    cost: into.cost + usage.cost,
    tokens: {
      input: into.tokens.input + usage.tokens.input,
      output: into.tokens.output + usage.tokens.output,
      reasoning: into.tokens.reasoning + usage.tokens.reasoning,
      cache: {
        read: into.tokens.cache.read + usage.tokens.cache.read,
        write: into.tokens.cache.write + usage.tokens.cache.write,
      },
    },
  };
}

/** True when every cumulative field of `candidate` covers `current`; totals only ever grow. */
function coversUsage(candidate: SessionUsage, current: SessionUsage): boolean {
  return (
    candidate.cost >= current.cost &&
    candidate.tokens.input >= current.tokens.input &&
    candidate.tokens.output >= current.tokens.output &&
    candidate.tokens.reasoning >= current.tokens.reasoning &&
    candidate.tokens.cache.read >= current.tokens.cache.read &&
    candidate.tokens.cache.write >= current.tokens.cache.write
  );
}

/**
 * The transcript is the host's own append-only ledger. A seed that covers the live total replaces
 * it (the run is on disk now); a seed that lags keeps the live total, so re-reading a transcript the
 * host has not flushed yet can neither drop nor duplicate a run the event stream already reported.
 */
function reconcileUsage(current: SessionUsage | undefined, seeded: SessionUsage | undefined): SessionUsage | undefined {
  if (seeded === undefined) return current;
  if (current === undefined) return seeded;
  return coversUsage(seeded, current) ? seeded : current;
}

/** Normalizes anything timestamp-shaped into the ISO form the read handlers emit. */
function toIso(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

function laterOf(left: string, right: string): string {
  return left >= right ? left : right;
}

function earlierOf(left: string, right: string): string {
  return left <= right ? left : right;
}

/** Internal state keeps ISO text; every value that leaves through `toPublicSessionInfo` is millis. */
function epochMillisOf(timestamp: string): number {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The persisted key: durable id first, session file path second. Rows with neither are ephemeral
 * (an in-memory session without a file) and only live in this process's map.
 */
function durableKeyOf(row: SessionListRow): string {
  const durable = asNonEmptyString(row.durableSessionId);
  if (durable !== undefined) return durable;
  const path = asNonEmptyString(row.sessionPath);
  if (path !== undefined) return path;
  return `${EPHEMERAL_KEY_PREFIX}${row.sessionId}`;
}

/** The map key a listing row is filed under; read handlers use it to resolve bridge-side state. */
export function sessionKeyOf(row: SessionListRow): string {
  return durableKeyOf(row);
}

function isEphemeral(key: string): boolean {
  return key.startsWith(EPHEMERAL_KEY_PREFIX);
}

export function canonicalDirectory(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return resolve(directory);
  }
}

/**
 * Resolves a directory to the opencode project identity. The id hashes the canonical (realpath)
 * directory, so two spellings of the same location — a symlink, a trailing slash — agree.
 */
export function projectFor(directory: string): ProjectRef {
  const canonical = canonicalDirectory(directory);
  const id = createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
  return { id, directory, canonical };
}

export function toPublicSessionInfo(record: SessionRecord): PublicSessionInfo {
  const created = epochMillisOf(record.firstSeenAt);
  const updated = epochMillisOf(record.lastSeenAt);
  const archived = record.archived === true ? epochMillisOf(record.archivedAt ?? record.lastSeenAt) : undefined;
  const usage = record.usage ?? emptySessionUsage();
  return {
    id: record.key,
    projectID: record.projectID,
    cost: usage.cost,
    tokens: { ...usage.tokens, cache: { ...usage.tokens.cache } },
    time: { created, updated, ...(archived === undefined ? {} : { archived }) },
    title: record.name ?? basename(record.cwd),
    location: { directory: record.cwd },
  };
}

function cloneRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    ...(record.metadata === undefined ? {} : { metadata: { ...record.metadata } }),
    ...(record.permissions === undefined ? {} : { permissions: record.permissions.map((entry) => ({ ...entry })) }),
    ...(record.usage === undefined ? {} : { usage: cloneUsage(record.usage) }),
  };
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined || cursor.trim().length === 0) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  const offset = asRecord(parsed)?.offset;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) return undefined;
  return offset;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIST_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(floored, MAX_LIST_LIMIT);
}

function compareRecords(left: SessionRecord, right: SessionRecord): number {
  const bySeen = right.lastSeenAt.localeCompare(left.lastSeenAt);
  return bySeen !== 0 ? bySeen : left.key.localeCompare(right.key);
}

function parsePermission(value: unknown): SessionPermission | undefined {
  const record = asRecord(value);
  const action = asString(record?.action);
  const resource = asString(record?.resource);
  const effect = record?.effect;
  if (action === undefined || resource === undefined) return undefined;
  if (effect !== "allow" && effect !== "deny" && effect !== "ask") return undefined;
  return { action, resource, effect };
}

function parseRecord(value: unknown): SessionRecord | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const key = asNonEmptyString(record.key);
  const cwd = asNonEmptyString(record.cwd);
  const projectID = asNonEmptyString(record.projectID);
  const firstSeenAt = toIso(record.firstSeenAt);
  const lastSeenAt = toIso(record.lastSeenAt);
  if (key === undefined || cwd === undefined || projectID === undefined) return undefined;
  if (firstSeenAt === undefined || lastSeenAt === undefined) return undefined;
  const routingId = asString(record.routingId) ?? "";
  const sessionPath = asNonEmptyString(record.sessionPath);
  const name = asString(record.name);
  const archived = typeof record.archived === "boolean" ? record.archived : undefined;
  const archivedAt = toIso(record.archivedAt);
  const metadata = asRecord(record.metadata);
  const usage = readSessionUsage(record.usage);
  let permissions: SessionPermission[] | undefined;
  if (record.permissions !== undefined) {
    if (!Array.isArray(record.permissions)) return undefined;
    permissions = [];
    for (const entry of record.permissions) {
      const permission = parsePermission(entry);
      if (permission === undefined) return undefined;
      permissions.push(permission);
    }
  }
  return {
    key,
    routingId,
    ...(sessionPath === undefined ? {} : { sessionPath }),
    cwd,
    ...(name === undefined ? {} : { name }),
    projectID,
    firstSeenAt,
    lastSeenAt,
    ...(archived === undefined ? {} : { archived }),
    ...(archivedAt === undefined ? {} : { archivedAt }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function parseStateFile(value: unknown): SessionRecord[] | undefined {
  const state = asRecord(value);
  if (state === undefined || !Array.isArray(state.sessions)) return undefined;
  const records: SessionRecord[] = [];
  for (const entry of state.sessions) {
    const record = parseRecord(entry);
    if (record === undefined) return undefined;
    records.push(record);
  }
  return records;
}

function collectSessionFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(SESSION_FILE_SUFFIX)) files.push(child);
    }
  };
  walk(root);
  files.sort();
  return files;
}

function readJsonl(file: string): { entries: Record<string, unknown>[]; skipped: number } | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const entries: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const entry = asRecord(parsed);
    if (entry === undefined) {
      skipped += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, skipped };
}

/**
 * The session's own JSONL ledger as the host wrote it, for a read that must not touch the host.
 * Undefined when the file cannot be read; malformed lines are skipped like every other reader here.
 */
export function readTranscriptEntries(sessionPath: string): Record<string, unknown>[] | undefined {
  return readJsonl(sessionPath)?.entries;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "text") continue;
    const text = asString(record.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("\n");
}

function headerOf(entries: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return entries.find((entry) => entry.type === "session");
}

function diskNameOf(entries: Record<string, unknown>[]): string | undefined {
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "session_info") continue;
    const candidate = asNonEmptyString(entry.name);
    if (candidate !== undefined) name = candidate;
  }
  if (name !== undefined) return name;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "user") continue;
    const text = textOfContent(message.content).trim();
    if (text.length === 0) continue;
    return text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH) : text;
  }
  return undefined;
}

function lastEntryTimestamp(entries: Record<string, unknown>[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const entryTime = toIso(entry.timestamp);
    if (entryTime !== undefined) return entryTime;
    const message = asRecord(entry.message);
    const messageTime = toIso(message?.timestamp);
    if (messageTime !== undefined) return messageTime;
  }
  return undefined;
}

function usageFromEntries(entries: Record<string, unknown>[]): SessionUsage | undefined {
  let total: SessionUsage | undefined;
  const counted = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message?.role !== "assistant") continue;
    const id = asNonEmptyString(entry.id) ?? asNonEmptyString(message.id);
    if (id !== undefined) {
      if (counted.has(id)) continue;
      counted.add(id);
    }
    const usage = readSessionUsage(message.usage);
    if (usage === undefined) continue;
    total = total === undefined ? usage : addUsageTotals(total, usage);
  }
  return total;
}

/**
 * Seeds from the host's own transcript, the only place a re-listed session's usage survives a
 * reconnect: `list_sessions` carries no totals. A session whose provider reports no usage (or whose
 * file cannot be read) gets no seed and keeps whatever the event stream reported, never an estimate.
 */
function usageFromSessionFile(file: string | undefined): SessionUsage | undefined {
  if (file === undefined) return undefined;
  const parsed = readJsonl(file);
  return parsed === undefined ? undefined : usageFromEntries(parsed.entries);
}

export class SessionMap {
  readonly stateDir: string;
  readonly agentDir: string;
  readonly file: string;

  private readonly warn: (message: string) => void;
  private readonly records = new Map<string, SessionRecord>();
  private readonly pendingUsage = new Map<string, SessionUsage>();

  private constructor(options: SessionMapOptions) {
    this.stateDir = options.stateDir;
    this.agentDir = options.agentDir;
    this.file = join(options.stateDir, SESSION_STATE_FILE);
    this.warn = options.warn ?? defaultWarn;
  }

  /**
   * Loads `<stateDir>/sessions.json` when it exists and is well formed; otherwise rebuilds from
   * `<agentDir>/sessions` and reports the reason. Corrupt state never throws.
   */
  static open(options: SessionMapOptions): SessionMap {
    const map = new SessionMap(options);
    if (!map.loadFromDisk()) map.rebuildFromDisk();
    return map;
  }

  get(key: string): SessionRecord | undefined {
    const record = this.records.get(key);
    return record === undefined ? undefined : cloneRecord(record);
  }

  has(key: string): boolean {
    return this.records.has(key);
  }

  get size(): number {
    return this.records.size;
  }

  /**
   * Records one run's usage, as reported by `session.usage.updated`. The host transcript wins when
   * it is readable: senpi persists an assistant message before its `message_end` frame, so the
   * transcript already covers every message the event sums, and re-reading it also stops a seed
   * taken mid-run from counting that run twice. Without a transcript the run is added to the
   * event-only total. A session the map has not adopted yet keeps its usage pending until `upsert`.
   */
  addUsage(key: string, usage: SessionUsage): void {
    const record = this.records.get(key);
    if (record === undefined) {
      const pending = this.pendingUsage.get(key);
      this.pendingUsage.set(key, pending === undefined ? cloneUsage(usage) : addUsageTotals(pending, usage));
      return;
    }
    const seeded = usageFromSessionFile(record.sessionPath);
    if (seeded !== undefined) {
      record.usage = reconcileUsage(record.usage, seeded);
      return;
    }
    record.usage = record.usage === undefined ? cloneUsage(usage) : addUsageTotals(record.usage, usage);
  }

  /**
   * Records one senpi listing row under its durable key, preserving bridge-side state (archive,
   * metadata, permissions, renames) and the original first-seen timestamp. Usage is re-seeded from
   * the host transcript when that file is readable; see `reconcileUsage`.
   */
  upsert(row: SessionListRow, seenAt: string = new Date().toISOString()): SessionRecord {
    const key = durableKeyOf(row);
    const existing = this.records.get(key);
    const observed = toIso(seenAt) ?? new Date().toISOString();
    const projectID = projectFor(row.cwd).id;
    const name = row.name === undefined ? existing?.name : row.name;
    const sessionPath = asNonEmptyString(row.sessionPath) ?? existing?.sessionPath;
    const usage = reconcileUsage(existing?.usage, usageFromSessionFile(sessionPath));
    const record: SessionRecord = {
      key,
      routingId: row.sessionId,
      ...(sessionPath === undefined ? {} : { sessionPath }),
      cwd: row.cwd,
      ...(name === undefined ? {} : { name }),
      projectID,
      firstSeenAt: existing === undefined ? observed : earlierOf(existing.firstSeenAt, observed),
      lastSeenAt: existing === undefined ? observed : laterOf(existing.lastSeenAt, observed),
      ...(existing?.archived === undefined ? {} : { archived: existing.archived }),
      ...(existing?.archivedAt === undefined ? {} : { archivedAt: existing.archivedAt }),
      ...(existing?.metadata === undefined ? {} : { metadata: { ...existing.metadata } }),
      ...(existing?.permissions === undefined
        ? {}
        : { permissions: existing.permissions.map((entry) => ({ ...entry })) }),
      ...(usage === undefined ? {} : { usage }),
    };
    const pending = this.pendingUsage.get(key);
    if (pending !== undefined) {
      this.pendingUsage.delete(key);
      // A transcript seed already covers any run the host persisted; pending usage is the only
      // record of a run on a session the host cannot offer a transcript for.
      if (record.usage === undefined) record.usage = pending;
    }
    this.records.set(key, record);
    return cloneRecord(record);
  }

  list(options: SessionListOptions = {}): SessionListPage {
    const limit = normalizeLimit(options.limit);
    const offset = decodeCursor(options.cursor) ?? 0;
    const sorted = [...this.records.values()]
      .filter((record) => options.includeArchived === true || record.archived !== true)
      .sort(compareRecords);
    const page = sorted.slice(offset, offset + limit).map(cloneRecord);
    const cursor: SessionCursor = {};
    if (offset > 0) cursor.previous = encodeCursor(Math.max(0, offset - limit));
    if (offset + page.length < sorted.length) cursor.next = encodeCursor(offset + page.length);
    return { data: page, cursor };
  }

  archive(key: string, archived = true): SessionRecord | undefined {
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    if (archived) {
      if (record.archived !== true || record.archivedAt === undefined) {
        record.archivedAt = new Date().toISOString();
      }
      record.archived = true;
    } else {
      delete record.archived;
      delete record.archivedAt;
    }
    return cloneRecord(record);
  }

  remove(key: string): boolean {
    return this.records.delete(key);
  }

  rename(key: string, title: string): SessionRecord | undefined {
    const record = this.records.get(key);
    if (record === undefined) return undefined;
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      delete record.name;
    } else {
      record.name = trimmed;
    }
    return cloneRecord(record);
  }

  /**
   * Derives durable records from the senpi session files (`<agentDir>/sessions/--<path>--/*.jsonl`).
   * Bridge-side state already in the map wins over the file, so a corrupt `sessions.json` loses only
   * the fields the files cannot carry. Unparseable lines are counted, never thrown.
   */
  rebuildFromDisk(): RebuildResult {
    const result: RebuildResult = { files: 0, records: 0, skippedFiles: 0, skippedEntries: 0 };
    const root = join(this.agentDir, "sessions");
    for (const file of collectSessionFiles(root)) {
      result.files += 1;
      let stats;
      try {
        stats = statSync(file);
      } catch {
        result.skippedFiles += 1;
        continue;
      }
      const parsed = readJsonl(file);
      if (parsed === undefined) {
        result.skippedFiles += 1;
        continue;
      }
      result.skippedEntries += parsed.skipped;
      const header = headerOf(parsed.entries);
      const cwd = asNonEmptyString(header?.cwd);
      if (cwd === undefined) {
        result.skippedFiles += 1;
        continue;
      }
      const key = asNonEmptyString(header?.id) ?? file;
      const existing = this.records.get(key);
      const headerCreated = toIso(header?.timestamp) ?? stats.birthtime.toISOString();
      const updated = laterOf(lastEntryTimestamp(parsed.entries) ?? stats.mtime.toISOString(), stats.mtime.toISOString());
      const name = existing?.name ?? diskNameOf(parsed.entries);
      const usage = reconcileUsage(existing?.usage, usageFromEntries(parsed.entries));
      const record: SessionRecord = {
        key,
        routingId: existing?.routingId ?? "",
        sessionPath: file,
        cwd,
        ...(name === undefined ? {} : { name }),
        projectID: projectFor(cwd).id,
        firstSeenAt: existing === undefined ? headerCreated : earlierOf(existing.firstSeenAt, headerCreated),
        lastSeenAt: existing === undefined ? updated : laterOf(existing.lastSeenAt, updated),
        ...(existing?.archived === undefined ? {} : { archived: existing.archived }),
        ...(existing?.archivedAt === undefined ? {} : { archivedAt: existing.archivedAt }),
        ...(existing?.metadata === undefined ? {} : { metadata: { ...existing.metadata } }),
        ...(existing?.permissions === undefined
          ? {}
          : { permissions: existing.permissions.map((entry) => ({ ...entry })) }),
        ...(usage === undefined ? {} : { usage }),
      };
      this.records.set(key, record);
      result.records += 1;
    }
    return result;
  }

  /** Writes `<stateDir>/sessions.json` atomically (temp file + rename) with mode 0600. */
  flush(): void {
    mkdirSync(this.stateDir, { recursive: true, mode: STATE_DIR_MODE });
    const persisted = [...this.records.values()]
      .filter((record) => !isEphemeral(record.key))
      .sort((left, right) => left.key.localeCompare(right.key));
    const payload = `${JSON.stringify({ version: SESSION_MAP_VERSION, sessions: persisted }, null, 2)}\n`;
    const temp = join(this.stateDir, `.${SESSION_STATE_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, payload, { mode: STATE_FILE_MODE });
      renameSync(temp, this.file);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // Nothing to clean up.
      }
      throw error;
    }
  }

  private loadFromDisk(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.warn(`omo-bridge: cannot read ${this.file} (${String(code ?? error)}); rebuilding the session map`);
      }
      return false;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.warn(
        `omo-bridge: ${this.file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); rebuilding the session map`,
      );
      return false;
    }
    const records = parseStateFile(parsed);
    if (records === undefined) {
      this.warn(`omo-bridge: ${this.file} does not hold a valid session map; rebuilding from ${this.agentDir}/sessions`);
      return false;
    }
    for (const record of records) this.records.set(record.key, record);
    return true;
  }
}
