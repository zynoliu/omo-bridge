/**
 * The live host feed for the task surface.
 *
 * Field names come from the OmO task bridge: `omo.task.list` is handled with `{ parent_session_id }`
 * and answers `{ parent_session_id, tasks, truncated_tasks? }`, while `omo.task.updated` republishes the
 * same snapshot (upstream/oh-my-openagent/packages/omo-senpi/src/components/task/task-rpc-bridge.ts
 * and task-rpc-codec.ts). Each task carries `task_id`, `status`, `description` with an optional
 * `description_truncated`, and `error_message` with an optional `error_message_truncated`.
 *
 * A snapshot the decoder cannot verify is reported and never applied, so a malformed answer cannot
 * silently empty the surface.
 */
import type { BridgeData } from "../../../../../bridge-core/src/data.ts";
import { decodeHostExtensionFrame } from "../../../../../bridge-core/src/host-extension-frames.ts";
import type { HostTask, TaskSnapshot } from "./state.ts";
import type { TasksStore } from "./store.ts";

export type TaskSnapshotDecoded = { readonly ok: true; readonly snapshot: TaskSnapshot } | { readonly ok: false; readonly reason: string };

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function hostTask(value: unknown, parentSessionId: string): HostTask | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = text(field(value, "task_id"));
  const status = text(field(value, "status"));
  const description = text(field(value, "description"));
  if (id === undefined || status === undefined || description === undefined) return undefined;
  const errorMessage = text(field(value, "error_message"));
  return {
    id: id,
    parentSessionId: parentSessionId,
    status: status,
    description: description,
    descriptionTruncated: field(value, "description_truncated") === true,
    error: errorMessage === undefined ? null : errorMessage,
    errorTruncated: field(value, "error_message_truncated") === true,
  };
}

export function decodeTaskSnapshot(raw: unknown): TaskSnapshotDecoded {
  if (typeof raw !== "object" || raw === null) return { ok: false, reason: "the answer is not an object" };
  const parentSessionId = text(field(raw, "parent_session_id"));
  if (parentSessionId === undefined) return { ok: false, reason: "the answer has no parent_session_id" };
  const tasks = field(raw, "tasks");
  if (!Array.isArray(tasks)) return { ok: false, reason: "the answer has no tasks array" };
  const rows: HostTask[] = [];
  for (const item of tasks) {
    const parsed = hostTask(item, parentSessionId);
    if (parsed === undefined) return { ok: false, reason: "a task row is missing task_id, status or description" };
    rows.push(parsed);
  }
  const omitted = field(raw, "truncated_tasks");
  if (omitted !== undefined && (typeof omitted !== "number" || !Number.isInteger(omitted) || omitted < 0))
    return { ok: false, reason: "truncated_tasks is not a non-negative integer" };
  return { ok: true, snapshot: { parentSessionId: parentSessionId, tasks: rows, omitted: typeof omitted === "number" ? omitted : 0 } };
}

export type ConnectBridgeTasksOptions = {
  readonly sessionID: string;
  /** The answer the host wraps a snapshot in; the bridge unwraps `success`/`data` before decoding. */
  readonly onError?: (message: string) => void;
};

export function connectBridgeTasks(store: TasksStore, data: BridgeData, options: ConnectBridgeTasksOptions): () => void {
  const apply = (raw: unknown): void => {
    const decoded = decodeTaskSnapshot(raw);
    if (!decoded.ok) {
      options.onError?.("the host task snapshot was rejected: " + decoded.reason);
      return;
    }
    store.applyTaskSnapshot(decoded.snapshot);
  };

  /* The todo surface walks the branch the launcher pulled, so an abandoned branch's last todo never wins. */
  const applyBranch = (): void => {
    const branch = data.hostBranchFor(options.sessionID);
    if (branch === undefined) return;
    store.applyBranchSnapshot({
      leafId: branch.leafId,
      entries: branch.entries.map((entry) => ({
        id: entry.id,
        parentId: entry.parentId,
        customType: entry.customType,
        data: entry.data,
      })),
    });
  };
  applyBranch();
  const stopBranch = data.subscribe(applyBranch);

  const stop = data.subscribeEvents((frame) => {
    const decoded = decodeHostExtensionFrame(frame);
    if (!decoded.ok) return;
    if (decoded.frame.kind !== "extension_event") return;
    if (decoded.frame.name !== "omo.task.updated") return;
    apply(decoded.frame.data);
  });

  if (data.hasExtensionRequester()) {
    const id = "task-list-" + Date.now().toString(36);
    void data
      .requestExtension(id, { id: id, type: "extension_request", name: "omo.task.list", data: { parent_session_id: options.sessionID } })
      .then((answer) => {
        apply(unwrapAnswer(answer));
      })
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error));
      });
  }

  return () => {
    stop();
    stopBranch();
  };
}

/** A host answer is `{ id, success, data }`; the snapshot lives under `data`. */
function unwrapAnswer(answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null) return answer;
  const success = (answer as Record<string, unknown>)["success"];
  if (success === false) return answer;
  const payload = (answer as Record<string, unknown>)["data"];
  return payload === undefined ? answer : payload;
}
