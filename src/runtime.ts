import { join } from "node:path";
import { classifyUiRequest } from "./bridge/ui-requests";
import { resolveConfig, type Config } from "./config";
import { eventBus as sharedEventBus, type EventBus } from "./http/events";
import { setCatalogTransport } from "./http/handlers/catalogs";
import { onDialogFrame, onQuestionFrame, setFormEventBus, setFormTransport } from "./http/handlers/form";
import { setSessionInboxTransport, translateUserDelivery } from "./http/handlers/inbox";
import { onUiRequest, setPermissionEventBus, setPermissionTransport } from "./http/handlers/permission";
import { setSessionWriteTransport } from "./http/handlers/prompt";
import {
  sessionManagementStore,
  setSessionManagementStore,
  setSessionManagementTransport,
} from "./http/handlers/session-write";
import { setSessionReadTransport, type SessionReadTransport } from "./http/handlers/sessions";
import { setShellEventBus, setShellTransport, type ShellBashResult } from "./http/handlers/shell";
import { createServer, type BridgeServer } from "./http/server";
import { SessionMap, readSessionUsage, resolveSessionAlias, type SessionUsage } from "./model/session-map";
import { SenpiTransport, defaultKeyRoot } from "./senpi/transport";
import { createLifecycleProjector } from "./translate/lifecycle";
import { createStreamProjector } from "./translate/stream";
import { createToolProjector } from "./translate/tools";
import type { MessageIdentity, OpenCodeEvent } from "./translate/types";

export type BridgeRuntime = {
  config: Config;
  server: BridgeServer;
  transport: SenpiTransport | undefined;
  sessionMap: SessionMap;
  close: () => Promise<void>;
};

export type FrameDispatchOptions = {
  bus?: EventBus;
  resolveSessionID?: (routingID: string | undefined) => string | undefined;
  defaultSessionID?: () => string | undefined;
  warn?: (message: string) => void;
  /** Receives each run's summed usage before the matching event reaches the bus. */
  onUsage?: (sessionID: string, usage: SessionUsage) => void;
  /** Receives a session's new host-assigned title before `session.renamed` is published. */
  onSessionTitle?: (sessionID: string, title: string) => void;
};

export type FrameDispatch = {
  handle: (event: unknown) => void;
};

const FEEDBACK_INPUT_TITLE = "feedback";

/**
 * The session id a host frame answers under.
 *
 * Host frames name a transcript by its durable id or by the connection's routing id. A session whose
 * id the client minted is filed in the map under that id, and the same transcript can also sit in the
 * map under the host's own id. Both name one conversation, and the client only knows the id it asked
 * with, so a frame has to answer that id or the client drops every live frame of its own turn.
 *
 * The admission alias wins because it is the exact pairing the prompt established: the map can still
 * be missing the session, hold it only under the host's id, or page it out of reach.
 */
export function resolveFrameSessionID(sessionMap: SessionMap, routingID: string): string | undefined {
  return resolveSessionAlias(routingID) ?? sessionMap.findByHostId(routingID)?.key;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function frameSessionID(frame: Record<string, unknown>): string | undefined {
  for (const key of ["sessionId", "sessionID"]) {
    const value = asString(frame[key]);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Consumes the transport's event stream: `extension_ui_request` frames become pending permissions
 * and forms, every other frame is projected to opencode events on the shared bus. One projector set
 * per session; a projector that throws is logged and skipped so the subscription keeps running.
 * A run's usage total is handed to `onUsage` before its event is published, so a listener of the
 * event always observes the aggregate already applied.
 */
export function createFrameDispatch(options: FrameDispatchOptions = {}): FrameDispatch {
  const bus = options.bus ?? sharedEventBus;
  const warn = options.warn ?? ((message: string): void => console.warn(`omo-bridge: ${message}`));
  const resolveSessionID = options.resolveSessionID ?? ((routingID: string | undefined) => routingID);
  const defaultSessionID = options.defaultSessionID ?? (() => undefined);
  const onUsage = options.onUsage;
  const onSessionTitle = options.onSessionTitle;

  const projectors = new Map<
    string,
    {
      identity: MessageIdentity;
      stream: ReturnType<typeof createStreamProjector>;
      tools: ReturnType<typeof createToolProjector>;
      lifecycle: ReturnType<typeof createLifecycleProjector>;
    }
  >();
  type ProjectorSet = NonNullable<ReturnType<typeof projectors.get>>;
  // One counter per session: a provisional id only has to be unique within the transcript it is
  // re-keyed into.
  const liveSequences = new Map<string, number>();
  let sequence = 0;

  const sink = (event: OpenCodeEvent): void => {
    if (event.type === "session.usage.updated" && onUsage !== undefined) {
      const usage = readSessionUsage(event.data);
      const sessionID = asString(event.data.sessionID);
      if (usage !== undefined && sessionID !== undefined) {
        try {
          onUsage(sessionID, usage);
        } catch (error) {
          warn(`usage aggregation failed for ${sessionID}: ${messageOf(error)}`);
        }
      }
    }
    bus.publish({ type: event.type, created: event.created, data: event.data });
  };

  const projectorsFor = (sessionID: string) => {
    const existing = projectors.get(sessionID);
    if (existing !== undefined) return existing;
    // One identity object per session, shared by the three projectors: the runtime mints the
    // provisional id, the stream projector re-keys it at the durable entry, and the tool and
    // lifecycle projectors resolve through the same alias map.
    const identity: MessageIdentity = { live: undefined, aliases: new Map() };
    const ctx = { sessionID, nextID: () => `evt_${++sequence}`, now: () => Date.now(), identity };
    const created = {
      identity,
      stream: createStreamProjector(ctx, sink),
      tools: createToolProjector(ctx, sink),
      lifecycle: createLifecycleProjector(ctx, sink),
    };
    projectors.set(sessionID, created);
    return created;
  };

  const project = (frame: Record<string, unknown>, sessionID: string): void => {
    // Delivery of a client's own prompt is reported before the step that answers it, so publishing
    // here keeps the client's pending row from outliving the turn that clears it.
    for (const delivered of translateUserDelivery(frame, sessionID)) {
      bus.publish({ type: delivered.type, created: delivered.created, data: delivered.data });
    }
    const set = projectorsFor(sessionID);
    // The host opens an assistant step before it has an id and names it only when the durable entry
    // lands. Minting a provisional id lets the deltas reach the bus immediately; `entry_appended`
    // re-keys the step to the durable id (stream.ts), so the live row and the row a refetch serves
    // are the same message.
    const message = frame.type === "message_start" ? asRecord(frame.message) : undefined;
    const declaredID = message === undefined ? undefined : asString(message.id);
    if (message?.role === "assistant" && (declaredID === undefined || declaredID.trim().length === 0)) {
      const ordinal = (liveSequences.get(sessionID) ?? 0) + 1;
      liveSequences.set(sessionID, ordinal);
      const provisional = `msg_live_${ordinal}`;
      message.id = provisional;
      set.identity.live = provisional;
    }
    dispatchFrame(frame, set, sessionID);
  };

  const dispatchFrame = (
    frame: Record<string, unknown>,
    set: ProjectorSet,
    sessionID: string,
  ): void => {
    const entries = [
      ["stream", set.stream],
      ["tools", set.tools],
      ["lifecycle", set.lifecycle],
    ] as const;
    for (const [name, projector] of entries) {
      try {
        projector.handle(frame);
      } catch (error) {
        warn(`${name} projector failed for ${sessionID}: ${messageOf(error)}`);
      }
    }
  };

  const dispatchUiRequest = async (frame: Record<string, unknown>): Promise<void> => {
    try {
      const classification = classifyUiRequest(frame);
      if (classification.kind === "status") return;
      const routingID = frameSessionID(frame) ?? defaultSessionID();
      const sessionID = resolveSessionID(routingID) ?? routingID;
      if (classification.kind === "permission") {
        await onUiRequest(frame, sessionID);
        return;
      }
      if (classification.kind === "question") {
        onQuestionFrame(frame, sessionID);
        return;
      }
      const title = asString(frame.title)?.trim().toLowerCase();
      if (classification.form.method === "input" && title === FEEDBACK_INPUT_TITLE) {
        await onUiRequest(frame, sessionID);
        return;
      }
      onDialogFrame(frame, sessionID);
    } catch (error) {
      warn(`extension_ui_request dispatch failed: ${messageOf(error)}`);
    }
  };

  /**
   * The host names a session after the run whose auto-title produced it, and reports the name as one
   * `session_info_changed` frame (`name`, host `agent-session`). A frame without a name is not a
   * rename - the host also sends this frame for a session it could not name - so it publishes
   * nothing. The id is the resolved client-facing one, never the host's routing handle.
   */
  const publishSessionTitle = (sessionID: string, title: string): void => {
    if (onSessionTitle !== undefined) {
      try {
        onSessionTitle(sessionID, title);
      } catch (error) {
        warn(`session title update failed for ${sessionID}: ${messageOf(error)}`);
      }
    }
    bus.publish({ type: "session.renamed", data: { sessionID, title } });
  };

  const handle = (event: unknown): void => {
    const frame = asRecord(event);
    const type = frame === undefined ? undefined : asString(frame.type);
    if (frame === undefined || type === undefined) return;
    if (type === "extension_ui_request") {
      void dispatchUiRequest(frame);
      return;
    }
    const routingID = frameSessionID(frame) ?? defaultSessionID();
    const sessionID = resolveSessionID(routingID) ?? routingID;
    if (sessionID === undefined) return;
    if (type === "session_info_changed") {
      const title = asString(frame.name)?.trim();
      if (title !== undefined && title.length > 0) publishSessionTitle(sessionID, title);
      return;
    }
    project(frame, sessionID);
  };

  return { handle };
}

function bashOverRaw(transport: SenpiTransport): (command: string) => Promise<ShellBashResult> {
  return (command: string) => transport.raw.request<ShellBashResult>({ type: "bash", command });
}

export type ModelAvailability = { models: number; providers: number };

export type ModelProbeOptions = {
  log?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Reports what the private host's model catalog actually holds. The host reads `models.json` from
 * its agent directory, so a catalog of zero means the host was pointed somewhere without the user's
 * configuration - the one failure that leaves the TUI with no model to select. Returns undefined
 * when the host could not answer at all; a probe never fails the bridge's startup.
 */
export async function probeModelAvailability(
  transport: Pick<SenpiTransport, "getAvailableModels">,
  options: ModelProbeOptions = {},
): Promise<ModelAvailability | undefined> {
  const log = options.log ?? ((message: string): void => console.log(message));
  const warn = options.warn ?? ((message: string): void => console.warn(message));
  let models: readonly { provider?: unknown }[];
  try {
    models = await transport.getAvailableModels();
  } catch (error) {
    warn(`omo-bridge: could not read the model catalog from the private host: ${messageOf(error)}`);
    return undefined;
  }
  const providers = new Set<string>();
  for (const model of models) {
    if (typeof model.provider === "string" && model.provider.length > 0) providers.add(model.provider);
  }
  log(`omo-bridge: models=${models.length} providers=${providers.size}`);
  if (models.length === 0) {
    warn(
      "omo-bridge: the private host reports no models; set OMO_BRIDGE_AGENT_DIR to the agent directory that holds the real models.json (default ~/.omo/agent)",
    );
  }
  return { models: models.length, providers: providers.size };
}

const CATALOG_SESSION_FILE = "model-catalog.jsonl";

/**
 * `get_available_models` is session-scoped on the senpi wire, so a connection that holds no session
 * cannot answer `GET /api/model` at all - the read the TUI performs before it has a model to offer.
 * Keep one bridge-private session for that read: its transcript lives in the bridge state directory,
 * never in the user's agent directory, and it is released on disconnect so the private host still
 * stops cleanly. Opening a session from the user's own store would append resume bookkeeping to a
 * transcript the bridge does not own, which this deliberately avoids.
 */
async function attachCatalogSession(transport: SenpiTransport, stateDir: string): Promise<void> {
  await transport.openSession({
    sessionPath: join(stateDir, CATALOG_SESSION_FILE),
    cwd: stateDir,
    retainOnDisconnect: false,
  });
}

/**
 * Reads must not move the write attachment. The host generates a session's auto-title in the window
 * after its turn settles, and that generation dies when the connection holding the session loses it,
 * so a read of another session takes the second connection and a read of the session the write side
 * already holds answers from that same attachment instead of attaching again (which would steal it).
 */
function createReadRouter(
  write: SenpiTransport | undefined,
  read: SenpiTransport | undefined,
  sessionMap: SessionMap,
): SessionReadTransport | undefined {
  if (write === undefined) return read;
  if (read === undefined) return write;
  let active: SenpiTransport = write;
  const heldPath = (): string | undefined => {
    const routingId = write.sessionId;
    if (routingId === undefined) return undefined;
    return sessionMap.list({ limit: 1000 }).data.find((record) => record.routingId === routingId)?.sessionPath;
  };
  return {
    get sessionId(): string | undefined {
      return active.sessionId;
    },
    get streaming(): boolean {
      return active.streaming;
    },
    listSessions: () => read.listSessions(),
    getState: () => active.getState(),
    getEntries: (since, page) => active.getEntries(since, page),
    getMessages: () => active.getMessages(),
    waitForIdle: (timeout) => active.waitForIdle(timeout),
    async openSession(options) {
      if (options?.sessionPath !== undefined && options.sessionPath === heldPath()) {
        active = write;
        const state = await write.getState();
        return { sessionId: write.sessionId ?? "", state };
      }
      active = read;
      return read.openSession(options);
    },
  };
}

/** Without OMO_BRIDGE_SENPI_SOCKET the server still starts and session routes answer 503. */
export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<BridgeRuntime> {
  const config = resolveConfig(env);
  const agentDir = defaultKeyRoot(env);
  const socketPath = env.OMO_BRIDGE_SENPI_SOCKET?.trim();

  let transport: SenpiTransport | undefined;
  if (socketPath !== undefined && socketPath.length > 0) {
    const candidate = new SenpiTransport({ socketPath, keyRoot: agentDir });
    try {
      // connect() also declares this client's width and capabilities (setClientInfo).
      await candidate.connect();
      transport = candidate;
    } catch (error) {
      await candidate.dispose().catch(() => undefined);
      console.warn(`omo-bridge: senpi transport not connected (${socketPath}): ${messageOf(error)}`);
    }
  }

  let readTransport: SenpiTransport | undefined;
  if (socketPath !== undefined && socketPath.length > 0) {
    const candidate = new SenpiTransport({ socketPath, keyRoot: agentDir });
    try {
      await candidate.connect();
      readTransport = candidate;
    } catch (error) {
      await candidate.dispose().catch(() => undefined);
      console.warn(`omo-bridge: read transport not connected (${socketPath}): ${messageOf(error)}`);
    }
  }

  const sessionMap = SessionMap.open({ stateDir: config.stateDir, agentDir });
  if (transport !== undefined) {
    try {
      const rows = await transport.listSessions();
      for (const row of rows) sessionMap.upsert(row);
      sessionMap.flush();
    } catch (error) {
      console.warn(`omo-bridge: could not seed the session map from senpi: ${messageOf(error)}`);
    }
    try {
      await attachCatalogSession(transport, config.stateDir);
    } catch (error) {
      console.warn(`omo-bridge: could not attach the model catalog session: ${messageOf(error)}`);
    }
    await probeModelAvailability(transport);
  }

  const resolutionCache = new Map<string, string | undefined>();
  const resolveSessionID = (routingID: string | undefined): string | undefined => {
    if (routingID === undefined) return undefined;
    if (resolutionCache.has(routingID)) return resolutionCache.get(routingID);
    const resolved = resolveFrameSessionID(sessionMap, routingID);
    // An unresolved id is not remembered: a session filed a moment later still has to answer.
    if (resolved !== undefined) resolutionCache.set(routingID, resolved);
    return resolved;
  };

  const dispatch = createFrameDispatch({
    bus: sharedEventBus,
    resolveSessionID,
    defaultSessionID: () => transport?.sessionId,
    onUsage: (sessionID, usage) => {
      sessionMap.addUsage(sessionID, usage);
      try {
        sessionMap.flush();
      } catch (error) {
        console.warn(`omo-bridge: could not persist usage for ${sessionID}: ${messageOf(error)}`);
      }
    },
    onSessionTitle: (sessionID, title) => {
      // The host renamed the session itself; the map is the bridge's own copy of that title, so a
      // later GET /api/session and the persisted state both answer with it.
      sessionMap.rename(sessionID, title);
      try {
        sessionMap.flush();
      } catch (error) {
        console.warn(`omo-bridge: could not persist the title for ${sessionID}: ${messageOf(error)}`);
      }
    },
  });
  const unsubscribe = transport?.onEvent(dispatch.handle);

  setSessionReadTransport(createReadRouter(transport, readTransport, sessionMap));
  setSessionInboxTransport(transport);
  setSessionWriteTransport(transport);
  setCatalogTransport(transport);
  setPermissionTransport(transport);
  setPermissionEventBus(sharedEventBus);
  setFormTransport(transport);
  setFormEventBus(sharedEventBus);
  setSessionManagementTransport(transport);
  setSessionManagementStore(sessionManagementStore(sessionMap));
  setShellTransport(transport === undefined ? undefined : { bash: bashOverRaw(transport) });
  setShellEventBus(sharedEventBus);

  const server = createServer(config);

  let closed = false;
  return {
    config,
    server,
    transport,
    sessionMap,
    close: async () => {
      if (closed) return;
      closed = true;
      unsubscribe?.();
      await readTransport?.dispose().catch(() => undefined);
      setSessionReadTransport(undefined);
      setSessionInboxTransport(undefined);
      setSessionWriteTransport(undefined);
      setCatalogTransport(undefined);
      setPermissionTransport(undefined);
      setPermissionEventBus(undefined);
      setFormTransport(undefined);
      setFormEventBus(undefined);
      setSessionManagementTransport(undefined);
      setSessionManagementStore(undefined);
      setShellTransport(undefined);
      setShellEventBus(undefined);
      try {
        await transport?.dispose();
      } finally {
        server.stop(true);
      }
    },
  };
}
