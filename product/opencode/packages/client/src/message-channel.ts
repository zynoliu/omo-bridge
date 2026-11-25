/**
 * The message-channel members the client contract is missing (capability row P-739).
 *
 * The generated client's message channel is read-only: `session.message.get` is the only member, so
 * the host commands `edit_user_message`, `edit_assistant_message` and `continue_from_leaf` had
 * nowhere to travel. These are the members that carry them, in the same promise shape and with the
 * host's own typed failure codes, so a caller sees `streaming`, `not_user`, `not_assistant` or
 * `leaf_not_assistant` instead of a generic error.
 *
 * The published limit stays: the host keeps no file snapshots, so none of these members restores
 * files. An edit rewrites the transcript (the abandoned branch stays in the session file) and a
 * continue runs a turn from the current leaf.
 */

export type MessageChannelEditInput = {
  readonly sessionID: string;
  /** The host's own entry id for the message, which is what the transcript rows carry. */
  readonly messageID: string;
  readonly text: string;
  /** The leaf the caller last observed; the host refuses a stale one with `stale_leaf` before writing. */
  readonly expectedLeafID?: string;
};

export type MessageChannelEditOutcome = {
  /**
   * `unchanged` means the text matched the original, so nothing was written; `cancelled` means an
   * extension stopped the navigation (or the branch summary it asked for), and the leaf did not move.
   */
  readonly outcome: "edited" | "unchanged" | "cancelled";
  readonly leafID: string | null;
  /** The edited copy's own entry id, absent when nothing was written. */
  readonly entryID?: string;
};

export type MessageChannelContinueInput = {
  readonly sessionID: string;
};

export type MessageChannelFailureCode =
  | "streaming"
  | "not_found"
  | "not_user"
  | "not_assistant"
  | "empty"
  | "stale_leaf"
  | "nothing_to_continue"
  | "leaf_not_assistant";

export const MESSAGE_CHANNEL_REFUSED = "MESSAGE_CHANNEL_REFUSED";

/** A host refusal, kept typed: `code` is the host's own `errorCode`, never a rewritten sentence. */
export class MessageChannelRefused extends Error {
  readonly code: MessageChannelFailureCode;
  readonly detail: string;
  constructor(code: MessageChannelFailureCode, detail: string) {
    super(MESSAGE_CHANNEL_REFUSED + ": " + code + (detail.length === 0 ? "" : " (" + detail + ")"));
    this.name = "MessageChannelRefused";
    this.code = code;
    this.detail = detail;
  }
}

export type MessageChannel = {
  /** The host's `edit_user_message`: the entry must be a user message, or the host answers `not_user`. */
  readonly edit: (input: MessageChannelEditInput) => Promise<MessageChannelEditOutcome>;
  /**
   * The host's `edit_assistant_message`: the entry must be an assistant message, or the host answers
   * `not_assistant`. The copy keeps only the new text, and the original answer stays in the file on
   * an abandoned branch.
   */
  readonly editAssistantMessage: (input: MessageChannelEditInput) => Promise<MessageChannelEditOutcome>;
  readonly continueFromLeaf: (input: MessageChannelContinueInput) => Promise<void>;
};
