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
