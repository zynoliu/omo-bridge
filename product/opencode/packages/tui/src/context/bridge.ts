import { BridgeClient, BridgeData, createEventSurface, createPartSurface, createSessionSurface } from "../../../bridge-core/src/index.ts";
import type { DialogRegistry, InteractionController, SessionPermissionRules, SessionRegistry } from "../../../bridge-core/src/index.ts";
import { createBridgeOpencodeApi } from "../../../bridge-core/src/opencode-api.ts";
import type { BridgeClientApi, BridgePtySurface } from "../../../bridge-core/src/opencode-api.ts";
import type { MessageChannel } from "../../../client/src/message-channel.ts";
import type { LocationRef, SessionInfo } from "@opencode/client";
import { createBridgeTuiData } from "./bridge-data.ts";
import type { BridgePromptSubmission, BridgeTuiData } from "./bridge-data.ts";
import type { BridgeConnectionState } from "../../../cli/src/bridge-entry.ts";

export type BridgeContextDeps = {
  readonly data: BridgeData;
  readonly defaultLocation: LocationRef;
  readonly sessions: SessionRegistry;
  readonly dialogs: DialogRegistry;
  readonly interaction: InteractionController;
  /** Writes one user prompt to the host; the data layer refuses `session.prompt` without it. */
  readonly sendPrompt?: (input: BridgePromptSubmission) => Promise<void>;
  /** The terminal service, when the launcher could build one; without it terminals stay unimplemented. */
  readonly pty?: BridgePtySurface;
  /** Switches a session's model on the host; the launcher owns the transport that performs it. */
  readonly switchModel?: (input: {
    readonly sessionID: string;
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
  }) => Promise<unknown>;
  /** Opens a host session; the TUI's `session.create` refuses without it. */
  readonly createSession?: (input: {
    readonly id?: string;
    readonly title?: string;
    readonly directory?: string;
    /** The session this one is spawned under; the host takes it as `spawnedBy`. */
    readonly parentID?: string;
  }) => Promise<SessionInfo>;
  /** Forks or clones a session on the host; the TUI's `session.fork` refuses without it. */
  readonly forkSession?: (input: { readonly sessionID: string; readonly before?: string }) => Promise<SessionInfo>;
  /** Stages, clears or commits a revert; the boundary is bridge state and the commit is host navigation. */
  readonly revertStage?: (input: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly files?: boolean;
  }) => Promise<{ readonly messageID: string }>;
  readonly revertCommit?: (input: { readonly sessionID: string }) => Promise<void>;
  readonly revertClear?: (input: { readonly sessionID: string }) => Promise<void>;
  /** The bridge's own per-session permission rules; every ask they decide is answered before it shows. */
  readonly permissionRules?: SessionPermissionRules;
  /** The client message channel's `edit_user_message` member (P-739). */
  readonly editMessage?: MessageChannel["edit"];
  /** The client message channel's `edit_assistant_message` member (P-739). */
  readonly editAssistantMessage?: MessageChannel["editAssistantMessage"];
  /** The client message channel's `continue_from_leaf` member (P-739). */
  readonly continueFromLeaf?: MessageChannel["continueFromLeaf"];
};

export type BridgeTuiContext = {
  readonly client: BridgeClient;
  readonly data: BridgeData;
  /** The client surface the TUI uses in place of the generated HTTP client. */
  readonly api: BridgeClientApi;
  /** The data layer the TUI reads through, satisfying the same contract as the client data layer. */
  readonly tuiData: BridgeTuiData;
  readonly connection: () => BridgeConnectionState;
  readonly usesInProcessAdapter: true;
  readonly startsHttpService: false;
};

export function createBridgeTuiContext(deps: BridgeContextDeps, connection: () => BridgeConnectionState): BridgeTuiContext {
  const api = createBridgeOpencodeApi({
    data: deps.data,
    defaultLocation: deps.defaultLocation,
    events: createEventSurface(),
    sessions: createSessionSurface(deps.data),
    parts: createPartSurface(deps.data),
    pty: deps.pty,
    switchModel: deps.switchModel,
    createSession: deps.createSession,
    forkSession: deps.forkSession,
    revertStage: deps.revertStage,
    revertCommit: deps.revertCommit,
    revertClear: deps.revertClear,
    editMessage: deps.editMessage,
    editAssistantMessage: deps.editAssistantMessage,
    continueFromLeaf: deps.continueFromLeaf,
  });
  return {
    client: new BridgeClient(deps),
    data: deps.data,
    api: api,
    tuiData: createBridgeTuiData({
      data: deps.data,
      sessions: deps.sessions,
      dialogs: deps.dialogs,
      interaction: deps.interaction,
      defaultLocation: deps.defaultLocation,
      sendPrompt: deps.sendPrompt,
      createSession: deps.createSession,
      permissionRules: deps.permissionRules,
      editMessage: deps.editMessage,
      editAssistantMessage: deps.editAssistantMessage,
      continueFromLeaf: deps.continueFromLeaf,
      // the data layer's subscriptions read the same stream the TUI's client connection consumes
      events: api.event,
    }),
    connection: connection,
    usesInProcessAdapter: true,
    startsHttpService: false,
  };
}
