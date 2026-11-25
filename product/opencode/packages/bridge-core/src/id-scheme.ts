import { createHash } from "node:crypto";

/**
 * The client's identity scheme, reproduced as a translation layer.
 *
 * OpenCode mints `msg_<12 hex time><14 base62>` message ids (`packages/schema/src/session-message.ts`
 * `ID.create`, `packages/schema/src/identifier.ts` `ascending`) and brands them `Session.Message.ID`.
 * The host publishes its own entry ids instead (a session-tree entry, e.g. `78160a07`), and those are
 * what `navigate_tree`, `edit_user_message` and `fork` address. This module mints the client-shaped id
 * from the host's identity instead of reusing the host id verbatim:
 *
 * - `msg_...` for a message, keyed by the host entry id when the transcript binds to one, by the
 *   host's own message id when a frame publishes one, and by the host's own append ordinal when the
 *   pull binds no entry;
 * - `part_...` for one part of such a message.
 *
 * The id is a pure function of the identity and the host's timestamp, so the same host entry mints the
 * same id on every pull and in every process, while different entries never share one. The map keeps
 * the reverse direction, so a consumer holding a client id can name the host entry it came from; host
 * ids themselves travel only in `metadata` (`projectHostMessages` in the launcher, `entry_appended` in
 * the projector), never as an id.
 *
 * A message the host has not named yet needs an id too, because the client brands every
 * `assistantMessageID`/`messageID` a part of the event union carries (`session-event.ts`,
 * `SessionMessage.ID`) and `decodeHostEvent` refuses anything else. Measured on the official host, the
 * live message records (`message_start`, `message_update`, `message_end`, `turn_start`, `turn_end`)
 * carry no id at all, so the bridge's own per-session ordinal stands in until the message's
 * `entry_appended` publishes the entry it became.
 */
const MESSAGE_PREFIX = "msg_";
const PART_PREFIX = "part_";
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SUFFIX_LENGTH = 14;

/**
 * Mints `<prefix><12 hex of the host timestamp><14 base62 of a digest of the identity>`, the exact
 * shape and length `Identifier.ascending()` produces (26 characters for the client prefixes).
 */
export function ascendingIdentifier(prefix: string, timestamp: number, identity: string): string {
  const time = (Number.isFinite(timestamp) ? BigInt(Math.max(0, Math.floor(timestamp))) : 0n) & 0xffffffffffffn;
  const digest = createHash("sha256").update(identity, "utf8").digest();
  let suffix = "";
  for (let index = 0; suffix.length < SUFFIX_LENGTH; index += 1) {
    suffix += ALPHABET.charAt(digest[index % digest.length]! % ALPHABET.length);
  }
  return prefix + time.toString(16).padStart(12, "0") + suffix;
}

/** A message is identified by the host entry it became, or by its place in the pulled transcript. */
export type MessageIdentity =
  | { readonly sessionID: string; readonly entryID: string; readonly ordinal?: number }
  | { readonly sessionID: string; readonly ordinal: number };

export type PartIdentity = {
  readonly kind: "text" | "reasoning" | "tool";
  readonly ordinal: number;
};

export type MessageHostRef = MessageIdentity & { readonly kind: "message" };
export type PartHostRef = {
  readonly kind: "part";
  readonly messageID: string;
  readonly part: PartIdentity;
};
export type HostRef = MessageHostRef | PartHostRef;

function messageKey(identity: MessageIdentity): string {
  return "entryID" in identity
    ? "message:entry:" + identity.sessionID + ":" + identity.entryID
    : "message:ordinal:" + identity.sessionID + ":" + String(identity.ordinal);
}

function partKey(messageID: string, part: PartIdentity): string {
  return "part:" + messageID + ":" + part.kind + ":" + String(part.ordinal);
}

export class BridgeIdScheme {
  private readonly byID = new Map<string, HostRef>();
  private readonly byHost = new Map<string, string>();

  messageID(identity: MessageIdentity, timestamp: number): string {
    return this.mint(
      messageKey(identity),
      () => ascendingIdentifier(MESSAGE_PREFIX, timestamp, messageKey(identity)),
      () => ({ kind: "message", ...identity }),
    );
  }

  /**
   * A message whose identity the host published as its own message id rather than a session-tree
   * entry (a live frame's `messageId`). An id that already carries the client's `msg_` brand is that
   * client id already and is kept: minting a second one would lose the identity the host published.
   * Kept apart from the pull's entry/ordinal keys so the bases can never collide.
   */
  hostMessageID(sessionID: string, hostID: string, timestamp: number): string {
    if (hostID.startsWith(MESSAGE_PREFIX)) return hostID;
    return this.mint(
      "message:host:" + sessionID + ":" + hostID,
      () => ascendingIdentifier(MESSAGE_PREFIX, timestamp, "message:host:" + sessionID + ":" + hostID),
      () => ({ kind: "message", sessionID: sessionID, ordinal: 0 }),
    );
  }

  /**
   * A message no host record names yet, keyed by the bridge's per-session message ordinal. It is a
   * placeholder with a client shape: once the host appends the entry, the entry-keyed id is the one
   * the pulled transcript and the entry's content update carry.
   */
  streamMessageID(sessionID: string, ordinal: number, timestamp: number): string {
    return this.mint(
      "message:stream:" + sessionID + ":" + String(ordinal),
      () => ascendingIdentifier(MESSAGE_PREFIX, timestamp, "message:stream:" + sessionID + ":" + String(ordinal)),
      () => ({ kind: "message", sessionID: sessionID, ordinal: ordinal }),
    );
  }

  partID(messageID: string, part: PartIdentity, timestamp: number): string {
    return this.mint(
      partKey(messageID, part),
      () => ascendingIdentifier(PART_PREFIX, timestamp, partKey(messageID, part)),
      () => ({ kind: "part", messageID: messageID, part: part }),
    );
  }

  hostOf(id: string): HostRef | undefined {
    return this.byID.get(id);
  }

  idForMessage(identity: MessageIdentity): string | undefined {
    return this.byHost.get(messageKey(identity));
  }

  private mint(key: string, create: () => string, describe: () => HostRef): string {
    const existing = this.byHost.get(key);
    if (existing !== undefined) return existing;
    const id = create();
    this.byHost.set(key, id);
    this.byID.set(id, describe());
    return id;
  }
}
