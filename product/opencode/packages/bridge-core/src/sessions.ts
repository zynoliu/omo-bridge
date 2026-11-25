export type PersistentSessionId = string;
export type SessionHandle = string;

export type SessionState = "idle" | "active" | "parked" | "closed";

export type SessionRefusalCode =
  | "UNKNOWN_HANDLE"
  | "UNKNOWN_PERSISTENT_ID"
  | "ACTIVE_TURN"
  | "PENDING_APPROVAL"
  | "ALREADY_CLOSED"
  | "NOT_PARKED"
  | "DUPLICATE_HANDLE";

export type Refused = { readonly kind: "refused"; readonly code: SessionRefusalCode };
export type Ok<Value> = { readonly kind: "ok"; readonly value: Value };
export type SessionResult<Value> = Ok<Value> | Refused;

export function ok<Value>(value: Value): Ok<Value> {
  return { kind: "ok", value: value };
}

export function sessionRefused(code: SessionRefusalCode): Refused {
  return { kind: "refused", code: code };
}

export type SessionRecord = {
  readonly handle: SessionHandle;
  readonly persistentId: PersistentSessionId;
  readonly durableId: string;
  readonly state: SessionState;
  readonly pendingApproval: boolean;
  readonly history: readonly string[];
};

export type OpenRequest = {
  readonly persistentId?: PersistentSessionId;
  readonly durableId?: string;
  readonly history?: readonly string[];
};

export type SessionSeed = {
  readonly knownPersistentIds?: readonly PersistentSessionId[];
  readonly historyByPersistentId?: Readonly<Record<PersistentSessionId, readonly string[]>>;
};

export class SessionRegistry {
  private readonly sessions = new Map<SessionHandle, SessionRecord>();
  private readonly knownPersistent = new Set<PersistentSessionId>();
  private readonly seededHistory: Record<PersistentSessionId, readonly string[]>;
  private nextHandle = 1;

  constructor(seed: SessionSeed = {}) {
    for (const id of seed.knownPersistentIds ?? []) this.knownPersistent.add(id);
    this.seededHistory = { ...(seed.historyByPersistentId ?? {}) };
  }

  private mintHandle(persistentId: PersistentSessionId, durableId: string): SessionHandle {
    const handle = "sess_" + String(this.nextHandle).padStart(4, "0");
    this.nextHandle += 1;
    this.sessions.set(handle, {
      handle: handle,
      persistentId: persistentId,
      durableId: durableId,
      state: "idle",
      pendingApproval: false,
      history: [],
    });
    return handle;
  }

  open(request: OpenRequest): SessionResult<SessionHandle> {
    const persistentId = request.persistentId ?? "p_" + String(this.knownPersistent.size + 1).padStart(4, "0");
    this.knownPersistent.add(persistentId);
    if (request.history) this.seededHistory[persistentId] = request.history;
    const handle = this.mintHandle(persistentId, request.durableId ?? persistentId);
    const record = this.sessions.get(handle);
    if (record && request.history) {
      this.sessions.set(handle, { ...record, history: [...request.history] });
    }
    return ok(handle);
  }

  reopen(persistentId: PersistentSessionId): SessionResult<SessionHandle> {
    if (!this.knownPersistent.has(persistentId)) return sessionRefused("UNKNOWN_PERSISTENT_ID");
    const previous = [...this.sessions.values()].find((session) => session.persistentId === persistentId);
    const history = previous?.history ?? this.seededHistory[persistentId] ?? [];
    const handle = this.mintHandle(persistentId, persistentId);
    const record = this.sessions.get(handle);
    if (record) this.sessions.set(handle, { ...record, history: [...history] });
    return ok(handle);
  }

  attach(handle: SessionHandle): SessionResult<SessionRecord> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.state === "closed") return sessionRefused("ALREADY_CLOSED");
    return ok(record);
  }

  list(): readonly SessionRecord[] {
    return [...this.sessions.values()];
  }

  markActive(handle: SessionHandle): SessionResult<SessionRecord> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.state === "closed") return sessionRefused("ALREADY_CLOSED");
    const next = { ...record, state: "active" as const };
    this.sessions.set(handle, next);
    return ok(next);
  }

  /** The host reported no running turn: the row must stop claiming one on this process's word. */
  markIdle(handle: SessionHandle): SessionResult<SessionRecord> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.state === "closed") return sessionRefused("ALREADY_CLOSED");
    const next = { ...record, state: "idle" as const };
    this.sessions.set(handle, next);
    return ok(next);
  }

  setPendingApproval(handle: SessionHandle, pending: boolean): SessionResult<SessionRecord> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.state === "closed") return sessionRefused("ALREADY_CLOSED");
    const next = { ...record, pendingApproval: pending };
    this.sessions.set(handle, next);
    return ok(next);
  }

  detach(handle: SessionHandle): SessionResult<SessionState> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.state === "closed") return sessionRefused("ALREADY_CLOSED");
    return ok(record.state);
  }

  park(handle: SessionHandle): SessionResult<SessionState> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.state === "closed") return sessionRefused("ALREADY_CLOSED");
    if (record.state === "active") return sessionRefused("ACTIVE_TURN");
    if (record.pendingApproval) return sessionRefused("PENDING_APPROVAL");
    this.sessions.set(handle, { ...record, state: "parked" });
    return ok("parked");
  }

  unload(handle: SessionHandle): SessionResult<SessionState> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.state === "active") return sessionRefused("ACTIVE_TURN");
    if (record.pendingApproval) return sessionRefused("PENDING_APPROVAL");
    if (record.state === "closed") return sessionRefused("ALREADY_CLOSED");
    this.sessions.set(handle, { ...record, state: "parked" });
    return ok("parked");
  }

  close(handle: SessionHandle): SessionResult<SessionState> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    if (record.pendingApproval) return sessionRefused("PENDING_APPROVAL");
    this.sessions.set(handle, { ...record, state: "closed" });
    return ok("closed");
  }

  history(handle: SessionHandle): SessionResult<readonly string[]> {
    const record = this.sessions.get(handle);
    if (!record) return sessionRefused("UNKNOWN_HANDLE");
    return ok(record.history);
  }
}
