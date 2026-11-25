import { createSignal } from "solid-js";
import type { HostDialogRequestFrame } from "../../../../../bridge-core/src/dialogs-host.ts";
import type { HostResponseAnswer } from "../../../../../bridge-core/src/host-frames.ts";
import type { BridgeTuiData } from "../../../context/bridge-data.ts";
import {
  approvalFromDialog,
  approvalFromWire,
  deriveBranchTodos,
  deriveGoal,
  deriveTaskActivity,
  gateApprovalAnswer,
  gateGoalAction,
  gateTaskAction,
} from "./state.ts";
import type {
  ApprovalEntry,
  ApprovalOutcome,
  BranchSnapshot,
  FrameOutcome,
  GoalActionKind,
  GoalActionOutcome,
  GoalInput,
  GoalMarker,
  GoalSurface,
  TaskActionKind,
  TaskActionOutcome,
  TaskActivity,
  TaskSnapshot,
  TodoSurface,
} from "./state.ts";

export type NoticeTarget = "tasks" | "todo" | "goal" | "approvals";

/** A refusal or a rejected frame, kept so the view can show it instead of dropping it. */
export type TaskNotice = {
  readonly id: number;
  readonly target: NoticeTarget;
  readonly code: string;
  readonly message: string;
};

export type TasksStoreDeps = {
  readonly sessionID: string | null;
  /** The one write path the bridge exposes for a host dialog; absent when nothing can be answered. */
  readonly respond?: (requestId: string, answer: HostResponseAnswer) => void;
  /** The task RPC adapter. It is not wired in this build, so task actions report that they were not sent. */
  readonly sendTaskAction?: (action: { readonly kind: TaskActionKind; readonly taskId: string }) => void;
  /** The session command sink that carries `/goal pause|resume|clear`. */
  readonly sendGoalAction?: (action: GoalActionKind) => void;
};

export type TasksStore = {
  readonly sessionID: () => string | null;
  readonly tasks: () => TaskActivity;
  readonly todos: () => TodoSurface;
  readonly goal: () => GoalSurface;
  readonly approvals: () => readonly ApprovalEntry[];
  readonly openApprovals: () => readonly ApprovalEntry[];
  readonly notices: () => readonly TaskNotice[];
  readonly applyTaskSnapshot: (snapshot: TaskSnapshot) => void;
  readonly applyBranchSnapshot: (snapshot: BranchSnapshot) => void;
  readonly applyGoal: (goal: GoalInput) => void;
  readonly applyGoalMarker: (marker: GoalMarker | null) => void;
  readonly applyDialog: (frame: HostDialogRequestFrame) => FrameOutcome;
  readonly applyWireFrame: (raw: unknown) => FrameOutcome;
  readonly closeApproval: (requestId: string) => boolean;
  readonly answerApproval: (requestId: string, decision: string) => ApprovalOutcome;
  readonly actOnTask: (taskId: string, action: TaskActionKind) => TaskActionOutcome;
  readonly actOnGoal: (action: GoalActionKind) => GoalActionOutcome;
  readonly clearNotices: () => void;
};

/**
 * Holds the four subjects in four separate signals, so an event for one never rewrites another: a task
 * update leaves the todo, goal and approval surfaces exactly as they were. Every write on a live host
 * object — a task action, a goal command, a dialog answer — runs the ownership gate first and records
 * its refusal as a notice rather than dropping it.
 */
export function createTasksStore(deps: TasksStoreDeps): TasksStore {
  const [taskSnapshot, setTaskSnapshot] = createSignal<TaskSnapshot | null>(null);
  const [branchSnapshot, setBranchSnapshot] = createSignal<BranchSnapshot | null>(null);
  const [goalInput, setGoalInput] = createSignal<GoalInput | null>(null);
  const [goalMarker, setGoalMarker] = createSignal<GoalMarker | null>(null);
  const [entries, setEntries] = createSignal<readonly ApprovalEntry[]>([]);
  const [notices, setNotices] = createSignal<readonly TaskNotice[]>([]);
  let nextNotice = 1;

  const note = (target: NoticeTarget, code: string, message: string) => {
    const id = nextNotice;
    nextNotice += 1;
    setNotices((current) => [...current, { id: id, target: target, code: code, message: message }]);
  };

  const goal = (): GoalSurface => {
    const input = goalInput();
    if (input === null) {
      return {
        kind: "unavailable",
        detail: "The goal plugin has not answered for this session yet.",
        marker: goalMarker(),
      };
    }
    return deriveGoal({ goal: input, marker: goalMarker() });
  };

  const upsertApproval = (entry: ApprovalEntry): ApprovalEntry => {
    const existing = entries().find((candidate) => candidate.requestId === entry.requestId);
    if (existing !== undefined) return existing;
    setEntries((current) => [...current, entry]);
    return entry;
  };

  const applyDialog = (frame: HostDialogRequestFrame): FrameOutcome => {
    const read = approvalFromDialog(frame, deps.sessionID);
    if (read.kind === "ignored") return read;
    return { kind: "recorded", entry: upsertApproval(read.entry) };
  };

  return {
    sessionID: () => deps.sessionID,
    tasks: () => deriveTaskActivity({ snapshot: taskSnapshot(), sessionID: deps.sessionID }),
    todos: () => deriveBranchTodos(branchSnapshot()),
    goal: goal,
    approvals: entries,
    openApprovals: () => entries().filter((entry) => entry.status === "open"),
    notices: notices,
    applyTaskSnapshot: (snapshot) => setTaskSnapshot(snapshot),
    applyBranchSnapshot: (snapshot) => setBranchSnapshot(snapshot),
    applyGoal: (input) => setGoalInput(input),
    applyGoalMarker: (marker) => setGoalMarker(marker),
    applyDialog: applyDialog,
    applyWireFrame: (raw) => {
      const outcome = approvalFromWire(raw, deps.sessionID);
      if (outcome.kind === "rejected") {
        note("approvals", "FRAME_REJECTED", "The host frame was rejected: " + outcome.reason);
        return outcome;
      }
      if (outcome.kind === "ignored") return outcome;
      return { kind: "recorded", entry: upsertApproval(outcome.entry) };
    },
    closeApproval: (requestId) => {
      const held = entries().find((entry) => entry.requestId === requestId);
      if (held === undefined || held.status !== "open") return false;
      setEntries((current) =>
        current.map((entry) => (entry.requestId === requestId ? { ...entry, status: "closed" } : entry)),
      );
      return true;
    },
    answerApproval: (requestId, decision) => {
      const gate = gateApprovalAnswer({
        requestId: requestId,
        decision: decision,
        entries: entries(),
        sessionID: deps.sessionID,
        connected: deps.respond !== undefined,
      });
      if (gate.kind === "refused") {
        note("approvals", gate.code, gate.message);
        return gate;
      }
      try {
        if (deps.respond !== undefined) deps.respond(requestId, { kind: "value", value: decision });
      } catch (error) {
        const message = "The answer to " + requestId + " was not written: " + describe(error);
        note("approvals", "WRITE_FAILED", message);
        return { kind: "refused", code: "WRITE_FAILED", message: message };
      }
      setEntries((current) =>
        current.map((entry) =>
          entry.requestId === requestId ? { ...entry, status: "answered", decision: decision } : entry,
        ),
      );
      return { kind: "answered", requestId: requestId, decision: decision };
    },
    actOnTask: (taskId, action) => {
      const gate = gateTaskAction({
        action: action,
        taskId: taskId,
        sessionID: deps.sessionID,
        snapshot: taskSnapshot(),
        connected: deps.sendTaskAction !== undefined,
      });
      if (gate.kind === "refused") {
        note("tasks", gate.code, gate.message);
        return gate;
      }
      try {
        if (deps.sendTaskAction !== undefined) deps.sendTaskAction({ kind: action, taskId: taskId });
      } catch (error) {
        const message = "The " + action + " request for " + taskId + " failed: " + describe(error);
        note("tasks", "WRITE_FAILED", message);
        return { kind: "refused", code: "WRITE_FAILED", message: message };
      }
      return gate;
    },
    actOnGoal: (action) => {
      const current = goalInput();
      const gate = gateGoalAction({
        action: action,
        goal: current ?? {
          source: "unsupported",
          detail: "The goal plugin has not answered for this session yet.",
        },
        connected: deps.sendGoalAction !== undefined,
      });
      if (gate.kind === "refused") {
        note("goal", gate.code, gate.message);
        return gate;
      }
      try {
        if (deps.sendGoalAction !== undefined) deps.sendGoalAction(action);
      } catch (error) {
        const message = "The /goal " + action + " command was not sent: " + describe(error);
        note("goal", "WRITE_FAILED", message);
        return { kind: "refused", code: "WRITE_FAILED", message: message };
      }
      return gate;
    },
    clearNotices: () => setNotices([]),
  };
}

/**
 * Feeds the approvals surface from the bridge's own host-dialog store: whatever is already held, then
 * every prompt the host opens and every id it closes. It reads only, so the dialogs feature keeps
 * owning the answer dialog; this surface only decides whether an answer may be written by this thread.
 */
export function connectBridgeApprovals(store: TasksStore, data: BridgeTuiData): () => void {
  for (const dialog of data.hostDialogs.list()) store.applyDialog(dialog);
  const stopOpen = data.onHostDialog((dialog) => {
    store.applyDialog(dialog);
  });
  const stopClose = data.hostDialogs.subscribe((change) => {
    if (change.kind === "closed") store.closeApproval(change.dialogId);
  });
  return () => {
    stopOpen();
    stopClose();
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
