/**
 * The status surfaces of one isolated session: memory state and updates, team members, the host's
 * status entries, string-array widgets and notifications.
 *
 * Every input is a frame the host is documented to write, and every derivation keeps "the host did
 * not report this" distinct from "the host reported nothing":
 *
 * - memory: `omo.memory.updated` is pushed as an `extension_event`; `omo.memory.status` answers the
 *   same snapshot on a pull. The snapshot keeps every additive field optional, so a missing
 *   `repo.totalBytes` reads as not reported, never as zero.
 * - team: the host sends no roster. The only member facts on this path are
 *   `senpi-task.team-member-liveness` custom messages, which the host marks `display: false`.
 * - status and widgets: `setStatus` / `setWidget` are fire-and-forget `extension_ui_request`s.
 *   `setWidget` forwards string arrays only; a component factory emits no record at all.
 * - notifications: `notify` carries `notifyType` info|warning|error. A notification the host marks
 *   `display: false` stays hidden here; it is counted and named, never drawn as a notification.
 *
 * The persistent write (`omo.memory.facts.apply`) is the only write this module models: it may
 * write and commit the memory Git repository, so it is planned first, rendered exactly, and only
 * then authorized.
 */

/** Footer status key the memory component owns (`memory/status.ts`, `MEMORY_STATUS_KEY`). */
export const MEMORY_STATUS_KEY = "memory";
/** Push channel for the memory snapshot (`memory/memory-rpc-bridge.ts`). */
export const MEMORY_UPDATED_EVENT = "omo.memory.updated";
/** Pull channel for the same snapshot; this surface never sends it by itself. */
export const MEMORY_STATUS_METHOD = "omo.memory.status";
/** The session-bound persistent write this surface gates (`facts-apply-rpc.ts`). */
export const MEMORY_FACTS_APPLY_METHOD = "omo.memory.facts.apply";
/** Custom message type a team member's death notice is written under (`member-liveness.ts`). */
export const TEAM_LIVENESS_CUSTOM_TYPE = "senpi-task.team-member-liveness";
/** Host goal lifecycle event; a light turn verdict, never a member roster (`turn-end-liveness.ts`). */
export const TURN_END_LIVENESS_EVENT = "turn_end_liveness";

/** The side column's own constants, read from `side-panel/constants.ts`. */
export const MIN_TRANSCRIPT_COLUMNS = 60;
export const PANEL_MIN_COLUMNS = 32;
export const PANEL_MAX_COLUMNS = 80;
/** Delegated children the host column keeps; older rows are counted, never silently dropped. */
export const AGENT_ROW_CAP = 12;
/** Below this terminal width a label and its value go on separate lines instead of one row. */
export const COMPACT_COLUMNS = MIN_TRANSCRIPT_COLUMNS;

/** The one text this module uses for a field the host did not deliver. */
export const NOT_REPORTED = "not reported";

/** The host's widget keys whose content is a component factory, which `setWidget` never forwards. */
export type WidgetFactoryDeclaration = {
  readonly key: string;
  readonly note: string;
};

export const WIDGET_FACTORY_KEYS: readonly WidgetFactoryDeclaration[] = [
  {
    key: "omo-side-panel",
    note: "the host passes this widget to setWidget as a component factory, and a component factory emits no RPC record",
  },
  {
    key: "omo-side-panel-anchor",
    note: "a zero-height factory widget the host uses only to obtain the renderer; it carries no drawable rows",
  },
];

/** A hidden notification is never drawn; the note is what the column says about it instead. */
export const HIDDEN_NOTE = "hidden by the host (display=false)";

/* ── small readers ──────────────────────────────────────────────────────────────────────────── */

type Reading<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly reason: string };

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return false;
  return !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    items.push(item);
  }
  return items;
}

function recordAt(source: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | undefined {
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

function numberText(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function booleanText(value: boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value ? "yes" : "no";
}

/* ── reported fields ────────────────────────────────────────────────────────────────────────── */

/** One labelled value as the module holds it: `reported` is false only when the host omitted it. */
export type ReportedField = {
  readonly label: string;
  readonly reported: boolean;
  readonly text: string;
};

export function reportedField(label: string, value: string | undefined): ReportedField {
  if (value === undefined) return { label: label, reported: false, text: NOT_REPORTED };
  return { label: label, reported: true, text: value };
}

/* ── memory ─────────────────────────────────────────────────────────────────────────────────── */

export type MemoryActiveRun = {
  readonly runId: string | undefined;
  readonly trigger: string | undefined;
  readonly category: string | undefined;
  readonly model: string | undefined;
  readonly startedAt: string | undefined;
};

export type MemoryLastOutcome = {
  readonly runId: string | undefined;
  readonly outcome: string | undefined;
  readonly reason: string | undefined;
  readonly finishedAt: string | undefined;
};

export type MemorySyncFailure = {
  readonly kind: string | undefined;
  readonly reason: string | undefined;
  readonly action: string | undefined;
  readonly sinceISO: string | undefined;
  readonly attempts: number | undefined;
  readonly limitBytes: number | undefined;
};

export type MemorySync = {
  readonly state: string | undefined;
  readonly lastSyncedAtISO: string | undefined;
  readonly failure: MemorySyncFailure | undefined;
};

/**
 * `MemoryRpcSnapshot` as received. `journal.sessionId` is the routing fact the isolation check reads;
 * every other absent member stays undefined so a missing additive field never reads as a zero.
 */
export type MemorySnapshot = {
  readonly schemaVersion: number;
  readonly identity: string | undefined;
  readonly nonJournalUnknown: boolean;
  readonly repo: {
    readonly headSha: string | undefined;
    readonly headSubject: string | undefined;
    readonly committedAtISO: string | undefined;
    readonly dirty: boolean | undefined;
    readonly dirtyPaths: number | undefined;
    readonly systemTokensEstimate: number | undefined;
    readonly totalBytes: number | undefined;
    readonly systemBytes: number | undefined;
    readonly fileCount: number | undefined;
    readonly entriesToday: number | undefined;
    readonly previousEntryAtISO: string | undefined;
  };
  readonly reflection: {
    readonly backlogSteps: number | undefined;
    readonly pendingCompaction: boolean | undefined;
    readonly consecutiveFailures: number | undefined;
    readonly activeRun: MemoryActiveRun | undefined;
    readonly lastOutcome: MemoryLastOutcome | undefined;
    readonly lastFailureFingerprint: string | undefined;
    readonly lastConsolidationAtISO: string | undefined;
  };
  readonly journal: {
    readonly sessionId: string | undefined;
    readonly totalSteps: number | undefined;
    readonly reflectedSteps: number | undefined;
  };
  readonly sync: MemorySync | undefined;
};

export type MemorySurface =
  | { readonly kind: "not-reported"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly schemaVersion: string; readonly reason: string }
  | {
      readonly kind: "reported";
      readonly snapshot: MemorySnapshot;
      readonly fields: readonly ReportedField[];
      readonly note: string;
    };

export const MEMORY_CHANNEL_NOTE =
  "Snapshot channel: omo.memory.status (pull) / omo.memory.updated (push). The footer line is a separate setStatus entry, shown under Status.";

export function decodeMemorySnapshot(raw: unknown): Reading<MemorySnapshot> {
  if (!isRecord(raw)) return { ok: false, reason: "the memory snapshot is not an object" };
  const schemaVersion = readNumber(raw["schemaVersion"]);
  if (schemaVersion === undefined) return { ok: false, reason: "the memory snapshot has no numeric schemaVersion" };
  if (schemaVersion !== 1) {
    return { ok: false, reason: "schemaVersion " + String(schemaVersion) + " is not the version this surface reads (1)" };
  }
  const repo = recordAt(raw, "repo");
  const reflection = recordAt(raw, "reflection");
  const journal = recordAt(raw, "journal");
  const syncSource = recordAt(raw, "sync");
  return {
    ok: true,
    value: {
      schemaVersion: schemaVersion,
      identity: readString(raw["identity"]),
      nonJournalUnknown: raw["nonJournalState"] === "unknown",
      repo: {
        headSha: repo === undefined ? undefined : readString(repo["headSha"]),
        headSubject: repo === undefined ? undefined : readString(repo["headSubject"]),
        committedAtISO: repo === undefined ? undefined : readString(repo["committedAtISO"]),
        dirty: repo === undefined ? undefined : readBoolean(repo["dirty"]),
        dirtyPaths: repo === undefined ? undefined : readNumber(repo["dirtyPaths"]),
        systemTokensEstimate: repo === undefined ? undefined : readNumber(repo["systemTokensEstimate"]),
        totalBytes: repo === undefined ? undefined : readNumber(repo["totalBytes"]),
        systemBytes: repo === undefined ? undefined : readNumber(repo["systemBytes"]),
        fileCount: repo === undefined ? undefined : readNumber(repo["fileCount"]),
        entriesToday: repo === undefined ? undefined : readNumber(repo["entriesToday"]),
        previousEntryAtISO: repo === undefined ? undefined : readString(repo["previousEntryAtISO"]),
      },
      reflection: {
        backlogSteps: reflection === undefined ? undefined : readNumber(reflection["backlogSteps"]),
        pendingCompaction: reflection === undefined ? undefined : readBoolean(reflection["pendingCompaction"]),
        consecutiveFailures: reflection === undefined ? undefined : readNumber(reflection["consecutiveFailures"]),
        activeRun: readActiveRun(reflection === undefined ? undefined : reflection["activeRun"]),
        lastOutcome: readLastOutcome(reflection === undefined ? undefined : reflection["lastOutcome"]),
        lastFailureFingerprint:
          reflection === undefined ? undefined : readString(reflection["lastFailureFingerprint"]),
        lastConsolidationAtISO:
          reflection === undefined ? undefined : readString(reflection["lastConsolidationAtISO"]),
      },
      journal: {
        sessionId: journal === undefined ? undefined : readString(journal["sessionId"]),
        totalSteps: journal === undefined ? undefined : readNumber(journal["totalSteps"]),
        reflectedSteps: journal === undefined ? undefined : readNumber(journal["reflectedSteps"]),
      },
      sync: syncSource === undefined ? undefined : readSync(syncSource),
    },
  };
}

function readActiveRun(value: unknown): MemoryActiveRun | undefined {
  if (!isRecord(value)) return undefined;
  return {
    runId: readString(value["runId"]),
    trigger: readString(value["trigger"]),
    category: readString(value["category"]),
    model: readString(value["model"]),
    startedAt: readString(value["startedAt"]),
  };
}

function readLastOutcome(value: unknown): MemoryLastOutcome | undefined {
  if (!isRecord(value)) return undefined;
  return {
    runId: readString(value["runId"]),
    outcome: readString(value["outcome"]),
    reason: readString(value["reason"]),
    finishedAt: readString(value["finishedAt"]),
  };
}

function readSync(value: Readonly<Record<string, unknown>>): MemorySync {
  const failure = recordAt(value, "failure");
  return {
    state: readString(value["state"]),
    lastSyncedAtISO: readString(value["lastSyncedAtISO"]),
    failure:
      failure === undefined
        ? undefined
        : {
            kind: readString(failure["kind"]),
            reason: readString(failure["reason"]),
            action: readString(failure["action"]),
            sinceISO: readString(failure["sinceISO"]),
            attempts: readNumber(failure["attempts"]),
            limitBytes: readNumber(failure["limitBytes"]),
          },
  };
}

/** The snapshot's fields in reading order; a value the host omitted is reported as such. */
export function memoryFields(snapshot: MemorySnapshot): readonly ReportedField[] {
  const active = snapshot.reflection.activeRun;
  const last = snapshot.reflection.lastOutcome;
  const sync = snapshot.sync;
  const syncFailure = sync === undefined ? undefined : sync.failure;
  return [
    reportedField("schema version", String(snapshot.schemaVersion)),
    reportedField("identity", snapshot.identity),
    reportedField(
      "non-journal state",
      snapshot.nonJournalUnknown ? "unknown: an initial journal-only delivery, not a measured zero" : undefined,
    ),
    reportedField("head", snapshot.repo.headSha),
    reportedField("head subject", snapshot.repo.headSubject),
    reportedField("committed at", snapshot.repo.committedAtISO),
    reportedField("dirty", booleanText(snapshot.repo.dirty)),
    reportedField("dirty paths", numberText(snapshot.repo.dirtyPaths)),
    reportedField("system token estimate", numberText(snapshot.repo.systemTokensEstimate)),
    reportedField("total bytes", numberText(snapshot.repo.totalBytes)),
    reportedField("system bytes", numberText(snapshot.repo.systemBytes)),
    reportedField("file count", numberText(snapshot.repo.fileCount)),
    reportedField("entries today", numberText(snapshot.repo.entriesToday)),
    reportedField("previous entry at", snapshot.repo.previousEntryAtISO),
    reportedField("reflection backlog", numberText(snapshot.reflection.backlogSteps)),
    reportedField("pending compaction", booleanText(snapshot.reflection.pendingCompaction)),
    reportedField("consecutive failures", numberText(snapshot.reflection.consecutiveFailures)),
    reportedField("active run", active === undefined ? undefined : describeActiveRun(active)),
    reportedField("last outcome", last === undefined ? undefined : describeLastOutcome(last)),
    reportedField("last failure fingerprint", snapshot.reflection.lastFailureFingerprint),
    reportedField("last consolidation at", snapshot.reflection.lastConsolidationAtISO),
    reportedField("journal steps", numberText(snapshot.journal.totalSteps)),
    reportedField("reflected steps", numberText(snapshot.journal.reflectedSteps)),
    reportedField("journal session", snapshot.journal.sessionId),
    reportedField("sync state", sync === undefined ? undefined : sync.state),
    reportedField("last synced at", sync === undefined ? undefined : sync.lastSyncedAtISO),
    reportedField(
      "sync failure",
      syncFailure === undefined
        ? undefined
        : syncFailure.kind + " · " + (syncFailure.reason ?? "reason not reported"),
    ),
    reportedField("sync failure action", syncFailure === undefined ? undefined : syncFailure.action),
    reportedField("sync failure attempts", syncFailure === undefined ? undefined : numberText(syncFailure.attempts)),
    reportedField("sync size limit", syncFailure === undefined ? undefined : numberText(syncFailure.limitBytes)),
  ];
}

function describeActiveRun(run: MemoryActiveRun): string {
  const parts: string[] = [];
  if (run.runId !== undefined) parts.push(run.runId);
  if (run.trigger !== undefined) parts.push("trigger " + run.trigger);
  if (run.category !== undefined) parts.push("category " + run.category);
  if (run.model !== undefined) parts.push("model " + run.model);
  if (run.startedAt !== undefined) parts.push("started " + run.startedAt);
  return parts.length === 0 ? "reported with no fields this surface reads" : parts.join(" · ");
}

function describeLastOutcome(last: MemoryLastOutcome): string {
  const parts: string[] = [];
  if (last.outcome !== undefined) parts.push(last.outcome);
  if (last.runId !== undefined) parts.push(last.runId);
  if (last.reason !== undefined) parts.push("reason " + last.reason);
  if (last.finishedAt !== undefined) parts.push("finished " + last.finishedAt);
  return parts.length === 0 ? "reported with no fields this surface reads" : parts.join(" · ");
}

/* ── team ───────────────────────────────────────────────────────────────────────────────────── */

export type TeamLivenessDetails = {
  readonly memberName: string;
  readonly lastKnownState: string;
  readonly reason: string | null;
  readonly killed: boolean;
  readonly deliveryKey: string | null;
};

export type TeamMemberRow = {
  readonly memberName: string;
  readonly lastKnownState: string;
  readonly reason: string | null;
  readonly killed: boolean;
  readonly reportedBy: "liveness-notification";
};

export type TeamSurface =
  | { readonly kind: "not-reported"; readonly reason: string }
  | {
      readonly kind: "reported";
      readonly rows: readonly TeamMemberRow[];
      readonly cap: number;
      readonly omitted: number;
      readonly note: string;
    };

export const TEAM_ROSTER_NOTE =
  "The host sends no team roster over RPC. Each row is a member the host reported through a " +
  TEAM_LIVENESS_CUSTOM_TYPE +
  " notification, which the host itself marks display=false; a member that never exited is not here.";

export function decodeTeamLiveness(raw: unknown): Reading<TeamLivenessDetails> {
  if (!isRecord(raw)) return { ok: false, reason: "the team liveness record is not an object" };
  const details = recordAt(raw, "details");
  if (details === undefined) return { ok: false, reason: "the team liveness record carries no details object" };
  const memberName = readString(details["memberName"]);
  if (memberName === undefined) return { ok: false, reason: "the team liveness record names no member" };
  const lastKnownState = readString(details["lastKnownState"]);
  if (lastKnownState === undefined) {
    return { ok: false, reason: "the team liveness record reports no last known state for " + memberName };
  }
  return {
    ok: true,
    value: {
      memberName: memberName,
      lastKnownState: lastKnownState,
      reason: readString(details["reason"]) ?? null,
      killed: details["killed"] === true,
      deliveryKey: readString(details["deliveryKey"]) ?? null,
    },
  };
}

/** A member row is keyed by name; a second report for the same member replaces its last state. */
export function upsertMember(rows: readonly TeamMemberRow[], details: TeamLivenessDetails): readonly TeamMemberRow[] {
  const row: TeamMemberRow = {
    memberName: details.memberName,
    lastKnownState: details.lastKnownState,
    reason: details.reason,
    killed: details.killed,
    reportedBy: "liveness-notification",
  };
  const index = rows.findIndex((candidate) => candidate.memberName === details.memberName);
  if (index === -1) return [...rows, row];
  return rows.map((candidate, at) => (at === index ? row : candidate));
}

export function teamSurface(rows: readonly TeamMemberRow[], delivered: boolean): TeamSurface {
  if (!delivered) return { kind: "not-reported", reason: "The host has not reported any member liveness for this session." };
  const shown = rows.slice(Math.max(0, rows.length - AGENT_ROW_CAP));
  const omitted = rows.length - shown.length;
  return {
    kind: "reported",
    rows: shown,
    cap: AGENT_ROW_CAP,
    omitted: omitted,
    note:
      omitted > 0
        ? TEAM_ROSTER_NOTE + " " + String(omitted) + " older member report(s) are not shown (cap " + String(AGENT_ROW_CAP) + ")."
        : TEAM_ROSTER_NOTE,
  };
}

/* ── turn liveness ──────────────────────────────────────────────────────────────────────────── */

export type TurnLiveness = { readonly verdict: string; readonly reason: string | null };

export function decodeTurnLiveness(raw: unknown): Reading<TurnLiveness> {
  if (!isRecord(raw)) return { ok: false, reason: "the turn liveness event is not an object" };
  const verdictSource = recordAt(raw, "verdict");
  const verdict = verdictSource === undefined ? readString(raw["kind"]) : readString(verdictSource["kind"]);
  if (verdict === undefined) return { ok: false, reason: "the turn liveness event reports no verdict kind" };
  const reason = verdictSource === undefined ? readString(raw["reason"]) : readString(verdictSource["reason"]);
  return { ok: true, value: { verdict: verdict, reason: reason ?? null } };
}

/* ── status entries ─────────────────────────────────────────────────────────────────────────── */

/** One footer status entry; `text: null` is a clear frame for that key, not an empty line. */
export type StatusEntry = { readonly key: string; readonly text: string | null };

/* ── widgets ────────────────────────────────────────────────────────────────────────────────── */

export type WidgetAction = { readonly label: string; readonly command: string };

export type WidgetEntry = {
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: string | null;
  readonly actions: readonly WidgetAction[];
  readonly cleared: boolean;
};

export type WidgetSurface =
  | { readonly kind: "not-reported"; readonly reason: string }
  | { readonly kind: "reported"; readonly entries: readonly WidgetEntry[]; readonly note: string };

export const WIDGET_NOTE =
  "Only string-array widgets travel over RPC. A component factory emits no record, so a factory widget can never appear here as rows.";

export function decodeWidgetActions(raw: unknown): Reading<readonly WidgetAction[]> {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "widgetActions is not a list" };
  const actions: WidgetAction[] = [];
  for (const item of raw) {
    if (!isRecord(item)) return { ok: false, reason: "a widgetAction is not an object" };
    const label = readString(item["label"]);
    const command = readString(item["command"]);
    if (label === undefined || command === undefined) {
      return { ok: false, reason: "a widgetAction has no string label and command" };
    }
    actions.push({ label: label, command: command });
  }
  return { ok: true, value: actions };
}

/* ── notifications ──────────────────────────────────────────────────────────────────────────── */

export type NotificationEntry = {
  readonly id: number;
  readonly message: string;
  readonly level: string;
  readonly display: boolean;
  readonly source: "notify" | "custom-message";
};

export type NotificationsView = {
  readonly visible: readonly NotificationEntry[];
  readonly hidden: readonly NotificationEntry[];
  readonly note: string;
};

export const NOTIFY_LEVELS: readonly string[] = ["info", "warning", "error"];

/* ── frames ─────────────────────────────────────────────────────────────────────────────────── */

export type StatusFrame =
  | { readonly kind: "memory"; readonly data: unknown; readonly sessionId: string | null }
  | { readonly kind: "team-liveness"; readonly details: TeamLivenessDetails; readonly display: boolean; readonly sessionId: string | null }
  | { readonly kind: "turn-liveness"; readonly verdict: string; readonly reason: string | null; readonly sessionId: string | null }
  | { readonly kind: "status"; readonly key: string; readonly text: string | null; readonly sessionId: string | null }
  | {
      readonly kind: "widget";
      readonly key: string;
      readonly lines: readonly string[];
      readonly placement: string | null;
      readonly actions: readonly WidgetAction[];
      readonly cleared: boolean;
      readonly sessionId: string | null;
    }
  | { readonly kind: "notification"; readonly message: string; readonly level: string; readonly sessionId: string | null }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Reads one raw host frame. Only the frames these surfaces own are decoded; anything else is
 * ignored with a reason, and a frame that claims one of these shapes but does not carry it is
 * rejected with the reason instead of being coerced.
 */
export function decodeStatusFrame(raw: unknown): StatusFrame {
  if (!isRecord(raw)) return { kind: "ignored", reason: "the frame is not an object" };
  const type = readString(raw["type"]);
  const sessionId = readString(raw["sessionId"]) ?? null;

  if (type === "extension_event") {
    const name = readString(raw["name"]);
    if (name === MEMORY_UPDATED_EVENT) return { kind: "memory", data: raw["data"], sessionId: sessionId };
    if (name === TURN_END_LIVENESS_EVENT) {
      const decoded = decodeTurnLiveness(raw["data"]);
      if (!decoded.ok) return { kind: "rejected", reason: decoded.reason };
      return {
        kind: "turn-liveness",
        verdict: decoded.value.verdict,
        reason: decoded.value.reason,
        sessionId: sessionId,
      };
    }
    return { kind: "ignored", reason: "extension_event " + String(name ?? "(no name)") + " is not a status surface" };
  }

  if (type === "extension_ui_request") {
    const method = readString(raw["method"]);
    if (method === "notify") {
      const message = readString(raw["message"]);
      if (message === undefined) return { kind: "rejected", reason: "a notify frame carries no message string" };
      return { kind: "notification", message: message, level: readString(raw["notifyType"]) ?? "info", sessionId: sessionId };
    }
    if (method === "setStatus") {
      const key = readString(raw["statusKey"]);
      if (key === undefined) return { kind: "rejected", reason: "a setStatus frame carries no statusKey" };
      // `statusText: undefined` is the documented clear for that key.
      return { kind: "status", key: key, text: readString(raw["statusText"]) ?? null, sessionId: sessionId };
    }
    if (method === "setWidget") {
      const key = readString(raw["widgetKey"]);
      if (key === undefined) return { kind: "rejected", reason: "a setWidget frame carries no widgetKey" };
      const lines = readStringArray(raw["widgetLines"]);
      const actions = decodeWidgetActions(raw["widgetActions"]);
      if (!actions.ok) return { kind: "rejected", reason: "setWidget " + key + ": " + actions.reason };
      if (raw["widgetLines"] !== undefined && lines === undefined) {
        return { kind: "rejected", reason: "setWidget " + key + " carries widgetLines that are not a string array" };
      }
      return {
        kind: "widget",
        key: key,
        lines: lines ?? [],
        placement: readString(raw["widgetPlacement"]) ?? null,
        actions: actions.value,
        cleared: lines === undefined,
        sessionId: sessionId,
      };
    }
    return { kind: "ignored", reason: "extension_ui_request " + String(method ?? "(no method)") + " is not a status surface" };
  }

  if (type === "custom_message") {
    const customType = readString(raw["customType"]);
    if (customType !== TEAM_LIVENESS_CUSTOM_TYPE) {
      return { kind: "ignored", reason: "custom_message " + String(customType ?? "(no customType)") + " is not a status surface" };
    }
    const decoded = decodeTeamLiveness(raw);
    if (!decoded.ok) return { kind: "rejected", reason: decoded.reason };
    return {
      kind: "team-liveness",
      details: decoded.value,
      display: raw["display"] !== false,
      sessionId: sessionId,
    };
  }

  return { kind: "ignored", reason: "frame type " + String(type ?? "(none)") + " is not a status surface" };
}

/**
 * Reads what `omo.memory.status` answers (or an `omo.memory.updated` payload): the snapshot, the
 * host's own `{kind: "unavailable", reason}` refusal, or a rejected payload with its reason.
 */
export type MemoryAnswer =
  | { readonly kind: "snapshot"; readonly snapshot: MemorySnapshot }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

export function decodeMemoryAnswer(raw: unknown): MemoryAnswer {
  if (isRecord(raw) && raw["kind"] === "unavailable") {
    const reason = readString(raw["reason"]) ?? "the host reported the memory snapshot as unavailable without a reason";
    return { kind: "unavailable", reason: reason };
  }
  const decoded = decodeMemorySnapshot(raw);
  if (decoded.ok) return { kind: "snapshot", snapshot: decoded.value };
  return { kind: "rejected", reason: decoded.reason };
}

/* ── memory write gate ──────────────────────────────────────────────────────────────────────── */

export type MemoryFactsRequest = {
  readonly records: readonly unknown[];
  readonly batchId: string | undefined;
};

export type MemoryFactsResponse =
  | { readonly outcome: "committed"; readonly sha: string; readonly affectedPaths: readonly string[]; readonly batchId: string }
  | { readonly outcome: "no_facts"; readonly affectedPaths: readonly string[] }
  | { readonly outcome: "parent_dirty"; readonly batchId: string; readonly detail?: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

export type MemoryWritePlan = {
  readonly id: string;
  readonly request: MemoryFactsRequest;
  /** The exact content the user must see, and the exact text authorization must echo back. */
  readonly content: string;
};

export type MemoryWriteRefusal = {
  readonly kind: "refused";
  readonly code: MemoryWriteRefusalCode;
  readonly message: string;
};

export type MemoryWriteOutcome =
  | { readonly kind: "committed"; readonly sha: string; readonly affectedPaths: readonly string[]; readonly batchId: string }
  | { readonly kind: "no-facts" }
  | MemoryWriteRefusal;

export type MemoryWriteRefusalCode =
  | "NOTHING_TO_WRITE"
  | "UNKNOWN_BATCH_ID"
  | "INVALID_RECORDS"
  | "UNKNOWN_PLAN"
  | "CONTENT_MISMATCH"
  | "NOT_CONNECTED"
  | "IN_FLIGHT"
  | "WRITE_FAILED"
  | "HOST_REFUSED";

export type MemoryWritePlanOutcome =
  | { readonly kind: "planned"; readonly plan: MemoryWritePlan }
  | MemoryWriteRefusal;

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The exact extension_request the client would write; authorization must echo it verbatim. */
export function buildMemoryWriteContent(id: string, request: MemoryFactsRequest): string {
  const data: { records: readonly unknown[]; batchId?: string } = { records: request.records };
  if (request.batchId !== undefined) data.batchId = request.batchId;
  return JSON.stringify({ id: id, type: "extension_request", name: MEMORY_FACTS_APPLY_METHOD, data: data }, null, 2);
}

/**
 * Plans a facts write. Nothing is sent here: the plan carries the exact bytes, and the caller must
 * show them and call `authorizeWrite` with the same text.
 */
export function planMemoryWrite(id: string, request: MemoryFactsRequest): MemoryWritePlanOutcome {
  if (request.records.length === 0) {
    return { kind: "refused", code: "NOTHING_TO_WRITE", message: "No facts were selected, so there is nothing to write." };
  }
  if (request.batchId !== undefined && !BATCH_ID.test(request.batchId)) {
    return {
      kind: "refused",
      code: "UNKNOWN_BATCH_ID",
      message: "batchId " + request.batchId + " is not a UUID v4, which is the only id the host accepts.",
    };
  }
  for (const record of request.records) {
    if (!isRecord(record)) {
      return { kind: "refused", code: "INVALID_RECORDS", message: "A fact record is not an object, so the batch is not sent." };
    }
  }
  return {
    kind: "planned",
    plan: { id: id, request: request, content: buildMemoryWriteContent(id, request) },
  };
}

/** The gate `authorizeWrite` runs before any write; exported so a view can preview the refusal. */
export function gateMemoryWrite(input: {
  readonly plan: MemoryWritePlan | null;
  readonly planId: string;
  readonly shownContent: string;
  readonly inFlight: boolean;
  readonly connected: boolean;
}): MemoryWriteRefusal | null {
  if (input.plan === null || input.plan.id !== input.planId) {
    return {
      kind: "refused",
      code: "UNKNOWN_PLAN",
      message: "No pending memory write matches " + input.planId + ", so nothing was sent.",
    };
  }
  if (input.shownContent !== input.plan.content) {
    return {
      kind: "refused",
      code: "CONTENT_MISMATCH",
      message:
        "The authorization text differs from the exact content this plan would write, so nothing was sent. The shown content is:\n" +
        input.plan.content,
    };
  }
  if (input.inFlight) {
    return { kind: "refused", code: "IN_FLIGHT", message: "This memory write is already in flight, so it was not sent twice." };
  }
  if (!input.connected) {
    return {
      kind: "refused",
      code: "NOT_CONNECTED",
      message: "No memory facts channel is attached, so " + MEMORY_FACTS_APPLY_METHOD + " was not sent.",
    };
  }
  return null;
}

/* ── column geometry ───────────────────────────────────────────────────────────────────────── */

/** The host's own width rule: the column is clamped to 32–80 columns whatever the layout offers. */
export function statusColumnWidth(available: number): number {
  if (available < PANEL_MIN_COLUMNS) return PANEL_MIN_COLUMNS;
  if (available > PANEL_MAX_COLUMNS) return PANEL_MAX_COLUMNS;
  return Math.floor(available);
}

/** The transcript never shrinks below 60 columns, so the column hides when both cannot fit. */
export function statusColumnFits(terminalWidth: number): boolean {
  return terminalWidth >= MIN_TRANSCRIPT_COLUMNS + PANEL_MIN_COLUMNS;
}

/** Below `COMPACT_COLUMNS` a label and its value stack instead of sharing a row. */
export function compactLayout(terminalWidth: number): boolean {
  return terminalWidth < COMPACT_COLUMNS;
}
