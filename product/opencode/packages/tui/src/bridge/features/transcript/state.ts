import type {
  ModelRef,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionStructuredError,
} from "@opencode/client";
import { errorMessage } from "../../../util/error";
import { canonicalToolName, primitiveInputSummary, toolDisplayContent } from "../../../util/tool-display";
import { Locale } from "../../../util/locale";

export type TranscriptSessionStatus = "idle" | "running";

export type TranscriptPart =
  | { readonly kind: "text"; readonly id: string; readonly text: string }
  | { readonly kind: "reasoning"; readonly id: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly name: string;
      readonly status: SessionMessageAssistantTool["state"]["status"];
      readonly input: string;
      readonly result: string | null;
      readonly error: string | null;
    };

export type TranscriptToolPart = Extract<TranscriptPart, { kind: "tool" }>;

export type TranscriptAssistantMessage = {
  readonly kind: "assistant";
  readonly id: string;
  readonly agent: string;
  readonly model: string;
  readonly streaming: boolean;
  readonly parts: readonly TranscriptPart[];
  readonly error: string | null;
};

export type TranscriptMessage =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | TranscriptAssistantMessage
  | { readonly kind: "notice"; readonly id: string; readonly text: string }
  | { readonly kind: "failure"; readonly id: string; readonly message: string };

export type TranscriptRun = {
  readonly streaming: boolean;
  readonly failure: string | null;
  readonly waitingForAssistant: boolean;
};

export type TranscriptModel = {
  readonly messages: readonly TranscriptMessage[];
  readonly run: TranscriptRun;
};

export function deriveTranscript(messages: readonly SessionMessageInfo[], status: TranscriptSessionStatus): TranscriptModel {
  const projected: TranscriptMessage[] = [];
  let lastAssistant: SessionMessageAssistant | undefined;
  for (const message of messages) {
    projected.push(...projectMessage(message));
    if (message.type === "assistant") lastAssistant = message;
  }
  const latest = projected[projected.length - 1];
  const streaming =
    status === "running" || (lastAssistant !== undefined && lastAssistant.time.completed === undefined);
  return {
    messages: projected,
    run: {
      streaming: streaming,
      failure: terminalFailure(messages[messages.length - 1]),
      waitingForAssistant: streaming && latest !== undefined && latest.kind === "user",
    },
  };
}

function projectMessage(message: SessionMessageInfo): TranscriptMessage[] {
  switch (message.type) {
    case "user":
      return [{ kind: "user", id: message.id, text: message.text }];
    case "assistant":
      return [projectAssistant(message)];
    case "idle":
      if (message.outcome === "failed") return [{ kind: "failure", id: message.id, message: failureText(message.error) }];
      if (message.outcome === "interrupted") return [{ kind: "notice", id: message.id, text: "Interrupted" }];
      return [];
    case "compaction":
      if (message.status === "failed") return [{ kind: "failure", id: message.id, message: failureText(message.error) }];
      return [
        {
          kind: "notice",
          id: message.id,
          text: message.status === "running" ? "Compacting context…" : "Context compacted",
        },
      ];
    case "shell":
      return [{ kind: "notice", id: message.id, text: message.command }];
    case "system":
    case "synthetic":
      return noticeRows(message.id, message.text.length > 0 ? message.text : message.description);
    case "skill":
      return [{ kind: "notice", id: message.id, text: message.text.length > 0 ? message.text : message.name }];
    case "agent-switched":
      return [{ kind: "notice", id: message.id, text: "Switched agent to " + Locale.titlecase(message.agent) }];
    case "model-switched":
      return [{ kind: "notice", id: message.id, text: "Switched model to " + modelLabel(message.model) }];
    case "location-switched":
      return [{ kind: "notice", id: message.id, text: "Moved to " + message.location.directory }];
  }
}

function projectAssistant(message: SessionMessageAssistant): TranscriptAssistantMessage {
  return {
    kind: "assistant",
    id: message.id,
    agent: message.agent,
    model: modelLabel(message.model),
    streaming: message.time.completed === undefined,
    parts: message.content.map((part, index) => projectPart(message.id, index, part)),
    error: message.error === undefined ? null : errorMessage(message.error),
  };
}

function projectPart(
  messageID: string,
  index: number,
  part: SessionMessageAssistantText | SessionMessageAssistantReasoning | SessionMessageAssistantTool,
): TranscriptPart {
  /* Only tool parts carry an id; text and reasoning parts are addressed by their position in the message. */
  if (part.type === "text") return { kind: "text", id: messageID + ":text:" + String(index), text: part.text };
  if (part.type === "reasoning") {
    return { kind: "reasoning", id: messageID + ":reasoning:" + String(index), text: part.text };
  }
  return projectTool(messageID, part);
}

function projectTool(messageID: string, part: SessionMessageAssistantTool): TranscriptPart {
  const state = part.state;
  const content =
    state.status === "streaming" || state.status === "running"
      ? []
      : toolDisplayContent(state).flatMap((entry) => (entry.type === "text" ? [entry.text] : [entry.name ?? entry.uri]));
  const result = content.join("\n");
  return {
    kind: "tool",
    id: messageID + ":" + part.id,
    name: canonicalToolName(part.name),
    status: state.status,
    input: state.status === "streaming" ? state.input.trim() : primitiveInputSummary(state.input),
    result: result.length === 0 ? null : result,
    error: state.status === "error" ? errorMessage(state.error) : null,
  };
}

/** The run failed only when the newest message is the one that ended it in error. */
function terminalFailure(message: SessionMessageInfo | undefined): string | null {
  if (message === undefined) return null;
  if (message.type === "idle") return message.outcome === "failed" ? failureText(message.error) : null;
  if (message.type === "assistant") return message.error === undefined ? null : errorMessage(message.error);
  if (message.type === "compaction" && message.status === "failed") return failureText(message.error);
  return null;
}

function noticeRows(id: string, text: string | undefined): TranscriptMessage[] {
  if (text === undefined || text.trim().length === 0) return [];
  return [{ kind: "notice", id: id, text: text }];
}

function failureText(error: SessionStructuredError | undefined): string {
  if (error === undefined) return "run failed (host sent no error payload)";
  return errorMessage(error);
}

function modelLabel(model: ModelRef): string {
  return model.providerID + "/" + model.id;
}
