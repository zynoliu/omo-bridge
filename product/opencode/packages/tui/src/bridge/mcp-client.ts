/**
 * The TUI side of the client-MCP channel.
 *
 * The extension asks the TUI to run one MCP tool call by publishing a `tui.pack.mcp.request`
 * extension event carrying a bounded request id; the TUI answers with an `extension_request` named
 * `tui.pack.mcp.reply`. An id is answered at most once: a replayed request after a reconnect is
 * recognised and not re-sent, which is what keeps a terminal write from happening twice.
 */
import type { BridgeData } from "../../../bridge-core/src/data.ts";
import { decodeHostExtensionFrame } from "../../../bridge-core/src/host-extension-frames.ts";

export type McpRequest = {
  readonly requestId: string
  readonly sessionID: string | undefined
  readonly server: string
  readonly tool: string
  readonly input: unknown
}

export type McpReply = {
  readonly requestId: string
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
}

export type McpToolExecutor = (request: McpRequest) => Promise<{ readonly result: unknown } | { readonly error: string }>

export type McpClientOptions = {
  readonly execute: McpToolExecutor
  readonly onError?: (message: string) => void
  /**
   * Maps the session identity the extension names to the routing handle this connection addresses.
   * A multi-session host requires `sessionId` on an `extension_request`, and only the launcher knows
   * which routing handle belongs to a durable id.
   */
  readonly routeSession?: (sessionID: string) => string | undefined
}

export type McpClient = {
  /** Requests seen this connection, newest last, so a reconnect can reconcile rather than replay blind. */
  readonly seen: () => readonly string[]
  /**
   * The ids already answered, which is what a reconnect hands back so the extension can tell a replay
   * from a new request. The exchange itself is the caller's: this module does not invent a frame name
   * for a snapshot the host has not documented.
   */
  readonly snapshot: () => readonly string[]
  /** Marks ids as already answered without executing them, which is what prevents a double write. */
  readonly restore: (ids: readonly string[]) => number
  readonly stop: () => void
}

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key]
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

/** Reads one `tui.pack.mcp.request` payload; a malformed request is reported, never partly executed. */
export function decodeMcpRequest(raw: unknown): McpRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const requestId = text(field(raw, "requestId"))
  const server = text(field(raw, "server"))
  const tool = text(field(raw, "tool"))
  if (requestId === undefined || server === undefined || tool === undefined) return undefined
  return {
    requestId: requestId,
    sessionID: text(field(raw, "sessionId")),
    server: server,
    tool: tool,
    input: field(raw, "input"),
  }
}

export function connectBridgeMcp(data: BridgeData, options: McpClientOptions): McpClient {
  const answered = new Set<string>()
  const order: string[] = []
  const stop = data.subscribeEvents((frame) => {
    const decoded = decodeHostExtensionFrame(frame)
    if (!decoded.ok || decoded.frame.kind !== "extension_event") return
    if (decoded.frame.name !== "tui.pack.mcp.request") return
    const request = decodeMcpRequest(decoded.frame.data)
    if (request === undefined) {
      options.onError?.("a client MCP request was malformed and was not executed")
      return
    }
    if (answered.has(request.requestId)) return
    answered.add(request.requestId)
    order.push(request.requestId)
    void options
      .execute(request)
      .then((outcome) => {
        const reply: McpReply =
          "error" in outcome
            ? { requestId: request.requestId, ok: false, error: outcome.error }
            : { requestId: request.requestId, ok: true, result: outcome.result }
        const routed =
          request.sessionID === undefined ? undefined : (options.routeSession?.(request.sessionID) ?? request.sessionID)
        return data.requestExtension("mcp-reply-" + request.requestId, {
          type: "extension_request",
          name: "tui.pack.mcp.reply",
          ...(routed === undefined ? {} : { sessionId: routed }),
          data: reply,
        })
      })
      .catch((error: unknown) => {
        options.onError?.(error instanceof Error ? error.message : String(error))
      })
  })

  return {
    seen: () => order,
    snapshot: () => order.slice(),
    restore(ids) {
      let restored = 0
      for (const id of ids) {
        if (answered.has(id)) continue
        answered.add(id)
        order.push(id)
        restored += 1
      }
      return restored
    },
    stop: stop,
  }
}
