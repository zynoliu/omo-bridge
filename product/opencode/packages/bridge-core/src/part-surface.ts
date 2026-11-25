import type { BridgeData, DataView } from "./data.ts";
import { SurfaceNotFound } from "./opencode-surface.ts";

export type ProjectedPart =
  | { readonly type: "text"; readonly id: string; readonly text: string }
  | { readonly type: "reasoning"; readonly id: string; readonly text: string }
  | { readonly type: "tool"; readonly id: string; readonly arguments: string; readonly result: string | null };

export type PartSurface = {
  readonly part: {
    readonly list: (input: { readonly sessionID: string; readonly messageID: string }) => Promise<readonly ProjectedPart[]>;
  };
};

/**
 * Parts come from the message the caller asked for. The transcript the host delivered answers first: it
 * is the authoritative content for that message id, and its parts are minted ids (`id-scheme.ts`) like
 * every other client id. The live buffer answers only when no transcript row carries the id, which is
 * the case while a turn is still streaming; its parts are minted against the same identity, so a part
 * keeps its id whether it was read during the turn or after it.
 */
export function createPartSurface(data: BridgeData): PartSurface {
  return {
    part: {
      async list(input) {
        const view = data.view();
        if (!view.sessions.some((session) => session.id === input.sessionID)) throw new SurfaceNotFound(input.sessionID);
        const message = data.hostMessagesFor(input.sessionID).find((candidate) => candidate.id === input.messageID);
        if (message !== undefined && message.type === "assistant") {
          const fromTranscript: ProjectedPart[] = [];
          message.content.forEach((part, index) => {
            const id = data.ids.partID(message.id, { kind: part.type, ordinal: index }, message.time.created);
            if (part.type === "text") fromTranscript.push({ type: "text", id: id, text: part.text });
            else if (part.type === "reasoning") fromTranscript.push({ type: "reasoning", id: id, text: part.text });
            else if (part.type === "tool") {
              const state = part.state;
              fromTranscript.push({
                type: "tool",
                id: id,
                arguments: JSON.stringify(state.input ?? {}),
                result: state.status === "completed" && state.content !== undefined ? JSON.stringify(state.content) : null,
              });
            }
          });
          return fromTranscript;
        }
        return liveParts(data, input.messageID, view.message);
      },
    },
  };
}

/** What the streaming buffer holds for `messageID`, minted against that message so the id is stable. */
function liveParts(data: BridgeData, messageID: string, message: DataView["message"]): ProjectedPart[] {
  const parts: ProjectedPart[] = [];
  const created = partTimestamp(messageID);
  if (message.text.length > 0) {
    parts.push({ type: "text", id: data.ids.partID(messageID, { kind: "text", ordinal: 0 }, created), text: message.text });
  }
  message.tools.forEach((tool, index) => {
    parts.push({
      type: "tool",
      id: data.ids.partID(messageID, { kind: "tool", ordinal: index }, created),
      arguments: tool.arguments,
      result: tool.result,
    });
  });
  return parts;
}

/** The timestamp a message id already carries, so a part minted from it is stable across processes. */
function partTimestamp(messageID: string): number {
  const parsed = Number.parseInt(messageID.startsWith("msg_") ? messageID.slice(4, 16) : "", 16);
  return Number.isFinite(parsed) ? parsed : 0;
}
