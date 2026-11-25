import type { BridgeData, ViewSession } from "./data.ts";
import type { DialogRegistry, DialogResult } from "./dialogs.ts";
import type { InteractionController, Outcome, TurnId } from "./interaction.ts";
import type { SessionRegistry } from "./sessions.ts";

export const UNSUPPORTED_CAPABILITY = "UNSUPPORTED_CAPABILITY";

export class UnsupportedCapability extends Error {
  readonly capability: string;
  constructor(capability: string) {
    super(UNSUPPORTED_CAPABILITY + ": " + capability);
    this.name = "UnsupportedCapability";
    this.capability = capability;
  }
}

/**
 * One live terminal stream, in the shape the terminal pane drives: message events, `send` and `close`.
 * The pane receives both binary output frames and JSON control messages on the same channel.
 */
export type BridgePtySocketLike = {
  binaryType: "arraybuffer";
  readonly addEventListener: (type: "message", listener: (event: { readonly data: ArrayBuffer | string }) => void) => void;
  readonly removeEventListener: (type: "message", listener: (event: { readonly data: ArrayBuffer | string }) => void) => void;
  readonly send: (frame: Uint8Array) => void;
  readonly close: () => void;
};

export type ClientDependencies = {
  readonly data: BridgeData;
  readonly sessions: SessionRegistry;
  readonly dialogs: DialogRegistry;
  readonly interaction: InteractionController;
  /** Absent when the launcher could not build a terminal service; `persistentPty.connect` then refuses. */
  readonly ptyConnect?: (input: {
    readonly ptyID: string;
    readonly cursor: number;
    readonly attachmentID: string;
    readonly takeover?: boolean;
  }) => Promise<BridgePtySocketLike>;
};

export class BridgeClient {
  private readonly deps: ClientDependencies;

  constructor(deps: ClientDependencies) {
    this.deps = deps;
  }

  /**
   * The live terminal stream. The pane opens it after reading the snapshot, then writes input frames
   * and reads output; without an injected terminal service this refuses rather than returning a socket
   * that would silently swallow every keystroke.
   */
  readonly persistentPty = {
    connect: (input: {
      readonly ptyID: string;
      readonly cursor: number;
      readonly attachmentID: string;
      readonly takeover?: boolean;
    }): Promise<BridgePtySocketLike> => {
      const connect = this.deps.ptyConnect;
      if (connect === undefined) throw new UnsupportedCapability("client.persistentPty.connect");
      return connect(input);
    },
  };

  sessionList(): readonly ViewSession[] {
    return this.deps.data.view().sessions;
  }

  sessionCreate(persistentId: string, title: string): ViewSession {
    const opened = this.deps.sessions.open({ persistentId: persistentId });
    if (opened.kind !== "ok") throw new Error("session open refused: " + opened.code);
    return this.deps.data.upsertSession({ id: persistentId, title: title, messages: 0 });
  }

  sessionSelect(sessionId: string): boolean {
    return this.deps.data.select(sessionId);
  }

  inputSubmit(kind: "steer" | "follow_up", turn: TurnId, text: string): Outcome<unknown> {
    return this.deps.interaction.submit(turn, kind, text);
  }

  dialogAnswer(dialogId: string, value: string): DialogResult {
    return this.deps.dialogs.answer(dialogId, value);
  }

  capability(id: string): never {
    throw new UnsupportedCapability(id);
  }
}
