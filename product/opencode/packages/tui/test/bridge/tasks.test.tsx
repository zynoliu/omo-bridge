import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { Goal } from "@opencode/schema/goal";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import type { HostResponseFrame } from "../../../bridge-core/src/host-frames.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";
import { ConfigProvider } from "../../src/config";
import { ThemeProvider } from "../../src/context/theme";
import {
  connectBridgeApprovals,
  createTasksStore,
  GOAL_ACTIONS,
  Tasks,
} from "../../src/bridge/features/tasks/index.ts";
import type {
  BranchSnapshot,
  TaskSnapshot,
  TasksStore,
  TasksStoreDeps,
} from "../../src/bridge/features/tasks/index.ts";
import { emptyThemeSource } from "../fixture/fixture";
import { TestTuiContexts } from "../fixture/tui-environment";
import { createTuiResolvedConfig } from "../fixture/tui-runtime";

type Mounted = Awaited<ReturnType<typeof testRender>>;

let mounted: Mounted | undefined;
const subscriptions: (() => void)[] = [];

afterEach(() => {
  mounted?.renderer.destroy();
  mounted = undefined;
  for (const stop of subscriptions.splice(0)) stop();
});

const SESSION = "session-thread-1";

type Host = {
  readonly data: BridgeData;
  readonly tui: ReturnType<typeof createBridgeTuiData>;
  readonly written: HostResponseFrame[];
};

function bridge(): Host {
  const data = new BridgeData();
  const tui = createBridgeTuiData({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace/bridge" },
    events: bridgeEvents(data),
  });
  const written: HostResponseFrame[] = [];
  tui.hostDialogs.useSender((frame) => {
    written.push(frame);
  });
  return { data: data, tui: tui, written: written };
}

type StoreInput = {
  readonly sessionID?: string | null;
  readonly respond?: TasksStoreDeps["respond"];
  readonly sendTaskAction?: TasksStoreDeps["sendTaskAction"];
  readonly sendGoalAction?: TasksStoreDeps["sendGoalAction"];
};

function openStore(host: Host, input: StoreInput = {}): TasksStore {
  const deps: TasksStoreDeps = {
    sessionID: input.sessionID === undefined ? SESSION : input.sessionID,
    ...(input.respond === undefined ? {} : { respond: input.respond }),
    ...(input.sendTaskAction === undefined ? {} : { sendTaskAction: input.sendTaskAction }),
    ...(input.sendGoalAction === undefined ? {} : { sendGoalAction: input.sendGoalAction }),
  };
  const store = createTasksStore(deps);
  subscriptions.push(connectBridgeApprovals(store, host.tui));
  return store;
}

async function mount(store: TasksStore, height = 70) {
  mounted?.renderer.destroy();
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Tasks store={store} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 110, height: height },
  );
  mounted = app;
  await app.renderOnce();
  await app.renderOnce();
  return app;
}

function tasksSnapshot(rows: TaskSnapshot["tasks"], omitted: number): TaskSnapshot {
  return { parentSessionId: SESSION, tasks: rows, omitted: omitted };
}

function permissionFrame(input: {
  readonly id: string;
  readonly permission: string;
  readonly detail: string;
  readonly options: readonly string[];
  readonly sessionId?: string;
}): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id: input.id,
    method: "select",
    title: "Permission required: " + input.permission + "\n\n" + input.detail,
    options: input.options,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
  };
}

function goalState(): Goal.State {
  return {
    id: "goal-1",
    objective: "Ship the task, todo and goal surfaces",
    status: "active",
    rounds: 2,
    maxRounds: 8,
    boot: "boot-1",
    updatedAt: 1_700_400_000_000,
  };
}

describe("bridge tasks, todo, goal and approvals", () => {
  test("a task event updates the task section and leaves the other three surfaces untouched", async () => {
    const host = bridge();
    const store = openStore(host);

    store.applyTaskSnapshot(
      tasksSnapshot(
        [
          {
            id: "task-a",
            parentSessionId: SESSION,
            status: "running",
            description: "Read the bridge plan",
            descriptionTruncated: false,
            error: null,
            errorTruncated: false,
          },
        ],
        0,
      ),
    );
    const branch: BranchSnapshot = {
      leafId: "entry-leaf",
      entries: [
        {
          id: "entry-root",
          parentId: null,
          customType: "senpi.todo-state",
          data: [{ content: "branch todo row", status: "in_progress" }],
        },
        { id: "entry-root-child", parentId: "entry-root", customType: null, data: null },
        {
          id: "entry-abandoned",
          parentId: "entry-root-child",
          customType: "senpi.todo-state",
          data: [{ content: "abandoned branch row", status: "pending" }],
        },
        { id: "entry-leaf", parentId: "entry-root-child", customType: null, data: null },
      ],
    };
    store.applyBranchSnapshot(branch);
    store.applyGoal({ source: "goal-plugin", state: goalState() });
    host.data.publishEvent(
      permissionFrame({
        id: "ui-perm-1",
        permission: "write",
        detail: "Path: /workspace/bridge/notes.md",
        options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
        sessionId: SESSION,
      }),
    );

    expect(store.approvals()).toHaveLength(1);
    const todosBefore = JSON.stringify(store.todos());
    const goalBefore = JSON.stringify(store.goal());
    const approvalsBefore = JSON.stringify(store.approvals());
    const tasksBefore = JSON.stringify(store.tasks());

    store.applyTaskSnapshot(
      tasksSnapshot(
        [
          {
            id: "task-a",
            parentSessionId: SESSION,
            status: "completed",
            description: "Read the bridge plan",
            descriptionTruncated: false,
            error: null,
            errorTruncated: false,
          },
          {
            id: "task-b",
            parentSessionId: SESSION,
            status: "running",
            description: "Project the todo list",
            descriptionTruncated: false,
            error: null,
            errorTruncated: false,
          },
        ],
        0,
      ),
    );

    expect(JSON.stringify(store.tasks())).not.toBe(tasksBefore);
    expect(JSON.stringify(store.todos())).toBe(todosBefore);
    expect(JSON.stringify(store.goal())).toBe(goalBefore);
    expect(JSON.stringify(store.approvals())).toBe(approvalsBefore);

    const todos = store.todos();
    if (todos.kind !== "reported") throw new Error("expected the todo surface to be reported");
    expect(todos.todos.map((item) => item.content)).toEqual(["branch todo row"]);
    expect(todos.elsewhere).toBe(1);
    expect(todos.note).toContain("other branches are ignored");

    const app = await mount(store);
    const frame = app.captureCharFrame();
    expect(frame).toContain("Tasks and subagents");
    expect(frame).toContain("Todo (current branch)");
    expect(frame).toContain("branch todo row");
    expect(frame).not.toContain("abandoned branch row");
    expect(frame).toContain("Project the todo list");
  });

  test("a truncated task snapshot is shown as truncated, never as complete data", async () => {
    const host = bridge();
    const store = openStore(host);
    store.applyTaskSnapshot(
      tasksSnapshot(
        [
          {
            id: "task-visible",
            parentSessionId: SESSION,
            status: "running",
            description: "Only the tail of the store is here",
            descriptionTruncated: true,
            error: null,
            errorTruncated: false,
          },
        ],
        3,
      ),
    );

    const activity = store.tasks();
    if (activity.kind !== "reported") throw new Error("expected the task surface to be reported");
    expect(activity.complete).toBe(false);
    expect(activity.omitted).toBe(3);
    expect(activity.note).toContain("3 task(s) are missing");
    expect(activity.note).toContain("not complete");

    const app = await mount(store);
    const frame = app.captureCharFrame();
    expect(frame).toContain("3 task(s) are missing");
    expect(frame).toContain("not complete");
    expect(frame).toContain("the host truncated this description");
    expect(frame).not.toContain("reported this snapshot as complete");
  });

  test("an action on another session's task or approval is refused and nothing is written", async () => {
    const host = bridge();
    const display = openStore(host);
    const sent: string[] = [];
    const guarded = openStore(host, {
      respond: (requestId, answer) => {
        host.tui.respondToHostDialog(requestId, answer);
      },
      sendTaskAction: (action) => {
        sent.push(action.taskId);
      },
    });

    guarded.applyTaskSnapshot(
      tasksSnapshot(
        [
          {
            id: "task-other",
            parentSessionId: "session-parent-9",
            status: "running",
            description: "Owned by the parent session",
            descriptionTruncated: false,
            error: null,
            errorTruncated: false,
          },
        ],
        0,
      ),
    );

    const refusedTask = guarded.actOnTask("task-other", "cancel");
    expect(refusedTask.kind).toBe("refused");
    if (refusedTask.kind === "refused") {
      expect(refusedTask.code).toBe("PARENT_SESSION_REQUIRED");
      expect(refusedTask.message).toContain("needs that parent session's own approval");
    }
    expect(sent).toEqual([]);
    expect(guarded.notices().map((notice) => notice.code)).toContain("PARENT_SESSION_REQUIRED");

    host.data.publishEvent(
      permissionFrame({
        id: "ui-perm-other",
        permission: "bash",
        detail: "Command: rm -rf build",
        options: ["Allow once", "Deny"],
        sessionId: "session-parent-9",
      }),
    );
    const foreign = display.approvals();
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.origin).toBe("another-session");
    expect(foreign[0]?.toolCallId).toBeNull();

    const refusedApproval = guarded.answerApproval("ui-perm-other", "Allow once");
    expect(refusedApproval.kind).toBe("refused");
    if (refusedApproval.kind === "refused") expect(refusedApproval.code).toBe("CROSS_SESSION_APPROVAL");
    expect(host.written).toEqual([]);

    host.data.publishEvent(
      permissionFrame({
        id: "ui-perm-own",
        permission: "read",
        detail: "Path: /workspace/bridge/notes.md",
        options: ["Allow once", "Deny"],
        sessionId: SESSION,
      }),
    );
    const answered = guarded.answerApproval("ui-perm-own", "Allow once");
    expect(answered.kind).toBe("answered");
    expect(host.written).toHaveLength(1);
    expect(host.written[0]?.type).toBe("extension_ui_response");

    const app = await mount(guarded);
    const frame = app.captureCharFrame();
    expect(frame).toContain("another-session");
    expect(frame).toContain("Refused (CROSS_SESSION_APPROVAL)");
    expect(frame).toContain("needs that parent session's own approval");
  });

  test("the goal section renders the goal plugin's state and never a derived marker as the goal", async () => {
    const host = bridge();
    const wired = openStore(host);
    const commands: string[] = [];
    const withCommands = openStore(host, {
      sendGoalAction: (action) => {
        commands.push(action);
      },
    });

    withCommands.applyGoal({ source: "goal-plugin", state: goalState() });
    const present = withCommands.goal();
    if (present.kind !== "present") throw new Error("expected a present goal");
    expect(present.objective).toBe("Ship the task, todo and goal surfaces");
    expect(present.rounds).toBe(2);

    const app = await mount(withCommands);
    const frame = app.captureCharFrame();
    expect(frame).toContain("Ship the task, todo and goal surfaces");
    expect(frame).toContain("◎ goal · round 2 of 8");

    withCommands.applyGoalMarker("goal_paused");
    const marked = withCommands.goal();
    if (marked.kind !== "present") throw new Error("expected the goal to stay present");
    expect(marked.marker).toBe("goal_paused");
    expect(marked.note).toContain("a derived marker with no objective");

    wired.applyGoalMarker("goal_paused");
    wired.applyGoal({ source: "unsupported", detail: "the bridge client has no goal rpc surface" });
    const unavailable = wired.goal();
    expect(unavailable.kind).toBe("unavailable");
    const refused = wired.actOnGoal("pause");
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") {
      expect(refused.code).toBe("GOAL_RPC_UNAVAILABLE");
      expect(refused.message).toContain("/goal inspect is not used as a read");
    }
    expect(commands).toEqual([]);
    expect(wired.notices().map((notice) => notice.code)).toContain("GOAL_RPC_UNAVAILABLE");
    expect(GOAL_ACTIONS).not.toContain("inspect");

    const secondApp = await mount(wired);
    const secondFrame = secondApp.captureCharFrame();
    expect(secondFrame).toContain("Goal state is not reported here");
    expect(secondFrame).toContain("derived marker that carries no objective");
    expect(secondFrame).not.toContain("Ship the task, todo and goal surfaces");
  });
});
