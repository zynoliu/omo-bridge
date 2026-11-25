import { For, Show, onCleanup } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { BoxRenderable, KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core";
import type { HostDialogRequestFrame } from "../../../../../bridge-core/src/dialogs-host.ts";
import type { QuestionRequestFrame } from "../../../../../bridge-core/src/host-frames.ts";
import type { BridgeTuiData } from "../../../context/bridge-data.ts";
import { useTheme } from "../../../context/theme";
import { createDialogsStore } from "./store.ts";
import type { DialogsStore } from "./store.ts";
import {
  confirmEntry,
  editorEntry,
  entryTitleLines,
  inputEntry,
  questionEntry,
  secretMask,
  selectEntry,
  textLines,
} from "./state.ts";
import type {
  ConfirmDialogEntry,
  DialogEntry,
  EditorDialogEntry,
  InputDialogEntry,
  QuestionDialogEntry,
  SelectDialogEntry,
  TextDialogEntry,
} from "./state.ts";

export type DialogsProps = {
  readonly data: BridgeTuiData;
  readonly store?: DialogsStore;
};

export function Dialogs(props: DialogsProps) {
  const theme = useTheme();
  const store = props.store ?? createDialogsStore({ data: props.data });
  useKeyboard((key) => {
    const first = store.live()[0];
    if (first === undefined) return;
    const selected = selectEntry(first);
    if (selected !== undefined) {
      const match = /^([1-9])$/.exec(key.sequence);
      if (match !== null) {
        const label = selected.frame.options[Number(match[1]) - 1];
        if (label !== undefined) {
          key.preventDefault();
          store.answerSelect(first.identity, label);
        }
      }
      return;
    }
    const confirm = confirmEntry(first);
    if (confirm !== undefined) {
      if (key.sequence === "y" || key.sequence === "Y") {
        key.preventDefault();
        store.answerConfirm(first.identity, true);
        return;
      }
      if (key.sequence === "n" || key.sequence === "N") {
        key.preventDefault();
        store.answerConfirm(first.identity, false);
        return;
      }
    }
    if (key.name === "escape") {
      key.preventDefault();
      store.cancel(first.identity);
    }
  });
  if (props.store === undefined) {
    const timer = setInterval(() => store.refreshClock(), 1000);
    onCleanup(() => {
      clearInterval(timer);
      store.dispose();
    });
  }
  return (
    <box flexDirection="column" flexShrink={0}>
      <box paddingTop={1} flexShrink={0}>
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
          Host dialogs
        </text>
      </box>
      <Show when={store.entries().length > 0} fallback={<Hint text="The host is not waiting on a dialog." />}>
        <For each={store.entries()}>{(entry) => <DialogView store={store} entry={entry} />}</For>
      </Show>
      <box paddingLeft={1} paddingTop={1} flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="word">
          Answers are written back as extension_ui_response frames. The host decides whether an answer is accepted and
          whether the action runs; choosing an option here authorizes nothing on its own.
        </text>
      </box>
    </box>
  );
}

function DialogView(props: { readonly store: DialogsStore; readonly entry: DialogEntry }) {
  const theme = useTheme();
  const fieldLine = () => hostFieldLine(props.entry.frame);
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={theme.text.formfield.selected}>{methodLabel(props.entry.method)}</text>
      </box>
      <For each={entryTitleLines(props.entry)}>
        {(line) => (
          <text fg={theme.text.base} wrapMode="word">
            {line}
          </text>
        )}
      </For>
      <Show when={fieldLine().length > 0}>
        <text fg={theme.text.muted} wrapMode="word">
          {fieldLine()}
        </text>
      </Show>
      <Show when={selectEntry(props.entry)} keyed>
        {(held) => <SelectBody store={props.store} entry={held} />}
      </Show>
      <Show when={questionEntry(props.entry)} keyed>
        {(held) => <QuestionBody store={props.store} entry={held} />}
      </Show>
      <Show when={confirmEntry(props.entry)} keyed>
        {(held) => <ConfirmBody store={props.store} entry={held} />}
      </Show>
      <Show when={inputEntry(props.entry)} keyed>
        {(held) => <InputBody store={props.store} entry={held} />}
      </Show>
      <Show when={editorEntry(props.entry)} keyed>
        {(held) => <EditorBody store={props.store} entry={held} />}
      </Show>
      <Show when={props.entry.status !== "open" || props.entry.failure !== null}>
        <text fg={resolutionColor(props.entry, theme)} wrapMode="word">
          {resolutionText(props.entry)}
        </text>
      </Show>
    </box>
  );
}

function SelectBody(props: { readonly store: DialogsStore; readonly entry: SelectDialogEntry }) {
  const theme = useTheme();
  const open = () => props.entry.status === "open";
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <text fg={theme.text.muted}>The chosen label is sent back as the value.</text>
      <For each={props.entry.frame.options}>
        {(option, index) => {
          const chosen = () => props.entry.answer === option;
          return (
            <box
              flexDirection="row"
              flexShrink={0}
              onMouseDown={() => {
                if (open()) attempt(() => props.store.answerSelect(props.entry.identity, option));
              }}
            >
              <text width={3} flexShrink={0} fg={theme.text.formfield.selected}>
                {chosen() ? "✓" : ""}
              </text>
              <text fg={theme.text.muted}>{index() + 1 + "."}</text>
              <text fg={open() ? theme.text.formfield.base : theme.text.muted} wrapMode="word">
                {" " + option}
              </text>
            </box>
          );
        }}
      </For>
      <Show when={open()}>
        <box
          paddingTop={1}
          flexShrink={0}
          onMouseDown={() => attempt(() => props.store.cancel(props.entry.identity))}
        >
          <text fg={theme.text.action.destructive.focused}>Cancel (sends cancelled: true)</text>
        </box>
      </Show>
    </box>
  );
}

function ConfirmBody(props: { readonly store: DialogsStore; readonly entry: ConfirmDialogEntry }) {
  const theme = useTheme();
  const open = () => props.entry.status === "open";
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <For each={textLines(props.entry.frame.message)}>
        {(line) => (
          <text fg={theme.text.base} wrapMode="word">
            {line}
          </text>
        )}
      </For>
      <Show when={open()}>
        <box
          paddingTop={1}
          flexShrink={0}
          onMouseDown={() => attempt(() => props.store.answerConfirm(props.entry.identity, true))}
        >
          <text fg={theme.text.action.primary.focused}>Confirm (sends confirmed: true)</text>
        </box>
        <box
          flexShrink={0}
          onMouseDown={() => attempt(() => props.store.answerConfirm(props.entry.identity, false))}
        >
          <text fg={theme.text.action.primary.focused}>Decline (sends confirmed: false)</text>
        </box>
        <box
          paddingTop={1}
          flexShrink={0}
          onMouseDown={() => attempt(() => props.store.cancel(props.entry.identity))}
        >
          <text fg={theme.text.action.destructive.focused}>Cancel (sends cancelled: true)</text>
        </box>
      </Show>
    </box>
  );
}

function InputBody(props: { readonly store: DialogsStore; readonly entry: InputDialogEntry }) {
  const theme = useTheme();
  const open = () => props.entry.status === "open";
  const secret = () => props.entry.frame.secret === true;
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <Show when={props.entry.frame.placeholder}>
        {(placeholder) => (
          <text fg={theme.text.muted} wrapMode="word">
            {"Placeholder: " + placeholder()}
          </text>
        )}
      </Show>
      <Show when={secret()}>
        <text fg={theme.text.feedback.warning.base} wrapMode="word">
          The host marks this answer secret: typed characters are never drawn, and the settled line reports only how
          many were sent.
        </text>
      </Show>
      <Show when={open()}>
        <Show when={secret()} fallback={<PlainTextField store={props.store} entry={props.entry} />}>
          <SecretField store={props.store} entry={props.entry} />
        </Show>
        <TextActions store={props.store} entry={props.entry} label="Send value (sends the typed value)" />
      </Show>
    </box>
  );
}

function EditorBody(props: { readonly store: DialogsStore; readonly entry: EditorDialogEntry }) {
  const theme = useTheme();
  const open = () => props.entry.status === "open";
  /* captured once: the field owns the text after creation, and the store only keeps the latest value */
  const initial = props.store.textFor(props.entry);
  let area: TextareaRenderable | undefined;
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <text fg={theme.text.muted} wrapMode="word">
        The host prefilled this text; edit it and send it back as the value.
      </text>
      <Show when={open()}>
        <textarea
          ref={(item: TextareaRenderable) => {
            area = item;
          }}
          initialValue={initial}
          minHeight={3}
          maxHeight={6}
          textColor={theme.text.formfield.base}
          focusedTextColor={theme.text.formfield.focused}
          cursorColor={theme.text.formfield.focused}
          onContentChange={() => {
            /* the rendered textarea reports the change event, not the text, so the buffer is read here */
            if (area === undefined || area.isDestroyed) return;
            props.store.setText(props.entry.identity, area.plainText);
          }}
        />
        <TextActions store={props.store} entry={props.entry} label="Send text (sends the edited text)" />
      </Show>
    </box>
  );
}

function PlainTextField(props: { readonly store: DialogsStore; readonly entry: InputDialogEntry }) {
  const theme = useTheme();
  /* captured once: the field owns the text after creation, and the store only keeps the latest value */
  const initial = props.store.textFor(props.entry);
  let area: TextareaRenderable | undefined;
  return (
    <textarea
      ref={(item: TextareaRenderable) => {
        area = item;
      }}
      initialValue={initial}
      minHeight={1}
      maxHeight={3}
      textColor={theme.text.formfield.base}
      focusedTextColor={theme.text.formfield.focused}
      cursorColor={theme.text.formfield.focused}
      onContentChange={() => {
        if (area === undefined || area.isDestroyed) return;
        props.store.setText(props.entry.identity, area.plainText);
      }}
    />
  );
}

/**
 * A secret field cannot use `textarea`: `@opentui/core`'s Input and Textarea renderables draw their
 * own buffer and expose no masking option, so a typed character would reach the frame. This field
 * therefore keeps the draft in the store and paints only the mask, taking keystrokes while focused.
 */
function SecretField(props: { readonly store: DialogsStore; readonly entry: InputDialogEntry }) {
  const theme = useTheme();
  let field: BoxRenderable | undefined;
  const value = () => props.store.textFor(props.entry);
  const emptyHint = "click to focus, then type; characters are not shown";
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <box
        id={"dialog-secret-" + props.entry.identity}
        ref={(element: BoxRenderable) => {
          field = element;
        }}
        focusable
        flexDirection="row"
        flexShrink={0}
        onMouseDown={() => field?.focus()}
        onPaste={(event: PasteEvent) => {
          if (props.entry.status !== "open") return;
          props.store.setText(props.entry.identity, value() + new TextDecoder().decode(event.bytes));
        }}
        onKeyDown={(key: KeyEvent) => {
          if (props.entry.status !== "open") return;
          if (key.name === "backspace") {
            key.preventDefault();
            props.store.setText(props.entry.identity, value().slice(0, -1));
            return;
          }
          if (key.name === "return" || key.name === "enter") {
            key.preventDefault();
            attempt(() => props.store.answerText(props.entry.identity));
            return;
          }
          if (key.name === "tab" || key.name === "escape" || key.ctrl || key.meta || key.super === true) return;
          if (key.sequence.length === 0 || key.sequence.startsWith("\u001B")) return;
          key.preventDefault();
          props.store.setText(props.entry.identity, value() + key.sequence);
        }}
      >
        <text fg={value().length === 0 ? theme.text.muted : theme.text.formfield.focused} wrapMode="none" truncate>
          {value().length === 0 ? emptyHint : secretMask(value())}
        </text>
      </box>
    </box>
  );
}

function TextActions(props: { readonly store: DialogsStore; readonly entry: TextDialogEntry; readonly label: string }) {
  const theme = useTheme();
  return (
    <>
      <box
        paddingTop={1}
        flexShrink={0}
        onMouseDown={() => attempt(() => props.store.answerText(props.entry.identity))}
      >
        <text fg={theme.text.action.primary.focused}>{props.label}</text>
      </box>
      <box flexShrink={0} onMouseDown={() => attempt(() => props.store.cancel(props.entry.identity))}>
        <text fg={theme.text.action.destructive.focused}>Cancel (sends cancelled: true)</text>
      </box>
    </>
  );
}

function QuestionBody(props: { readonly store: DialogsStore; readonly entry: QuestionDialogEntry }) {
  const theme = useTheme();
  const open = () => props.entry.status === "open";
  const draft = () => props.store.draft(props.entry.identity);
  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={open()}>
        <text fg={theme.text.feedback.warning.base} wrapMode="word">
          {props.store.remainingLabel(props.entry)}
        </text>
      </Show>
      <For each={props.entry.frame.questions}>
        {(question) => <QuestionFields store={props.store} entry={props.entry} question={question} />}
      </For>
      <Show when={open()}>
        <box
          paddingTop={1}
          flexShrink={0}
          onMouseDown={() => attempt(() => props.store.submitQuestion(props.entry.identity))}
        >
          <text fg={theme.text.action.primary.focused}>Send answers</text>
        </box>
        <box flexShrink={0} onMouseDown={() => attempt(() => props.store.cancel(props.entry.identity))}>
          <text fg={theme.text.action.destructive.focused}>Cancel (sends cancelled: true)</text>
        </box>
      </Show>
      <Show when={draft().comment.length > 0}>
        <text fg={theme.text.muted} wrapMode="word">
          {"Comment: " + draft().comment}
        </text>
      </Show>
    </box>
  );
}

function QuestionFields(props: {
  readonly store: DialogsStore;
  readonly entry: QuestionDialogEntry;
  readonly question: QuestionRequestFrame["questions"][number];
}) {
  const theme = useTheme();
  const open = () => props.entry.status === "open";
  const selected = () => props.store.draft(props.entry.identity).selections[props.question.id] ?? [];
  let area: TextareaRenderable | undefined;
  return (
    <box flexDirection="column" flexShrink={0} paddingTop={1}>
      <text fg={theme.text.base} attributes={TextAttributes.BOLD} wrapMode="word">
        {props.question.header}
      </text>
      <text fg={theme.text.base} wrapMode="word">
        {props.question.question}
      </text>
      <text fg={theme.text.muted}>
        {props.question.multiSelect ? "Select any that apply." : "Select one."}
      </text>
      <For each={props.question.options}>
        {(option) => (
          <box flexDirection="column" flexShrink={0}>
            <box
              flexDirection="row"
              flexShrink={0}
              onMouseDown={() => {
                if (open()) attempt(() => props.store.toggleOption(props.entry.identity, props.question.id, option.label));
              }}
            >
              <text width={4} flexShrink={0} fg={theme.text.formfield.selected}>
                {selected().includes(option.label) ? "[✓]" : "[ ]"}
              </text>
              <text fg={open() ? theme.text.formfield.base : theme.text.muted} wrapMode="word">
                {option.label}
              </text>
            </box>
            <Show when={option.description}>
              {(description) => (
                <box paddingLeft={4} flexShrink={0}>
                  <text fg={theme.text.muted} wrapMode="word">
                    {description()}
                  </text>
                </box>
              )}
            </Show>
          </box>
        )}
      </For>
      <Show when={open()}>
        <box paddingLeft={4} flexShrink={0}>
          <textarea
            ref={(item: TextareaRenderable) => {
              area = item;
            }}
            initialValue={props.store.draft(props.entry.identity).texts[props.question.id] ?? ""}
            placeholder="Free-form answer (optional)"
            placeholderColor={theme.text.muted}
            minHeight={1}
            maxHeight={3}
            textColor={theme.text.formfield.base}
            focusedTextColor={theme.text.formfield.focused}
            cursorColor={theme.text.formfield.focused}
            onContentChange={() => {
              if (area === undefined || area.isDestroyed) return;
              props.store.setQuestionText(props.entry.identity, props.question.id, area.plainText);
            }}
          />
        </box>
      </Show>
      <Show when={props.question.options.length === 0}>
        <text fg={theme.text.muted}>The host offered no options for this question.</text>
      </Show>
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

/**
 * Copy for a settled or refused entry. A dialog the host closed carries no outcome on this path
 * (`question_resolved.outcome` is not forwarded to the TUI data contract), so a host close reads as
 * cancelled or timed out rather than claiming which one it was.
 */
function resolutionText(entry: DialogEntry): string {
  if (entry.failure !== null) return "The answer was not sent: " + entry.failure;
  if (entry.status === "answered") {
    return "Answered: " + (entry.answer ?? "") + " (sent once; this prompt is not submitted again)";
  }
  if (entry.status === "cancelled") {
    return entry.cancelledBy === "client"
      ? "Cancelled by this client; the host was sent cancelled: true."
      : "Dismissed by the host (cancelled or timed out). It can no longer be answered.";
  }
  return "";
}

function resolutionColor(entry: DialogEntry, theme: ReturnType<typeof useTheme>) {
  if (entry.failure !== null) return theme.text.feedback.error.base;
  if (entry.status === "answered") return theme.text.feedback.success.base;
  return theme.text.muted;
}

function methodLabel(method: DialogEntry["method"]): string {
  if (method === "select") return "Select";
  if (method === "question") return "Question";
  if (method === "confirm") return "Confirm";
  if (method === "input") return "Input";
  return "Editor";
}

/**
 * Only fields the frame actually carries are listed. A `question` has no title, and each other method
 * has its own optional fields, so nothing is printed as if the host had sent it.
 */
function hostFieldLine(frame: HostDialogRequestFrame): string {
  const parts: string[] = [];
  if (frame.method === "question") {
    parts.push("requestId=" + frame.requestId);
    parts.push("waitForAnswer=" + frame.waitForAnswer);
    parts.push("timeout=" + frame.timeout);
    parts.push("toolCallId=" + frame.toolCallId);
    if (frame.raisedBy !== undefined) parts.push("raisedBy=" + frame.raisedBy);
  } else {
    if (frame.method !== "editor" && frame.timeout !== undefined) parts.push("timeout=" + frame.timeout);
    if (frame.method === "select") {
      if (frame.toolCallId !== undefined) parts.push("toolCallId=" + frame.toolCallId);
      if (frame.parentToolCallId !== undefined) parts.push("parentToolCallId=" + frame.parentToolCallId);
      if (frame.grantSelect !== undefined) parts.push("grantSelect=" + frame.grantSelect);
    }
    if (frame.method === "input") {
      if (frame.deadlineAtMs !== undefined) parts.push("deadlineAtMs=" + frame.deadlineAtMs);
      if (frame.toolCallId !== undefined) parts.push("toolCallId=" + frame.toolCallId);
      if (frame.parentToolCallId !== undefined) parts.push("parentToolCallId=" + frame.parentToolCallId);
      if (frame.secret === true) parts.push("secret=true");
    }
  }
  if (frame.sessionId !== undefined) parts.push("sessionId=" + frame.sessionId);
  if (frame.remoteOrigin !== undefined) parts.push("raisedOn=" + frame.remoteOrigin.deviceId);
  return parts.join(" · ");
}

/**
 * A failed write is recorded on the entry by the store and rendered by `resolutionText`; the click
 * handler must not also crash the panel.
 */
function attempt(run: () => void) {
  try {
    run();
  } catch {
    return;
  }
}
