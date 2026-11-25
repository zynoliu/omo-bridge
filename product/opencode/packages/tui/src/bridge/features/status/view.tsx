import { For, Show, type ParentProps } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import type { ResolvedTheme } from "@opencode/theme/tui";
import { useTheme } from "../../../context/theme";
import {
  HIDDEN_NOTE,
  MEMORY_CHANNEL_NOTE,
  NOTIFY_LEVELS,
  WIDGET_FACTORY_KEYS,
  WIDGET_NOTE,
  compactLayout,
  statusColumnWidth,
} from "./state.ts";
import type {
  MemorySurface,
  MemoryWriteOutcome,
  NotificationEntry,
  NotificationsView,
  ReportedField,
  StatusEntry,
  TeamMemberRow,
  TeamSurface,
  TurnLiveness,
  WidgetEntry,
  WidgetSurface,
} from "./state.ts";
import type { StatusStore } from "./store.ts";

export type StatusProps = {
  readonly store: StatusStore;
  /** Columns the parent offers the right column; the host's 32–80 clamp applies. */
  readonly available?: number;
};

/**
 * The right column: memory, team, status entries, widgets and notifications for one session. A
 * subject the host has not reported says so; nothing is filled in to make a section look complete.
 */
export function Status(props: StatusProps) {
  const dimensions = useTerminalDimensions();
  const compact = () => compactLayout(dimensions().width);
  const width = () => (props.available === undefined ? undefined : statusColumnWidth(props.available));
  return (
    <box flexDirection="column" flexShrink={0} width={width()}>
      <MemorySection memory={props.store.memory()} compact={compact()} />
      <TeamSection team={props.store.team()} turn={props.store.turnLiveness()} />
      <StatusSection entries={props.store.statuses()} ignored={props.store.otherSessionFrames()} />
      <WidgetsSection surface={props.store.widgets()} />
      <NotificationsSection notifications={props.store.notifications()} />
      <WriteSection store={props.store} />
      <NoticesSection store={props.store} />
    </box>
  );
}

function Section(props: ParentProps<{ readonly title: string; readonly summary?: string }>) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <Show when={props.summary}>
          {(summary) => <text fg={theme.text.muted}>{summary()}</text>}
        </Show>
      </box>
      {props.children}
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

function Success(props: { readonly text: string }) {
  const theme = useTheme();
  return (
    <box paddingLeft={1} flexShrink={0}>
      <text fg={theme.text.feedback.success.base} wrapMode="word">
        {props.text}
      </text>
    </box>
  );
}

function FieldRow(props: { readonly field: ReportedField }) {
  const theme = useTheme();
  const valueColor = () => (props.field.reported ? theme.text.base : theme.text.faint);
  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={1} gap={1}>
      <text fg={theme.text.muted}>{props.field.label}</text>
      <text fg={valueColor()} wrapMode="word">
        {props.field.text}
      </text>
    </box>
  );
}

function MemorySection(props: { readonly memory: MemorySurface; readonly compact: boolean }) {
  const theme = useTheme();
  return (
    <Section title="Memory">
      <Show when={notReportedMemory(props.memory)}>
        {(surface) => <Hint text={surface().reason} />}
      </Show>
      <Show when={unavailableMemory(props.memory)}>
        {(surface) => <Failure text={"Memory status is unavailable: " + surface().reason} />}
      </Show>
      <Show when={unsupportedMemory(props.memory)}>
        {(surface) => (
          <Failure
            text={"Memory schema " + surface().schemaVersion + " is not one this surface reads: " + surface().reason}
          />
        )}
      </Show>
      <Show when={reportedMemory(props.memory)}>
        {(surface) => (
          <box flexDirection="column" flexShrink={0}>
            <Show
              when={!props.compact}
              fallback={
                <box flexDirection="column" flexShrink={0}>
                  <For each={surface().fields.filter((field) => field.reported)}>
                    {(field) => <FieldRow field={field} />}
                  </For>
                  <box paddingLeft={1} flexShrink={0}>
                    <text fg={theme.text.faint} wrapMode="word">
                      {"not reported: " + unreportedLabels(surface().fields).join(", ")}
                    </text>
                  </box>
                </box>
              }
            >
              <For each={surface().fields}>{(field) => <FieldRow field={field} />}</For>
            </Show>
            <Hint text={surface().note} />
            <Hint text={MEMORY_CHANNEL_NOTE} />
          </box>
        )}
      </Show>
    </Section>
  );
}

function TeamSection(props: { readonly team: TeamSurface; readonly turn: TurnLiveness | null }) {
  const theme = useTheme();
  return (
    <Section title="Team">
      <Show when={notReportedTeam(props.team)}>
        {(surface) => <Hint text={surface().reason} />}
      </Show>
      <Show when={reportedTeam(props.team)}>
        {(surface) => (
          <box flexDirection="column" flexShrink={0}>
            <For each={surface().rows}>{(row) => <MemberRowView row={row} />}</For>
            <Hint text={surface().note} />
          </box>
        )}
      </Show>
      <Show when={props.turn}>
        {(turn) => (
          <box paddingLeft={1} flexShrink={0}>
            <text fg={theme.text.muted} wrapMode="word">
              {"turn end: " + turn().verdict + (turn().reason === null ? "" : " · " + turn().reason)}
            </text>
          </box>
        )}
      </Show>
    </Section>
  );
}

function MemberRowView(props: { readonly row: TeamMemberRow }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text fg={props.row.killed ? theme.text.feedback.warning.base : theme.text.feedback.error.base}>
          {props.row.lastKnownState}
        </text>
        <text fg={theme.text.base} wrapMode="word">
          {props.row.memberName}
        </text>
        <Show when={props.row.killed}>
          <text fg={theme.text.feedback.warning.base}>killed</text>
        </Show>
      </box>
      <Show when={props.row.reason}>
        {(reason) => (
          <text fg={theme.text.muted} wrapMode="word">
            {reason()}
          </text>
        )}
      </Show>
    </box>
  );
}

function StatusSection(props: { readonly entries: readonly StatusEntry[]; readonly ignored: number }) {
  const theme = useTheme();
  return (
    <Section title="Status">
      <Show when={props.entries.length > 0} fallback={<Hint text="The host has sent no setStatus entry." />}>
        <For each={props.entries}>{(entry) => <StatusEntryView entry={entry} />}</For>
      </Show>
      <Show when={props.ignored > 0}>
        <box paddingLeft={1} flexShrink={0}>
          <text fg={theme.text.muted} wrapMode="word">
            {String(props.ignored) + " frame(s) routed to another session were ignored here."}
          </text>
        </box>
      </Show>
    </Section>
  );
}

function StatusEntryView(props: { readonly entry: StatusEntry }) {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={1} gap={1}>
      <text fg={theme.text.muted}>{props.entry.key}</text>
      <text fg={props.entry.text === null ? theme.text.faint : theme.text.base} wrapMode="word">
        {props.entry.text === null ? "cleared by the host" : props.entry.text}
      </text>
    </box>
  );
}

function WidgetsSection(props: { readonly surface: WidgetSurface }) {
  return (
    <Section title="Widgets">
      <Show when={notReportedWidgets(props.surface)}>
        {(surface) => <Hint text={surface().reason} />}
      </Show>
      <Show when={reportedWidgets(props.surface)}>
        {(surface) => (
          <box flexDirection="column" flexShrink={0}>
            <For each={surface().entries}>{(entry) => <WidgetView entry={entry} />}</For>
            <Hint text={surface().note} />
          </box>
        )}
      </Show>
      <For each={WIDGET_FACTORY_KEYS}>
        {(declaration) => <Hint text={declaration.key + ": " + declaration.note + "; no rows can arrive for this key."} />}
      </For>
      <Hint text={WIDGET_NOTE} />
    </Section>
  );
}

function WidgetView(props: { readonly entry: WidgetEntry }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingTop={0}>
      <text fg={theme.text.base}>{props.entry.key + " (" + (props.entry.placement ?? "placement not reported") + ")"}</text>
      <Show when={!props.entry.cleared && props.entry.lines.length > 0}>
        <For each={props.entry.lines}>
          {(line) => (
            <text fg={theme.text.base} wrapMode="word">
              {line}
            </text>
          )}
        </For>
      </Show>
      <Show when={!props.entry.cleared && props.entry.lines.length === 0}>
        <text fg={theme.text.muted} wrapMode="word">
          The host set this widget with 0 rows; this surface draws no row it was not sent.
        </text>
      </Show>
      <Show when={props.entry.cleared}>
        <text fg={theme.text.faint} wrapMode="word">
          The host cleared this widget; it has no rows.
        </text>
      </Show>
      <Show when={props.entry.actions.length > 0}>
        <For each={props.entry.actions}>
          {(action) => (
            <text fg={theme.text.muted} wrapMode="word">
              {"action " + action.label + " → " + action.command}
            </text>
          )}
        </For>
      </Show>
    </box>
  );
}

function NotificationsSection(props: { readonly notifications: NotificationsView }) {
  const theme = useTheme();
  return (
    <Section
      title="Notifications"
      summary={props.notifications.hidden.length > 0 ? String(props.notifications.hidden.length) + " hidden" : undefined}
    >
      <Show
        when={props.notifications.visible.length > 0}
        fallback={<Hint text="No visible notification is held for this session." />}
      >
        <For each={props.notifications.visible}>{(entry) => <NotificationRowView entry={entry} />}</For>
      </Show>
      <Show when={props.notifications.hidden.length > 0}>
        <box paddingLeft={1} flexShrink={0}>
          <text fg={theme.text.faint} wrapMode="word">
            {String(props.notifications.hidden.length) +
              " notification(s) " +
              HIDDEN_NOTE +
              ": " +
              hiddenSources(props.notifications.hidden) +
              ". Their content is not drawn."}
          </text>
        </box>
      </Show>
      <Hint text={props.notifications.note} />
      <Hint text={"Known levels: " + NOTIFY_LEVELS.join(", ") + "; any other level is shown as the host sent it."} />
    </Section>
  );
}

function NotificationRowView(props: { readonly entry: NotificationEntry }) {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0} paddingLeft={1} gap={1}>
      <text fg={levelColor(theme, props.entry.level)}>{props.entry.level}</text>
      <text fg={theme.text.base} wrapMode="word">
        {props.entry.message}
      </text>
    </box>
  );
}

function levelColor(theme: ResolvedTheme, level: string) {
  if (level === "error") return theme.text.feedback.error.base;
  if (level === "warning") return theme.text.feedback.warning.base;
  if (level === "info") return theme.text.feedback.info.base;
  return theme.text.muted;
}

function hiddenSources(hidden: readonly NotificationEntry[]): string {
  const sources: string[] = [];
  for (const entry of hidden) {
    if (!sources.includes(entry.source)) sources.push(entry.source);
  }
  return sources.join(", ");
}

function WriteSection(props: { readonly store: StatusStore }) {
  const theme = useTheme();
  return (
    <Section title="Memory write">
      <Show when={props.store.pendingWrite()} fallback={<Hint text="No memory write is pending authorization." />}>
        {(plan) => (
          <box flexDirection="column" flexShrink={0} paddingLeft={1}>
            <text fg={theme.text.base} wrapMode="word">
              {"Pending: omo.memory.facts.apply · batch " + (plan().request.batchId ?? "not reported") + " · " + String(plan().request.records.length) + " record(s)"}
            </text>
            <text fg={theme.text.muted} wrapMode="word">
              Exact content that authorization writes:
            </text>
            <text fg={theme.text.base} wrapMode="word">
              {plan().content}
            </text>
            <text fg={theme.text.feedback.warning.base} wrapMode="word">
              Not sent. Authorizing writes exactly this content to the memory repository.
            </text>
          </box>
        )}
      </Show>
      <Show when={committedWrite(props.store.writeOutcome())}>
        {(committed) => (
          <Success
            text={
              "Memory write committed " +
              committed().sha +
              " · " +
              String(committed().affectedPaths.length) +
              " path(s)"
            }
          />
        )}
      </Show>
      <Show when={emptyWrite(props.store.writeOutcome())}>
        <Hint text="The host answered no_facts: nothing was written." />
      </Show>
    </Section>
  );
}

function NoticesSection(props: { readonly store: StatusStore }) {
  return (
    <Section title="Refusals">
      <Show
        when={props.store.notices().length > 0}
        fallback={<Hint text="No refusal or rejected frame is held for this session." />}
      >
        <For each={props.store.notices()}>
          {(notice) => <Failure text={"Refused (" + notice.code + "): " + notice.message} />}
        </For>
      </Show>
    </Section>
  );
}

function notReportedMemory(memory: MemorySurface) {
  return memory.kind === "not-reported" ? memory : undefined;
}

function unreportedLabels(fields: readonly ReportedField[]): readonly string[] {
  return fields.filter((field) => !field.reported).map((field) => field.label);
}

function unavailableMemory(memory: MemorySurface) {
  return memory.kind === "unavailable" ? memory : undefined;
}

function unsupportedMemory(memory: MemorySurface) {
  return memory.kind === "unsupported" ? memory : undefined;
}

function reportedMemory(memory: MemorySurface) {
  return memory.kind === "reported" ? memory : undefined;
}

function notReportedTeam(team: TeamSurface) {
  return team.kind === "not-reported" ? team : undefined;
}

function reportedTeam(team: TeamSurface) {
  return team.kind === "reported" ? team : undefined;
}

function notReportedWidgets(surface: WidgetSurface) {
  return surface.kind === "not-reported" ? surface : undefined;
}

function reportedWidgets(surface: WidgetSurface) {
  return surface.kind === "reported" ? surface : undefined;
}

function committedWrite(outcome: MemoryWriteOutcome | null) {
  if (outcome === null || outcome.kind !== "committed") return undefined;
  return outcome;
}

function emptyWrite(outcome: MemoryWriteOutcome | null) {
  if (outcome === null || outcome.kind !== "no-facts") return undefined;
  return outcome;
}
