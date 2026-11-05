import { join } from "node:path";
import { classifyUiRequest } from "./bridge/ui-requests";
import { resolveConfig, type Config } from "./config";
import { eventBus as sharedEventBus, type EventBus } from "./http/events";
import { setCatalogTransport } from "./http/handlers/catalogs";
import { onDialogFrame, onQuestionFrame, setFormEventBus, setFormTransport } from "./http/handlers/form";
import { onUiRequest, setPermissionEventBus, setPermissionTransport } from "./http/handlers/permission";
import { setSessionWriteTransport } from "./http/handlers/prompt";
import {
  sessionManagementStore,
  setSessionManagementStore,
  setSessionManagementTransport,
} from "./http/handlers/session-write";
import { setSessionReadTransport } from "./http/handlers/sessions";
import { setShellEventBus, setShellTransport, type ShellBashResult } from "./http/handlers/shell";
import { createServer, type BridgeServer } from "./http/server";
import { MAX_LIST_LIMIT, SessionMap } from "./model/session-map";
import { SenpiTransport, defaultKeyRoot } from "./senpi/transport";
import { createLifecycleProjector } from "./translate/lifecycle";
import { createStreamProjector } from "./translate/stream";
import { createToolProjector } from "./translate/tools";
import type { OpenCodeEvent } from "./translate/types";

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
};

export type FrameDispatch = {
  handle: (event: unknown) => void;
};

const FEEDBACK_INPUT_TITLE = "feedback";

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
 */
export function createFrameDispatch(options: FrameDispatchOptions = {}): FrameDispatch {
  const bus = options.bus ?? sharedEventBus;
  const warn = options.warn ?? ((message: string): void => console.warn(`omo-bridge: ${message}`));
  const resolveSessionID = options.resolveSessionID ?? ((routingID: string | undefined) => routingID);
  const defaultSessionID = options.defaultSessionID ?? (() => undefined);

  const projectors = new Map<
    string,
    { stream: ReturnType<typeof createStreamProjector>; tools: ReturnType<typeof createToolProjector>; lifecycle: ReturnType<typeof createLifecycleProjector> }
  >();
  let sequence = 0;

  const sink = (event: OpenCodeEvent): void => {
    bus.publish({ type: event.type, created: event.created, data: event.data });
  };

  const projectorsFor = (sessionID: string) => {
    const existing = projectors.get(sessionID);
    if (existing !== undefined) return existing;
    const ctx = { sessionID, nextID: () => `evt_${++sequence}`, now: () => Date.now() };
    const created = {
      stream: createStreamProjector(ctx, sink),
      tools: createToolProjector(ctx, sink),
      lifecycle: createLifecycleProjector(ctx, sink),
    };
    projectors.set(sessionID, created);
    return created;
  };

  const project = (frame: Record<string, unknown>, sessionID: string): void => {
    const set = projectorsFor(sessionID);
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

  const resolveSessionID = (routingID: string | undefined): string | undefined => {
    if (routingID === undefined) return undefined;
    if (sessionMap.has(routingID)) return routingID;
    const known = sessionMap
      .list({ limit: MAX_LIST_LIMIT, includeArchived: true })
      .data.find((record) => record.routingId === routingID);
    return known?.key;
  };

  const dispatch = createFrameDispatch({
    bus: sharedEventBus,
    resolveSessionID,
    defaultSessionID: () => transport?.sessionId,
  });
  const unsubscribe = transport?.onEvent(dispatch.handle);

  setSessionReadTransport(transport);
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
      setSessionReadTransport(undefined);
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
