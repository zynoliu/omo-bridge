import { For, Show, type ParentProps } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { ResolvedTheme } from "@opencode/theme/tui";
import { TodoItem } from "../../../component/todo-item";
import { useTheme } from "../../../context/theme";
import { GOAL_ACTIONS } from "./state.ts";
import type { ApprovalEntry, GoalSurface, TaskActivity, TaskRow, TodoSurface } from "./state.ts";
import type { TaskNotice, TasksStore } from "./store.ts";

export type TasksProps = {
  readonly store: TasksStore;
};

/**
 * The four subjects are drawn as four sections, never merged: subagent runs, the current branch's todo
 * list, the goal plugin's state, and the approvals this thread may answer. A subject the host has not
 * reported says so; a truncated snapshot says so beside its rows.
 */
export function Tasks(props: TasksProps) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0}>
      <Section title="Tasks and subagents">
        <Show when={reportedTasks(props.store.tasks())} fallback={<Hint text={unreportedTasks(props.store.tasks())} />}>
          {(activity) => (
            <box flexDirection="column" flexShrink={0}>
              <Show
                when={activity().rows.length > 0}
                fallback={<Hint text="The host reports no tasks in this snapshot." />}
              >
                <For each={activity().rows}>{(row) => <TaskRowView row={row} />}</For>
              </Show>
              <Show
                when={!activity().complete}
                fallback={<Hint text={activity().note} />}
              >
                <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingTop={1}>
                  <text fg={theme.text.feedback.warning.base} wrapMode="word">
                    {activity().note}
                  </text>
                </box>
              </Show>
              <Hint text={activity().order} />
            </box>
          )}
        </Show>
        <Notices notices={props.store.notices()} target="tasks" />
      </Section>

      <Section title="Todo (current branch)">
        <Show when={reportedTodos(props.store.todos())} fallback={<Hint text={unreportedTodos(props.store.todos())} />}>
          {(todos) => (
            <box flexDirection="column" flexShrink={0}>
              <For each={todos().todos}>{(todo) => <TodoItem theme={theme} todo={todo} />}</For>
              <Hint text={todos().note} />
            </box>
          )}
        </Show>
        <Show when={unreadableTodos(props.store.todos())}>
          {(todos) => <Failure text={"Todo state unreadable: " + todos().reason} />}
        </Show>
        <Notices notices={props.store.notices()} target="todo" />
      </Section>

      <Section title="Goal">
        <Show when={presentGoal(props.store.goal())}>
          {(goal) => (
            <box flexDirection="column" flexShrink={0}>
              <text fg={theme.text.base} wrapMode="word">
                {goal().objective}
              </text>
              <text fg={goalStatusFg(theme, goal())} wrapMode="none">
                {"◎ " + goal().statusLabel + " · round " + String(goal().rounds) + " of " + String(goal().maxRounds)}
              </text>
              <Show when={goal().reason}>
                {(reason) => (
                  <text fg={theme.text.muted} wrapMode="word">
                    {reason()}
                  </text>
                )}
              </Show>
              <Hint text={goal().note} />
            </box>
          )}
        </Show>
        <Show when={absentGoal(props.store.goal())}>
          {(goal) => <Hint text={goal().note} />}
        </Show>
        <Show when={unavailableGoal(props.store.goal())}>
          {(goal) => <Failure text={"Goal state is not reported here: " + goal().detail} />}
        </Show>
        <Show when={markerOf(props.store.goal())}>
          {(marker) => (
            <Hint text={"The host also reports " + marker() + ", a derived marker that carries no objective."} />
          )}
        </Show>
        <Hint text={"Writes: /goal " + GOAL_ACTIONS.join(", ") + ". /goal inspect is not a query."} />
        <Notices notices={props.store.notices()} target="goal" />
      </Section>

      <Section title="Approvals">
        <Show
          when={props.store.approvals().length > 0}
          fallback={<Hint text="The host has not asked this thread for any approval." />}
        >
          <For each={props.store.approvals()}>{(entry) => <ApprovalRowView entry={entry} />}</For>
        </Show>
        <Notices notices={props.store.notices()} target="approvals" />
      </Section>
    </box>
  );
}

function Section(props: ParentProps<{ readonly title: string }>) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
      {props.children}
    </box>
  );
}

function Hint(props: { readonly text: string }) {
  const theme = useTheme();
  return (
    <Show when={props.text.length > 0}>
      <box paddingLeft={1} flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="word">
          {props.text}
        </text>
      </box>
    </Show>
  );
}

function Failure(props: { readonly text: string }) {
  const theme = useTheme();
  return (
    <box paddingLeft={1} flexShrink={0}>
      <text fg={theme.text.feedback.error.base} wrapMode="word">
        {props.text}
      </text>
    </box>
  );
}

function TaskRowView(props: { readonly row: TaskRow }) {
  const theme = useTheme();
  const statusColor = () => {
    if (props.row.status === "failed") return theme.text.feedback.error.base;
    if (props.row.status === "running") return theme.text.feedback.success.base;
    return theme.text.muted;
  };
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={statusColor()}>{props.row.status}</text>
        <text fg={theme.text.base} wrapMode="word">
          {props.row.id}
        </text>
        <Show when={props.row.ownership === "another-session"}>
          <text fg={theme.text.feedback.warning.base}>another session</text>
        </Show>
      </box>
      <text fg={theme.text.muted} wrapMode="word">
        {props.row.description + (props.row.truncated ? " …(the host truncated this description)" : "")}
      </text>
      <Show when={props.row.error}>
        {(error) => (
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            {error() + (props.row.errorTruncated ? " …(truncated by the host)" : "")}
          </text>
        )}
      </Show>
    </box>
  );
}

function ApprovalRowView(props: { readonly entry: ApprovalEntry }) {
  const theme = useTheme();
  const originColor = () =>
    props.entry.origin === "another-session" ? theme.text.feedback.warning.base : theme.text.muted;
  const statusColor = () => {
    if (props.entry.status === "answered") return theme.text.feedback.success.base;
    if (props.entry.status === "closed") return theme.text.faint;
    return theme.text.base;
  };
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={statusColor()}>{props.entry.permission}</text>
        <text fg={originColor()}>{props.entry.origin}</text>
        <text fg={statusColor()}>
          {props.entry.status === "answered" ? "answered: " + (props.entry.decision ?? "") : props.entry.status}
        </text>
      </box>
      <Show when={props.entry.detail.length > 0}>
        <text fg={theme.text.muted} wrapMode="word">
          {props.entry.detail}
        </text>
      </Show>
      <text fg={theme.text.faint} wrapMode="word">
        {"options: " + props.entry.options.join(" / ")}
      </text>
    </box>
  );
}

function Notices(props: { readonly notices: readonly TaskNotice[]; readonly target: TaskNotice["target"] }) {
  const theme = useTheme();
  return (
    <For each={props.notices.filter((notice) => notice.target === props.target)}>
      {(notice) => (
        <box paddingLeft={1} flexShrink={0}>
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            {"Refused (" + notice.code + "): " + notice.message}
          </text>
        </box>
      )}
    </For>
  );
}

function reportedTasks(activity: TaskActivity) {
  if (activity.kind !== "reported") return undefined;
  return activity;
}

function unreportedTasks(activity: TaskActivity): string {
  return activity.kind === "not-reported" ? activity.reason : "";
}

function reportedTodos(todos: TodoSurface) {
  if (todos.kind !== "reported") return undefined;
  return todos;
}

function unreportedTodos(todos: TodoSurface): string {
  if (todos.kind === "no-branch") return todos.reason;
  if (todos.kind === "not-reported") return todos.reason;
  return "";
}

function unreadableTodos(todos: TodoSurface) {
  if (todos.kind !== "unreadable") return undefined;
  return todos;
}

function presentGoal(goal: GoalSurface) {
  if (goal.kind !== "present") return undefined;
  return goal;
}

function absentGoal(goal: GoalSurface) {
  if (goal.kind !== "absent") return undefined;
  return goal;
}

function unavailableGoal(goal: GoalSurface) {
  if (goal.kind !== "unavailable") return undefined;
  return goal;
}

function markerOf(goal: GoalSurface): string | undefined {
  return goal.marker ?? undefined;
}

function goalStatusFg(theme: ResolvedTheme, goal: GoalSurface) {
  if (goal.kind !== "present") return undefined;
  if (goal.status === "paused") return theme.text.feedback.warning.base;
  if (goal.status === "complete") return theme.text.feedback.success.base;
  return theme.text.muted;
}
