import { createMemo, For, Show } from "solid-js";
import type { BridgeTuiData } from "../../../context/bridge-data.ts";
import { useTheme } from "../../../context/theme";
import { Spinner } from "../../../component/spinner";
import { INLINE_TOOL_ICON_WIDTH, InlineToolRow } from "../../../routes/session/message-parts";
import { SplitBorder } from "../../../ui/border";
import { Locale } from "../../../util/locale";
import {
  deriveTranscript,
  type TranscriptAssistantMessage,
  type TranscriptMessage,
  type TranscriptPart,
  type TranscriptToolPart,
} from "./state.ts";

export type TranscriptProps = {
  readonly data: BridgeTuiData;
  readonly sessionID: string;
  /* BridgeData has no change subscription, so the caller supplies the signal that marks new host payloads. */
  readonly revision?: () => unknown;
};

export function Transcript(props: TranscriptProps) {
  const theme = useTheme();
  const model = createMemo(() => {
    props.revision?.();
    return deriveTranscript(props.data.session.message.list(props.sessionID), props.data.session.status(props.sessionID));
  });
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={model().messages}>{(message) => <TranscriptMessageView message={message} />}</For>
      <Show when={model().run.waitingForAssistant}>
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <Spinner color={theme.text.muted}>Streaming…</Spinner>
        </box>
      </Show>
    </box>
  );
}

function TranscriptMessageView(props: { message: TranscriptMessage }) {
  const message = props.message;
  if (message.kind === "user") return <UserEcho text={message.text} />;
  if (message.kind === "assistant") return <AssistantMessage message={message} />;
  if (message.kind === "notice") return <NoticeLine text={message.text} />;
  return <FailureLine message={message.message} />;
}

function UserEcho(props: { text: string }) {
  const theme = useTheme();
  return (
    <Show when={props.text.trim()}>
      <box
        border={["left"]}
        borderColor={theme.border.base}
        customBorderChars={SplitBorder.customBorderChars}
        backgroundColor={theme.background.raised.base}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        flexShrink={0}
      >
        <text fg={theme.text.base} wrapMode="word">
          {props.text}
        </text>
      </box>
    </Show>
  );
}

function AssistantMessage(props: { message: TranscriptAssistantMessage }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <For each={props.message.parts}>{(part) => <TranscriptPartView part={part} />}</For>
      <Show when={props.message.error}>{(error) => <FailureLine message={error()} />}</Show>
      <Show
        when={props.message.streaming}
        fallback={
          <box paddingLeft={3} marginTop={1} flexShrink={0}>
            <text fg={theme.text.muted} wrapMode="word">
              {Locale.titlecase(props.message.agent)} · {props.message.model}
            </text>
          </box>
        }
      >
        <box paddingLeft={3} marginTop={1} flexShrink={0}>
          <Spinner color={theme.text.muted}>Streaming…</Spinner>
        </box>
      </Show>
    </box>
  );
}

function TranscriptPartView(props: { part: TranscriptPart }) {
  const part = props.part;
  if (part.kind === "text") return <TextBlock text={part.text} />;
  if (part.kind === "reasoning") return <ReasoningBlock text={part.text} />;
  return <ToolBlock part={part} />;
}

function TextBlock(props: { text: string }) {
  const theme = useTheme();
  return (
    <Show when={props.text.trim()}>
      <box paddingLeft={3} flexShrink={0}>
        <text fg={theme.text.base} wrapMode="word">
          {props.text}
        </text>
      </box>
    </Show>
  );
}

function ReasoningBlock(props: { text: string }) {
  const theme = useTheme();
  return (
    <Show when={props.text.trim()}>
      <box paddingLeft={3} marginTop={1} flexShrink={0}>
        <box
          border={["left"]}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.decrease(theme.background.base)}
          paddingLeft={1}
          flexDirection="column"
          flexShrink={0}
        >
          <text fg={theme.text.muted}>Thought</text>
          <text fg={theme.text.muted} wrapMode="word">
            {props.text}
          </text>
        </box>
      </box>
    </Show>
  );
}

function ToolBlock(props: { part: TranscriptToolPart }) {
  const theme = useTheme();
  const label = () => (props.part.input.length > 0 ? props.part.name + " " + props.part.input : props.part.name);
  const output = () => props.part.error ?? props.part.result;
  return (
    <box flexDirection="column" marginTop={1} flexShrink={0}>
      <InlineToolRow
        icon={props.part.status === "error" ? "✗" : "✓"}
        complete={props.part.status === "completed"}
        pending={label()}
        spinner={props.part.status === "streaming" || props.part.status === "running"}
        failed={props.part.error !== null}
        failure={label()}
        color={theme.text.base}
        errorColor={theme.text.feedback.error.base}
      >
        {label()}
      </InlineToolRow>
      <Show when={output()}>
        {(value) => (
          <box paddingLeft={3 + INLINE_TOOL_ICON_WIDTH} flexShrink={0}>
            <text fg={props.part.error !== null ? theme.text.feedback.error.base : theme.text.base} wrapMode="word">
              {value()}
            </text>
          </box>
        )}
      </Show>
    </box>
  );
}

function NoticeLine(props: { text: string }) {
  const theme = useTheme();
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text fg={theme.text.muted} wrapMode="word">
        {props.text}
      </text>
    </box>
  );
}

function FailureLine(props: { message: string }) {
  const theme = useTheme();
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text fg={theme.text.feedback.error.base} wrapMode="word">
        Error: {props.message}
      </text>
    </box>
  );
}
