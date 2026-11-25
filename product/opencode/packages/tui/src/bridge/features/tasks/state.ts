import type { Goal } from "@opencode/schema/goal";
import { decodeHostFrame } from "../../../../../bridge-core/src/host-frames.ts";
import type { HostFrame, SelectRequestFrame } from "../../../../../bridge-core/src/host-frames.ts";
import { parseTodos } from "../../../util/todo";
import type { Todo } from "../../../util/todo";

/**
 * Four independent subjects, four independent derivations.
 *
 * - A task is an OmO/Senpi subagent run (`omo.task.list` / `omo.task.updated`), not a todo.
 * - The todo list is the todo plugin's state on the session's **current branch** (`senpi.todo-state`
 *   custom entries reachable from the leaf), never the last todo row in the whole history and never
 *   inferred from `omo.task.*`.
 * - The goal is the goal plugin's `Goal.State`, the same object its dialog renders. A status line that
 *   merely mentions the goal, or the derived `goal_blocked` / `goal_paused` lifecycle markers, is not a
 *   goal snapshot and never becomes one here.
 * - Thread approvals are the `select` permission prompts the host writes (`Permission required: …`) and
 *   their answers.
 *
 * Every input is what the host reported. A subject the host has not delivered is reported as not
 * reported, and a snapshot the host truncated says so instead of reading as complete.
 */

/** The one title the permission system writes for an approval prompt (`prompt.ts`: `Permission required: ${request.permission}`). */
export const PERMISSION_TITLE_PREFIX = "Permission required:";

/** The custom entry type the todo plugin stores its state under (`todo-types.ts`). */
export const TODO_CUSTOM_TYPE = "senpi.todo-state";

/**
 * One task snapshot carries at most this many rows; the host reports what it left out as
 * `truncated_tasks`. Running and pending tasks near the tail of the store are kept first, so even
 * active work can be omitted.
 */
export const TASK_SNAPSHOT_LIMIT = 256;

/** The host hands tasks back in its store's filename order; that is not creation or completion order. */
export const TASK_ORDER_NOTE = "Host store order, not time order: this surface does not sort tasks.";

/* ── tasks ───────────────────────────────────────────────────────────────────────────────────── */

/**
 * One task as `omo.task.list` reports it. `status` stays the reported string: which values the host
 * may send is not enumerated here.
 */
export type HostTask = {
  readonly id: string;
  readonly parentSessionId: string;
  readonly status: string;
  readonly description: string;
  /** The host caps the description and marks where it cut it. */
  readonly descriptionTruncated: boolean;
  readonly error: string | null;
  /** The host caps the error message and marks where it cut it. */
  readonly errorTruncated: boolean;
};

/** The snapshot `omo.task.list` answers with, and `omo.task.updated` republishes. */
export type TaskSnapshot = {
  readonly parentSessionId: string;
  readonly tasks: readonly HostTask[];
  /** Rows the host left out of this snapshot (`truncated_tasks`). */
  readonly omitted: number;
};

export type TaskRow = {
  readonly id: string;
  readonly status: string;
  readonly description: string;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly errorTruncated: boolean;
  /** Whether this thread holds the task or only sees it through a session match. */
  readonly ownership: "this-thread" | "another-session";
};

export type TaskActivity =
  | { readonly kind: "not-reported"; readonly reason: string }
  | {
      readonly kind: "reported";
      readonly rows: readonly TaskRow[];
      readonly active: number;
      readonly omitted: number;
      /** False when the host left rows out, so the list must never read as complete. */
      readonly complete: boolean;
      readonly order: string;
      readonly note: string;
    };

export function deriveTaskActivity(input: {
  readonly snapshot: TaskSnapshot | null;
  readonly sessionID: string | null;
}): TaskActivity {
  const snapshot = input.snapshot;
  if (snapshot === null) {
    return { kind: "not-reported", reason: "The host has not answered a task snapshot for this thread." };
  }
  const rows = snapshot.tasks.map<TaskRow>((task) => ({
    id: task.id,
    status: task.status,
    description: task.description,
    truncated: task.descriptionTruncated,
    error: task.error,
    errorTruncated: task.errorTruncated,
    ownership: task.parentSessionId === input.sessionID ? "this-thread" : "another-session",
  }));
  const active = rows.filter((row) => row.status === "running" || row.status === "pending").length;
  const complete = snapshot.omitted === 0;
  return {
    kind: "reported",
    rows: rows,
    active: active,
    omitted: snapshot.omitted,
    complete: complete,
    order: TASK_ORDER_NOTE,
    note: complete
      ? "The host reported this snapshot as complete."
      : String(snapshot.omitted) +
        " task(s) are missing from this snapshot; running tasks can be among them, so this list is not complete.",
  };
}

export type TaskActionKind = "send" | "cancel";

export type TaskAction =
  | { readonly kind: "send"; readonly taskId: string; readonly parentSessionId: string }
  | { readonly kind: "cancel"; readonly taskId: string; readonly parentSessionId: string };

export type TaskActionRefusalCode =
  | "NO_THREAD"
  | "UNKNOWN_TASK"
  | "PARENT_SESSION_REQUIRED"
  | "NOT_CONNECTED"
  | "WRITE_FAILED";

export type TaskActionOutcome =
  | { readonly kind: "sent"; readonly taskId: string; readonly action: TaskActionKind }
  | { readonly kind: "refused"; readonly code: TaskActionRefusalCode; readonly message: string };

/**
 * The task RPCs check the task's **direct parent session** before acting; a session that lists a task
 * through a root-session match may see it and still not send or cancel it. The gate lives here so a
 * cross-session action is refused before any write, and the refusal is what the caller renders.
 */
export function gateTaskAction(input: {
  readonly action: TaskActionKind;
  readonly taskId: string;
  readonly sessionID: string | null;
  readonly snapshot: TaskSnapshot | null;
  readonly connected: boolean;
}): TaskActionOutcome {
  if (input.sessionID === null) {
    return {
      kind: "refused",
      code: "NO_THREAD",
      message: "No thread is selected, so no session could own this " + input.action + " request; nothing was sent.",
    };
  }
  const task = input.snapshot?.tasks.find((candidate) => candidate.id === input.taskId);
  if (task === undefined) {
    return {
      kind: "refused",
      code: "UNKNOWN_TASK",
      message: "Task " + input.taskId + " is not in the snapshot this thread holds, so nothing was sent.",
    };
  }
  if (task.parentSessionId !== input.sessionID) {
    return {
      kind: "refused",
      code: "PARENT_SESSION_REQUIRED",
      message:
        "Task " +
        task.id +
        " belongs to session " +
        task.parentSessionId +
        ", not to this thread (" +
        input.sessionID +
        "). Acting on it needs that parent session's own approval, so nothing was sent.",
    };
  }
  if (!input.connected) {
    return {
      kind: "refused",
      code: "NOT_CONNECTED",
      message: "No task RPC adapter is connected, so the " + input.action + " request was not sent.",
    };
  }
  return { kind: "sent", taskId: task.id, action: input.action };
}

/* ── todo (current branch) ───────────────────────────────────────────────────────────────────── */

/** One session-tree entry as `get_entries` delivers it. */
export type BranchEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly customType: string | null;
  readonly data: unknown;
};

/** The entries plus the leaf the session currently sits on; the branch is what leads to that leaf. */
export type BranchSnapshot = {
  readonly leafId: string | null;
  readonly entries: readonly BranchEntry[];
};

export type TodoSurface =
  | { readonly kind: "not-reported"; readonly reason: string }
  | { readonly kind: "no-branch"; readonly reason: string }
  | { readonly kind: "unreadable"; readonly reason: string }
  | {
      readonly kind: "reported";
      readonly todos: readonly Todo[];
      /** The entry ids from leaf to root the reconstruction walked. */
      readonly branch: readonly string[];
      /** Entries the reconstruction never reached, which include abandoned branches. */
      readonly elsewhere: number;
      readonly dropped: number;
      readonly note: string;
    };

/**
 * Rebuilds the todo list from the current branch: walk parent links from the leaf, and take the first
 * `senpi.todo-state` entry met on that path. Entries off the path belong to abandoned branches and
 * are ignored even when the last one in delivery order is a todo entry.
 */
export function deriveBranchTodos(snapshot: BranchSnapshot | null): TodoSurface {
  if (snapshot === null) {
    return { kind: "not-reported", reason: "The host has not delivered session entries for this thread." };
  }
  if (snapshot.leafId === null) {
    return { kind: "no-branch", reason: "The host reports no leaf id, so no branch can be walked." };
  }
  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry] as const));
  const leaf = byId.get(snapshot.leafId);
  if (leaf === undefined) {
    return {
      kind: "no-branch",
      reason: "The reported leaf " + snapshot.leafId + " is not among the delivered entries.",
    };
  }
  const branch: string[] = [];
  const seen = new Set<string>();
  let cursor: BranchEntry | undefined = leaf;
  while (cursor !== undefined && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    branch.push(cursor.id);
    if (cursor.customType === TODO_CUSTOM_TYPE) {
      return todoFromEntry(cursor, branch, snapshot.entries.length - branch.length);
    }
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
  }
  return {
    kind: "reported",
    todos: [],
    branch: branch,
    elsewhere: snapshot.entries.length - branch.length,
    dropped: 0,
    note:
      "No " +
      TODO_CUSTOM_TYPE +
      " entry is on the current branch (" +
      String(branch.length) +
      " entries deep); an empty list here is the host's state, not a missing surface.",
  };
}

function todoFromEntry(entry: BranchEntry, branch: readonly string[], elsewhere: number): TodoSurface {
  const raw: unknown = entry.data;
  if (!Array.isArray(raw)) {
    return {
      kind: "unreadable",
      reason: "The todo entry " + entry.id + " on the current branch carries no list, so its state is unknown.",
    };
  }
  const todos = parseTodos(raw);
  const dropped = raw.length - todos.length;
  return {
    kind: "reported",
    todos: todos,
    branch: branch,
    elsewhere: elsewhere,
    dropped: dropped,
    note:
      "Rebuilt from the current branch (" +
      String(branch.length) +
      " entries from the leaf); " +
      String(elsewhere) +
      " entries on other branches are ignored." +
      (dropped === 0 ? "" : " " + String(dropped) + " row(s) did not have the shape this TUI reads."),
  };
}

/* ── goal ────────────────────────────────────────────────────────────────────────────────────── */

/** Derived lifecycle markers the host projects; they carry no objective and are not a goal snapshot. */
export type GoalMarker = "goal_blocked" | "goal_paused";

/**
 * The goal plugin's answer. `goal-plugin` means its RPC is present and answered: `state` undefined is
 * then a real "no goal". `unsupported` means the connection has no such surface, which must not be
 * rendered as "no goal".
 */
export type GoalInput =
  | { readonly source: "goal-plugin"; readonly state: Goal.State | undefined }
  | { readonly source: "unsupported"; readonly detail: string };

export type GoalSurface =
  | { readonly kind: "unavailable"; readonly detail: string; readonly marker: GoalMarker | null }
  | { readonly kind: "absent"; readonly note: string; readonly marker: GoalMarker | null }
  | {
      readonly kind: "present";
      readonly objective: string;
      readonly status: Goal.State["status"];
      readonly statusLabel: string;
      readonly rounds: number;
      readonly maxRounds: number;
      readonly reason: string | null;
      readonly marker: GoalMarker | null;
      readonly note: string;
    };

export type GoalActionKind = "pause" | "resume" | "clear";

export const GOAL_ACTIONS: readonly GoalActionKind[] = ["pause", "resume", "clear"];

export type GoalActionOutcome =
  | { readonly kind: "sent"; readonly action: GoalActionKind }
  | {
      readonly kind: "refused";
      readonly code: "GOAL_RPC_UNAVAILABLE" | "GOAL_ABSENT" | "NOT_CONNECTED" | "WRITE_FAILED";
      readonly message: string;
    };

/**
 * `inspect` is deliberately absent: the goal command parser turns `/goal inspect` into a new objective,
 * so it is a write, not a read, and this surface never queries the goal that way.
 */
export function gateGoalAction(input: {
  readonly action: GoalActionKind;
  readonly goal: GoalInput;
  readonly connected: boolean;
}): GoalActionOutcome {
  if (input.action !== "pause" && input.action !== "resume" && input.action !== "clear") {
    return {
      kind: "refused",
      code: "GOAL_RPC_UNAVAILABLE",
      message: "Only pause, resume and clear are goal writes; this surface sends nothing else.",
    };
  }
  if (input.goal.source === "unsupported") {
    return {
      kind: "refused",
      code: "GOAL_RPC_UNAVAILABLE",
      message:
        "The goal RPC surface is not available on this connection, so /goal " +
        input.action +
        " was not sent. /goal inspect is not used as a read: it would set an objective.",
    };
  }
  if (input.goal.state === undefined) {
    return { kind: "refused", code: "GOAL_ABSENT", message: "This session has no goal, so there is nothing to " + input.action + "." };
  }
  if (!input.connected) {
    return {
      kind: "refused",
      code: "NOT_CONNECTED",
      message: "No goal command sink is connected, so /goal " + input.action + " was not sent.",
    };
  }
  return { kind: "sent", action: input.action };
}

export function deriveGoal(input: { readonly goal: GoalInput; readonly marker: GoalMarker | null }): GoalSurface {
  if (input.goal.source === "unsupported") {
    return { kind: "unavailable", detail: input.goal.detail, marker: input.marker };
  }
  const state = input.goal.state;
  if (state === undefined) {
    return {
      kind: "absent",
      note: "The goal plugin answered for this session and reports no goal.",
      marker: input.marker,
    };
  }
  return {
    kind: "present",
    objective: state.objective,
    status: state.status,
    statusLabel: state.status === "paused" ? "goal paused" : state.status === "complete" ? "goal met" : "goal",
    rounds: state.rounds,
    maxRounds: state.maxRounds,
    reason: state.reason ?? null,
    marker: input.marker,
    note:
      input.marker === null
        ? "From the goal plugin's state; no lifecycle marker is reported alongside it."
        : "From the goal plugin's state. The host also reports " + input.marker + ", a derived marker with no objective.",
  };
}

/* ── approvals ───────────────────────────────────────────────────────────────────────────────── */

export type ApprovalOrigin = "this-thread" | "another-session" | "unattributed";

export type ApprovalStatus = "open" | "answered" | "closed";

/** One permission prompt on this thread, as the host wrote it. */
export type ApprovalEntry = {
  /** The `extension_ui_request` frame id, which is what an answer must echo. */
  readonly requestId: string;
  readonly permission: string;
  readonly detail: string;
  readonly toolCallId: string | null;
  readonly sessionId: string | null;
  readonly options: readonly string[];
  readonly origin: ApprovalOrigin;
  readonly status: ApprovalStatus;
  readonly decision: string | null;
};

export type FrameOutcome =
  | { readonly kind: "recorded"; readonly entry: ApprovalEntry }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string };

export type ApprovalRefusalCode =
  | "UNKNOWN_APPROVAL"
  | "CROSS_SESSION_APPROVAL"
  | "NOT_CONNECTED"
  | "NOT_OPEN"
  | "INVALID_OPTION"
  | "WRITE_FAILED";

export type ApprovalOutcome =
  | { readonly kind: "answered"; readonly requestId: string; readonly decision: string }
  | { readonly kind: "refused"; readonly code: ApprovalRefusalCode; readonly message: string };

/**
 * Reads a decoded frame as an approval. A `select` whose title is not the permission title belongs to
 * another surface and is ignored here; an answer or cancellation frame is not an approval request.
 */
export function approvalFromDialog(
  frame: HostFrame,
  sessionID: string | null,
): { readonly kind: "approval"; readonly entry: ApprovalEntry } | { readonly kind: "ignored"; readonly reason: string } {
  if (frame.type !== "extension_ui_request") {
    return { kind: "ignored", reason: "this frame is a " + frame.type + ", not a dialog request" };
  }
  if (frame.method !== "select") {
    return { kind: "ignored", reason: "this frame is an extension_ui_request " + frame.method + ", not a select prompt" };
  }
  const parsed = parsePermissionTitle(frame);
  if (parsed === undefined) {
    return { kind: "ignored", reason: "this select prompt is not a permission approval" };
  }
  return {
    kind: "approval",
    entry: {
      requestId: frame.id,
      permission: parsed.permission,
      detail: parsed.detail,
      toolCallId: frame.toolCallId ?? null,
      sessionId: frame.sessionId ?? null,
      options: frame.options,
      origin: originOf(frame.sessionId, sessionID),
      status: "open",
      decision: null,
    },
  };
}

/** Validates one raw host frame before it can become an approval; a rejected frame is reported, not guessed at. */
export function approvalFromWire(raw: unknown, sessionID: string | null): FrameOutcome {
  const decoded = decodeHostFrame(raw);
  if (!decoded.ok) return { kind: "rejected", reason: decoded.reason };
  const read = approvalFromDialog(decoded.frame, sessionID);
  if (read.kind === "ignored") return read;
  return { kind: "recorded", entry: read.entry };
}

/**
 * The owner of a task or an approval is checked before any write. A prompt the host routed to another
 * session is visible here and cannot be answered from this thread: the parent session must answer it.
 */
export function gateApprovalAnswer(input: {
  readonly requestId: string;
  readonly decision: string;
  readonly entries: readonly ApprovalEntry[];
  readonly sessionID: string | null;
  readonly connected: boolean;
}): ApprovalOutcome {
  const entry = input.entries.find((candidate) => candidate.requestId === input.requestId);
  if (entry === undefined) {
    return {
      kind: "refused",
      code: "UNKNOWN_APPROVAL",
      message: "Approval " + input.requestId + " is not held by this thread, so nothing was answered.",
    };
  }
  if (entry.status !== "open") {
    return {
      kind: "refused",
      code: "NOT_OPEN",
      message: "Approval " + input.requestId + " is already " + entry.status + " and is not answered twice.",
    };
  }
  if (entry.origin === "another-session") {
    return {
      kind: "refused",
      code: "CROSS_SESSION_APPROVAL",
      message:
        "This approval was raised for session " +
        String(entry.sessionId) +
        ", not for this thread (" +
        String(input.sessionID) +
        "). It needs that parent session's own approval, so nothing was answered.",
    };
  }
  if (!input.connected) {
    return {
      kind: "refused",
      code: "NOT_CONNECTED",
      message: "No host dialog sender is attached, so the answer to " + input.requestId + " was not written.",
    };
  }
  if (!entry.options.includes(input.decision)) {
    return {
      kind: "refused",
      code: "INVALID_OPTION",
      message: '"' + input.decision + '" is not one of the options the host offered for ' + input.requestId + ".",
    };
  }
  return { kind: "answered", requestId: entry.requestId, decision: input.decision };
}

function parsePermissionTitle(frame: SelectRequestFrame): { permission: string; detail: string } | undefined {
  if (!frame.title.startsWith(PERMISSION_TITLE_PREFIX)) return undefined;
  const rest = frame.title.slice(PERMISSION_TITLE_PREFIX.length);
  const newline = rest.indexOf("\n");
  const permission = (newline === -1 ? rest : rest.slice(0, newline)).trim();
  if (permission.length === 0) return undefined;
  const detail = newline === -1 ? "" : rest.slice(newline + 1).trim();
  return { permission: permission, detail: detail };
}

function originOf(sessionId: string | undefined, sessionID: string | null): ApprovalOrigin {
  if (sessionId === undefined) return "unattributed";
  if (sessionID !== null && sessionId === sessionID) return "this-thread";
  if (sessionID === null) return "unattributed";
  return "another-session";
}
