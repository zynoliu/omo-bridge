/**
 * The host half of the client-MCP seam, as a loadable host extension.
 *
 * An extension is the only thing that can run inside the host session, so this module is what the
 * launcher hands to the host (`--extension <path>`). It carries two directions of one channel:
 *
 *   host -> TUI   `pi.rpc.emit("tui.pack.mcp.request", {requestId, sessionId, server, tool, input})`
 *   TUI -> host   `extension_request {name: "tui.pack.mcp.reply", sessionId, data: {requestId, ...}}`
 *
 * plus two control requests the bridge can drive without a model turn: `bridge.mcp.ping` runs one
 * request/reply round trip and answers with the reply, and `bridge.mcp.register` registers stdio MCP
 * servers through the host API (`registerSessionServers`). Nothing here starts a process itself.
 */
import { registerSessionServers } from "./host.ts";

export const MCP_REQUEST_EVENT = "tui.pack.mcp.request";
export const MCP_REPLY_REQUEST = "tui.pack.mcp.reply";
export const MCP_PING_REQUEST = "bridge.mcp.ping";
export const MCP_REGISTER_REQUEST = "bridge.mcp.register";

/** What this extension uses from the host; the real API object satisfies it structurally. */
export type ExtensionHostApi = {
  readonly rpc: {
    readonly handle: (name: string, handler: (data: unknown) => unknown | Promise<unknown>) => void;
    readonly emit: (name: string, data: unknown) => void;
  };
  readonly registerMcpServer?: (name: string, config: unknown) => void;
  readonly unregisterMcpServer?: (name: string) => void;
};

export type McpReplyRecord = {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
};

export type McpRoundTrip = {
  readonly requestId: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
};

export type McpRegisterReport = {
  readonly registered: readonly string[];
  readonly refused: readonly { readonly name: string; readonly message: string }[];
};

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeReply(data: unknown): McpReplyRecord | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const requestId = text(field(data, "requestId"));
  if (requestId === undefined) return undefined;
  const result = field(data, "result");
  const error = text(field(data, "error"));
  return error === undefined
    ? { requestId: requestId, ok: field(data, "ok") === true, result: result }
    : { requestId: requestId, ok: field(data, "ok") === true, result: result, error: error };
}

function decodeServers(data: unknown): readonly { readonly name: string; readonly config: unknown }[] | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const rows = field(data, "servers");
  if (!Array.isArray(rows)) return undefined;
  const servers: { name: string; config: unknown }[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) return undefined;
    const name = text(field(row, "name"));
    if (name === undefined) return undefined;
    servers.push({ name: name, config: field(row, "config") });
  }
  return servers;
}

export default function bridgeCompanionExtension(api: ExtensionHostApi): void {
  const pending = new Map<
    string,
    { readonly resolve: (reply: McpReplyRecord) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> }
  >();
  let sequence = 0;

  api.rpc.handle(MCP_REPLY_REQUEST, (data) => {
    const reply = decodeReply(data);
    if (reply === undefined) return { accepted: false, reason: "the reply names no request" };
    const waiting = pending.get(reply.requestId);
    if (waiting === undefined) return { accepted: false, reason: "no request is waiting for " + reply.requestId };
    pending.delete(reply.requestId);
    clearTimeout(waiting.timer);
    waiting.resolve(reply);
    return { accepted: true };
  });

  api.rpc.handle(MCP_PING_REQUEST, async (data) => {
    const sessionId = typeof data === "object" && data !== null ? text(field(data, "sessionId")) : undefined;
    sequence += 1;
    const requestId = "ping-" + String(sequence) + "-" + String(Date.now());
    const request = {
      requestId: requestId,
      ...(sessionId === undefined ? {} : { sessionId: sessionId }),
      server: (typeof data === "object" && data !== null ? text(field(data, "server")) : undefined) ?? "tui",
      tool: (typeof data === "object" && data !== null ? text(field(data, "tool")) : undefined) ?? "open_terminal",
      input: typeof data === "object" && data !== null ? field(data, "input") : undefined,
    };
    const answered = new Promise<McpReplyRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("the TUI did not answer " + requestId + " within 10s"));
      }, 10_000);
      pending.set(requestId, { resolve: resolve, reject: reject, timer: timer });
    });
    api.rpc.emit(MCP_REQUEST_EVENT, request);
    try {
      const reply = await answered;
      return { requestId: requestId, ok: reply.ok, ...(reply.result === undefined ? {} : { result: reply.result }), ...(reply.error === undefined ? {} : { error: reply.error }) } satisfies McpRoundTrip;
    } catch (error) {
      return { requestId: requestId, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies McpRoundTrip;
    }
  });

  api.rpc.handle(MCP_REGISTER_REQUEST, (data) => {
    const servers = decodeServers(data);
    if (servers === undefined) return { registered: [], refused: [{ name: "*", message: "servers must be a list of {name, config}" }] };
    const register = api.registerMcpServer;
    const unregister = api.unregisterMcpServer;
    if (register === undefined || unregister === undefined) {
      return {
        registered: [],
        refused: [{ name: "*", message: "this host exposes no registerMcpServer, so a client server cannot be registered" }],
      };
    }
    const outcomes = registerSessionServers({ registerMcpServer: register, unregisterMcpServer: unregister }, servers);
    return {
      registered: outcomes.flatMap((outcome) => (outcome.kind === "registered" ? [outcome.name] : [])),
      refused: outcomes.flatMap((outcome) => (outcome.kind === "refused" ? [{ name: "*", message: outcome.message }] : [])),
    } satisfies McpRegisterReport;
  });
}
