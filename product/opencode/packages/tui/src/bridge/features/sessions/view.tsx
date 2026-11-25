import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { SessionRegistry } from "../../../../../bridge-core/src/sessions.ts";
import type { BridgeTuiData } from "../../../context/bridge-data.ts";
import { useTheme } from "../../../context/theme";
import { createSessionsStore } from "./store.ts";
import type { SessionsStore } from "./store.ts";
import type { ReopenSuccess, SessionHistory, SessionRow, SessionTreeNode } from "./state.ts";

export type SessionsProps = {
  readonly data: BridgeTuiData;
  readonly sessions: SessionRegistry;
  readonly revision?: () => unknown;
  readonly store?: SessionsStore;
  /* Called after a reopen succeeds, so the host can route to the session whose history was restored. */
  readonly onOpen?: (session: ReopenSuccess) => void;
};

export function Sessions(props: SessionsProps) {
  const theme = useTheme();
  const store = props.store ?? createSessionsStore(props);
  useKeyboard((key) => {
    if (key.name === "up") {
      key.preventDefault();
      store.move(-1);
      return;
    }
    if (key.name === "down") {
      key.preventDefault();
      store.move(1);
      return;
    }
    if (key.name === "escape") {
      if (store.failure() === null) return;
      key.preventDefault();
      store.clearFailure();
      return;
    }
    if (key.name !== "return" && key.name !== "enter") return;
    const selected = store.selectedId();
    if (selected === null) return;
    key.preventDefault();
    const outcome = store.reopen(selected);
    if (outcome.kind === "reopened") props.onOpen?.(outcome);
  });
  return (
    <box flexDirection="column" flexShrink={0}>
      <SectionTitle title="Sessions" />
      <Hint text="↑/↓ selects · enter reopens the recorded history · esc dismisses a refusal" />
      <Show when={store.rows().length > 0} fallback={<Hint text="No sessions are held by the bridge." />}>
        <For each={store.rows()}>{(row) => <SessionRowView row={row} />}</For>
      </Show>
      <SectionTitle title="Tree" />
      <Show when={store.tree()} fallback={<Hint text="Select a session to see its tree." />}>
        {(tree) => (
          <box flexDirection="column" flexShrink={0}>
            <For each={tree().nodes}>{(node) => <TreeRowView node={node} />}</For>
            <Hint text={tree().note} />
          </box>
        )}
      </Show>
      <SectionTitle title="Recorded history" />
      <Show
        when={store.recordedHistory().length > 0}
        fallback={<Hint text="The bridge was not given history for any session." />}
      >
        <For each={store.recordedHistory()}>{(history) => <HistoryBlock history={history} />}</For>
      </Show>
      <Show when={store.placement()}>
        {(placement) => (
          <box flexDirection="column" flexShrink={0} marginTop={1}>
            <text fg={theme.text.muted}>Opened in {placement().directory}</text>
            <text fg={theme.text.muted}>{placement().note}</text>
          </box>
        )}
      </Show>
      <Show when={store.failure()}>
        {(failure) => (
          <box paddingTop={1} flexShrink={0}>
            <text fg={theme.text.feedback.error.base}>
              Reopen refused ({failure().code}) for {failure().persistentId}
            </text>
          </box>
        )}
      </Show>
      <Show when={store.reopened()}>
        {(reopened) => <Hint text={"Reopened " + reopened().persistentId + " as " + reopened().handle} />}
      </Show>
    </box>
  );
}

function SectionTitle(props: { readonly title: string }) {
  const theme = useTheme();
  return (
    <box paddingTop={1} flexShrink={0}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
        {props.title}
      </text>
    </box>
  );
}

function SessionRowView(props: { readonly row: SessionRow }) {
  const theme = useTheme();
  const marker = () => (props.row.selected ? "› " : "  ");
  const details = () => {
    if (props.row.state === "parked" || props.row.state === "closed") return props.row.status + " · " + props.row.state;
    return props.row.status;
  };
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={props.row.selected ? theme.text.action.primary.focused : theme.text.muted}>{marker()}</text>
      <text fg={theme.text.base}>{props.row.title}</text>
      <text fg={props.row.status === "running" ? theme.text.feedback.success.base : theme.text.muted}>
        {"  " + details()}
      </text>
    </box>
  );
}

function TreeRowView(props: { readonly node: SessionTreeNode }) {
  const theme = useTheme();
  const prefix = () => (props.node.depth === 0 ? "" : "  ".repeat(props.node.depth) + "└ ");
  return (
    <box paddingLeft={1} flexShrink={0}>
      <text fg={props.node.parentId === null ? theme.text.base : theme.text.muted}>
        {prefix() + props.node.title}
      </text>
    </box>
  );
}

function HistoryBlock(props: { readonly history: SessionHistory }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <text fg={theme.text.base}>{props.history.persistentId}</text>
      <For each={props.history.entries}>
        {(entry) => (
          <box paddingLeft={2} flexShrink={0}>
            <text fg={theme.text.muted} wrapMode="word">
              {entry}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

function Hint(props: { readonly text: string }) {
  const theme = useTheme();
  return (
    <box paddingLeft={1} flexShrink={0}>
      <text fg={theme.text.muted} wrapMode="word">
        {props.text}
      </text>
    </box>
  );
}
