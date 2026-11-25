import type { ExtensionRequester } from "./extension-request.ts";
import type { HostPermission, HostThinking } from "./host-capabilities.ts";
import type { PermissionRuleset } from "./permission-rules.ts";
import { samePermissionRules, sessionPermissionsEvent } from "./permission-rules.ts";
import { BridgeIdScheme } from "./id-scheme.ts";
import { SessionDiff } from "./session-diff.ts";
import type {
  AgentInfo,
  CommandInfo,
  ConfigEntry,
  IntegrationInfo,
  LocationPublicInfo,
  McpResource,
  McpServer,
  ModelInfo,
  FormInfo,
  PermissionRequest,
  PluginInfo,
  ProviderInfo,
  ReferenceInfo,
  SessionInfo,
  SessionMessageInfo,
  SkillInfo,
  VcsInfo,
} from "@opencode/client";
import { MessageProjector } from "./stream.ts";
import type { MessageState } from "./stream.ts";

/** One input `get_pending_inputs` reports the host still holds for a session. */
export type HostPendingInput = {
  readonly clientMessageId: string;
  /** `queued`, `edited`, `sending` or `failed`, as the host reports it. */
  readonly state: string;
  readonly text: string;
  readonly requestedMode: string | null;
};

/** One session-tree entry as the host lists it: id, parent link, custom type and the original record. */
export type BridgeBranchEntry = {
  readonly id: string;
  readonly parentId: string | null;
  readonly customType: string | null;
  readonly data: unknown;
};

/** The session tree plus the leaf the session sits on; the current branch is what leads to that leaf. */
export type BridgeBranchSnapshot = {
  readonly leafId: string | null;
  readonly entries: readonly BridgeBranchEntry[];
};

/** A revert the bridge staged from the client's `/undo`: the boundary only, never file snapshots. */
export type HostRevert = { readonly messageID: string };

/**
 * What the bridge did with the `agent` / `agents` selection a prompt named. The host prompt command
 * carries no agent field, so the selection travels as an instruction prefix; this record is what the
 * session reports, and it never says an agent was switched on the host.
 */
export type PromptAgentRecord = {
  readonly requested: readonly string[];
  readonly carrier: "prompt-prefix";
  readonly hostField: false;
  readonly recordedAt: number;
  /** What the host answered to the `set_session_context` patch that records the request. */
  readonly hostContext?: "applied" | "refused";
};

export type ViewSession = {
  readonly id: string;
  readonly title: string;
  readonly messages: number;
};

export type DataView = {
  readonly sessions: readonly ViewSession[];
  readonly selected: string | null;
  readonly message: MessageState;
};

/**
 * Host-delivered state for a single location. Every field stays undefined until the host sends
 * it, so readers can tell "not delivered yet" from "delivered and empty".
 */
export type BridgeLocationState = {
  info?: LocationPublicInfo;
  vcs?: VcsInfo;
  agent?: AgentInfo[];
  command?: CommandInfo[];
  integration?: IntegrationInfo[];
  model?: ModelInfo[];
  provider?: ProviderInfo[];
  reference?: ReferenceInfo[];
  skill?: SkillInfo[];
  mcpServer?: McpServer[];
  mcpResource?: McpResource[];
  config?: ConfigEntry[];
  plugin?: PluginInfo[];
};

export class BridgeData {
  private readonly sessions = new Map<string, ViewSession>();
  private readonly hostSessions = new Map<string, SessionInfo>();
  private readonly hostMessages = new Map<string, SessionMessageInfo[]>();
  private readonly hostPendingInputs = new Map<string, HostPendingInput[]>();
  private locationState: BridgeLocationState = {};
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: unknown) => void>();
  private readonly clientEventListeners = new Set<(event: unknown) => void>();
  private eventSequence = 0;
  private lastEvent: unknown = undefined;
  private readonly permissions = new Map<string, PermissionRequest>();
  private readonly forms = new Map<string, FormInfo>();

  upsertForm(form: FormInfo): void {
    this.forms.set(form.id, form);
    this.changed();
  }

  resolveForm(formId: string): boolean {
    const removed = this.forms.delete(formId);
    if (removed) this.changed();
    return removed;
  }

  formsFor(sessionId: string): FormInfo[] {
    return [...this.forms.values()].filter((form) => form.sessionID === sessionId);
  }

  upsertPermission(request: PermissionRequest): void {
    this.permissions.set(request.id, request);
    this.changed();
  }

  resolvePermission(requestId: string): boolean {
    const removed = this.permissions.delete(requestId);
    if (removed) this.changed();
    return removed;
  }

  permissionsFor(sessionId: string): PermissionRequest[] {
    return [...this.permissions.values()].filter((request) => request.sessionID === sessionId);
  }

  permissionIds(): string[] {
    return [...this.permissions.keys()];
  }
  private revisionCount = 0;

  /** Listeners fire after every mutation, so a view can re-read instead of polling. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Host events are kept as received, untyped, until a schema-validated decoder exists.
   * Nothing here invents an event identity.
   */
  /**
   * The correlator for host `extension_request` round trips. The launcher installs it once the
   * transport is authenticated; a surface that needs a host answer calls `requestExtension` and
   * gets a rejection, never an invented value, when the launcher has not installed one.
   */
  private requester: ExtensionRequester | undefined = undefined;

  setExtensionRequester(requester: ExtensionRequester | undefined): void {
    this.requester = requester;
  }

  hasExtensionRequester(): boolean {
    return this.requester !== undefined;
  }

  /** The answer is unvalidated here: a caller decodes it with the frame decoder for its command. */
  async requestExtension(id: string, frame: unknown): Promise<unknown> {
    const requester = this.requester;
    if (requester === undefined)
      throw new Error("no extension request sender is installed: the launcher has not wired the transport");
    /* The host answers with the request's own `id`; a frame that does not carry it can never be
       correlated, and no answer shape is invented for it here. */
    const carried = typeof frame === "object" && frame !== null && !Array.isArray(frame) ? frame : { data: frame };
    return await requester.request(id, { ...carried, id: id });
  }

  private readonly hostBranches = new Map<string, BridgeBranchSnapshot>();

  setHostBranch(sessionID: string, branch: BridgeBranchSnapshot): void {
    this.hostBranches.set(sessionID, branch);
    this.changed();
  }

  hostBranchFor(sessionID: string): BridgeBranchSnapshot | undefined {
    return this.hostBranches.get(sessionID);
  }

  private readonly hostThinking = new Map<string, HostThinking>();
  private readonly hostPermissions = new Map<string, HostPermission>();
  private readonly hostReverts = new Map<string, HostRevert>();
  private readonly permissionRules = new Map<string, PermissionRuleset>();
  private readonly routingIds = new Map<string, string>();
  private readonly promptAgents = new Map<string, PromptAgentRecord>();

  setHostThinking(sessionID: string, thinking: HostThinking): void {
    this.hostThinking.set(sessionID, thinking);
    this.changed();
  }

  hostThinkingFor(sessionID: string): HostThinking | undefined {
    return this.hostThinking.get(sessionID);
  }

  /** The approval state the host reports for a session; it publishes a preset, never a rule set. */
  setHostPermission(sessionID: string, permission: HostPermission): void {
    this.hostPermissions.set(sessionID, permission);
    this.changed();
  }

  /**
   * The bridge-side rule set for one session, the document the client reads as
   * `SessionInfo.permissions` (`PermissionRuleset`). It is bridge state: the host has no rule document
   * to project, so nothing here may be reported as a host answer.
   */
  setSessionPermissionRules(sessionID: string, rules: PermissionRuleset): void {
    const previous = this.permissionRules.get(sessionID);
    this.permissionRules.set(sessionID, rules);
    const info = this.hostSessions.get(sessionID);
    if (info !== undefined) {
      const { permissions: replaced, ...rest } = info;
      this.hostSessions.set(sessionID, rules.length === 0 ? (rest as SessionInfo) : { ...rest, permissions: [...rules] });
    }
    this.changed();
    /*
     * The document is bridge state, so the client's own `session.permissions` member is published from
     * here: a subscriber of the client event stream reads the effective rules when they are loaded,
     * replaced, or cleared, and an unchanged set is not re-announced. The event is published after the
     * row above is in place, so a consumer reacting to it re-reads what already landed.
     */
    if (previous !== undefined && samePermissionRules(previous, rules)) return;
    if (previous === undefined && rules.length === 0) return;
    const directory = this.hostSessions.get(sessionID)?.location?.directory;
    this.publishClientEvent(
      sessionPermissionsEvent(sessionID, rules, {
        ...(directory === undefined ? {} : { location: { directory: directory } }),
        sequence: () => this.nextEventSequence(),
      }),
    );
  }

  sessionPermissionRulesFor(sessionID: string): PermissionRuleset {
    return this.permissionRules.get(sessionID) ?? [];
  }

  /** The sessions the bridge holds a rule set for; the document is the only record of them. */
  sessionPermissionRuleSessions(): string[] {
    return [...this.permissionRules.keys()];
  }

  /** The routing handle the host published, resolved back to the durable id the client names. */
  rememberRoutingId(durableId: string, routingId: string): void {
    if (durableId === routingId) return;
    this.routingIds.set(routingId, durableId);
  }

  durableIdForRouting(routingId: string): string | undefined {
    return this.routingIds.get(routingId);
  }

  setPromptAgentRecord(sessionID: string, record: PromptAgentRecord): void {
    this.promptAgents.set(sessionID, record);
    this.changed();
  }

  /** A prompt that never reached the host leaves no translation behind. */
  clearPromptAgentRecord(sessionID: string): void {
    if (!this.promptAgents.delete(sessionID)) return;
    this.changed();
  }

  promptAgentRecordFor(sessionID: string): PromptAgentRecord | undefined {
    return this.promptAgents.get(sessionID);
  }

  hostPermissionFor(sessionID: string): HostPermission | undefined {
    return this.hostPermissions.get(sessionID);
  }

  /**
   * The revert boundary the client staged. It is bridge state, not host state: the host has no staged
   * revert, so `session.get().revert` reports what this map holds and nothing else.
   */
  setHostRevert(sessionID: string, revert: HostRevert | null): void {
    if (revert === null) this.hostReverts.delete(sessionID);
    else this.hostReverts.set(sessionID, revert);
    const info = this.hostSessions.get(sessionID);
    if (info !== undefined) {
      const { revert: removed, ...rest } = info;
      this.hostSessions.set(sessionID, revert === null ? (rest as SessionInfo) : { ...rest, revert: revert });
    }
    this.changed();
  }

  hostRevertFor(sessionID: string): HostRevert | undefined {
    return this.hostReverts.get(sessionID);
  }

  publishEvent(event: unknown): void {
    this.lastEvent = event;
    for (const listener of this.eventListeners) listener(event);
  }

  subscribeEvents(listener: (event: unknown) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * An event derived from host state rather than projected from a frame (`session-diff.ts`). It joins
   * the same client stream, but the projector never sees it: there is no frame to project, and feeding
   * the projector a made-up one would count it as an ignored frame.
   */
  publishClientEvent(event: unknown): void {
    for (const listener of this.clientEventListeners) listener(event);
  }

  subscribeClientEvents(listener: (event: unknown) => void): () => void {
    this.clientEventListeners.add(listener);
    return () => {
      this.clientEventListeners.delete(listener);
    };
  }

  /** The live stream is not replayed, so this only orders the derived events this producer emits. */
  nextEventSequence(): number {
    this.eventSequence += 1;
    return this.eventSequence;
  }

  /** How many live subscribers hold the event fan-out; a stream that ends must leave none behind. */
  eventSubscriberCount(): number {
    return this.eventListeners.size;
  }

  lastPublishedEvent(): unknown {
    return this.lastEvent;
  }

  revision(): number {
    return this.revisionCount;
  }

  /**
   * A live status frame moved a row without a new payload. The roster itself is bridge state, so the
   * readers that draw it need the same signal a payload read gives them.
   */
  statusChanged(): void {
    this.changed();
  }

  private changed(): void {
    this.revisionCount += 1;
    for (const listener of this.listeners) listener();
  }

  location(): BridgeLocationState {
    return this.locationState;
  }

  setLocation(state: BridgeLocationState): void {
    this.locationState = { ...state };
    this.changed();
  }

  mergeLocation(patch: BridgeLocationState): void {
    this.locationState = { ...this.locationState, ...patch };
    this.changed();
  }
  private readonly projector = new MessageProjector();
  /** What the last pull reported per session; the pull is the update channel for title and move. */
  readonly diff = new SessionDiff();
  /** The client-shaped message and part ids minted for this host's entries. */
  readonly ids = new BridgeIdScheme();
  private selected: string | null = null;

  view(): DataView {
    return {
      sessions: [...this.sessions.values()],
      selected: this.selected,
      message: this.projector.snapshot(),
    };
  }

  upsertSession(session: ViewSession): ViewSession {
    this.sessions.set(session.id, session);
    if (this.selected === null) this.selected = session.id;
    return session;
  }

  /* the host payload is kept as received so the TUI can answer with the client type instead of a lossy view */
  upsertHostSession(info: SessionInfo): SessionInfo {
    const rules = this.permissionRules.get(info.id);
    /* A pull replaces the row; the bridge's own rule set is not part of the host payload, so it is
       re-attached here or the client would read a session with no rules right after every pull. */
    const withRules: SessionInfo =
      rules === undefined || rules.length === 0 ? info : { ...info, permissions: [...rules] };
    this.hostSessions.set(info.id, withRules);
    this.changed();
    return withRules;
  }

  removeHostSession(sessionId: string): void {
    this.hostSessions.delete(sessionId);
    this.hostMessages.delete(sessionId);
    this.hostPendingInputs.delete(sessionId);
    this.changed();
  }

  setPendingInputs(sessionId: string, inputs: readonly HostPendingInput[]): void {
    this.hostPendingInputs.set(sessionId, [...inputs]);
    this.changed();
  }

  pendingInputsFor(sessionId: string): HostPendingInput[] {
    return this.hostPendingInputs.get(sessionId) ?? [];
  }

  hostSession(sessionId: string): SessionInfo | undefined {
    return this.hostSessions.get(sessionId);
  }

  hostSessionList(): SessionInfo[] {
    return [...this.hostSessions.values()];
  }

  setHostMessages(sessionId: string, messages: readonly SessionMessageInfo[]): void {
    this.hostMessages.set(sessionId, [...messages]);
    this.changed();
  }

  hostMessagesFor(sessionId: string): SessionMessageInfo[] {
    return this.hostMessages.get(sessionId) ?? [];
  }

  select(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.selected = sessionId;
    return true;
  }

  applyEvent(event: { readonly kind?: unknown; readonly sessionId?: unknown; readonly text?: unknown; readonly title?: unknown }): DataView {
    const kind = typeof event.kind === "string" ? event.kind : "";
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : "";
    if (kind === "session.created" || kind === "session.updated") {
      if (sessionId.length > 0) {
        const existing = this.sessions.get(sessionId);
        this.upsertSession({
          id: sessionId,
          title: typeof event.title === "string" ? event.title : existing?.title ?? sessionId,
          messages: existing?.messages ?? 0,
        });
      }
      return this.view();
    }
    this.projector.apply(event);
    return this.view();
  }
}
