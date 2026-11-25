import { describe, expect, test } from "bun:test";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { createExtensionRequester } from "../../../bridge-core/src/extension-request.ts";
import { connectBridgeTasks, decodeTaskSnapshot } from "../../src/bridge/features/tasks/connect.ts";
import { createTasksStore } from "../../src/bridge/features/tasks/store.ts";

const SESSION = "sess_parent";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    parent_session_id: SESSION,
    tasks: [
      {
        task_id: "st_1",
        status: "running",
        description: "probe the host",
        description_truncated: true,
        error_message: "boom",
        error_message_truncated: true,
      },
    ],
    truncated_tasks: 2,
    ...overrides,
  };
}

function store() {
  return createTasksStore({ sessionID: SESSION });
}

describe("task snapshot decoding", () => {
  test("the documented snapshot fields become the host task rows", () => {
    const decoded = decodeTaskSnapshot(snapshot());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.snapshot.parentSessionId).toBe(SESSION);
    expect(decoded.snapshot.omitted).toBe(2);
    expect(decoded.snapshot.tasks[0]).toEqual({
      id: "st_1",
      parentSessionId: SESSION,
      status: "running",
      description: "probe the host",
      descriptionTruncated: true,
      error: "boom",
      errorTruncated: true,
    });
  });

  test("a row without a known id or status is rejected instead of dropped silently", () => {
    const decoded = decodeTaskSnapshot({ parent_session_id: SESSION, tasks: [{ description: "x" }] });
    expect(decoded.ok).toBe(false);
  });

  test("a negative truncation count is rejected", () => {
    expect(decodeTaskSnapshot(snapshot({ truncated_tasks: -1 })).ok).toBe(false);
  });
});

describe("todo surface from the pulled branch", () => {
  test("the current branch's todo wins and an abandoned branch is ignored", () => {
    const data = new BridgeData();
    const tasks = store();
    data.setHostBranch(SESSION, {
      leafId: "e3",
      entries: [
        { id: "e0", parentId: null, customType: null, data: {} },
        {
          id: "e1",
          parentId: "e0",
          customType: "senpi.todo-state",
          data: [{ content: "on the branch", status: "pending" }],
        },
        {
          id: "e2",
          parentId: "e0",
          customType: "senpi.todo-state",
          data: [{ content: "abandoned branch", status: "completed" }],
        },
        { id: "e3", parentId: "e1", customType: null, data: {} },
      ],
    });
    const stop = connectBridgeTasks(tasks, data, { sessionID: SESSION });
    const todo = tasks.todos();
    stop();
    expect(todo.kind).toBe("reported");
    if (todo.kind !== "reported") return;
    expect(todo.todos.map((entry) => entry.content)).toEqual(["on the branch"]);
  });
});

describe("task surface live feed", () => {
  test("the surface asks the host for its snapshot with the parent session id", () => {
    const written: unknown[] = [];
    const data = new BridgeData();
    data.setExtensionRequester(createExtensionRequester({ write: (frame) => written.push(frame) }));
    const stop = connectBridgeTasks(store(), data, { sessionID: SESSION });
    expect(written).toHaveLength(1);
    const frame = written[0];
    if (typeof frame !== "object" || frame === null) throw new Error("no frame");
    expect((frame as Record<string, unknown>)["name"]).toBe("omo.task.list");
    const payload = (frame as Record<string, unknown>)["data"];
    expect(payload).toEqual({ parent_session_id: SESSION });
    stop();
  });

  test("a pushed omo.task.updated event updates the task surface", () => {
    const data = new BridgeData();
    const tasks = store();
    const stop = connectBridgeTasks(tasks, data, { sessionID: SESSION });
    data.publishEvent({ type: "extension_event", name: "omo.task.updated", data: snapshot() });
    const activity = tasks.tasks();
    expect(activity.kind).toBe("reported");
    expect(activity.kind === "reported" ? activity.rows.map((row) => row.id) : []).toEqual(["st_1"]);
    stop();
  });

  test("a rejected snapshot is reported and leaves the surface untouched", () => {
    const data = new BridgeData();
    const tasks = store();
    const errors: string[] = [];
    const stop = connectBridgeTasks(tasks, data, { sessionID: SESSION, onError: (message) => errors.push(message) });
    data.publishEvent({ type: "extension_event", name: "omo.task.updated", data: { parent_session_id: SESSION, tasks: [{ description: "x" }] } });
    expect(errors.length).toBe(1);
    expect(tasks.tasks().kind).toBe("not-reported");
    stop();
  });
});
