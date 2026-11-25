/**
 * Session-scoped client MCP registry for the bridge host extension.
 *
 * The bridge runs the extension in-process with the host session, so a registered MCP server belongs
 * to exactly one session: a request that arrives for another session is refused instead of being
 * served. Nothing here starts a process or writes to a terminal - a write is described first (an
 * exact, byte-for-byte plan) and only performed after the caller echoes the shown content.
 *
 * The shapes follow what the TUI expects from a client MCP server
 * (upstream/opencode/packages/client/src/mcp.ts and packages/tui/src/context/client-mcp.tsx): a
 * registered server is `{ name, config }` with `config.type: "stdio"`.
 */
export type McpServerConfig = {
  readonly type: "stdio"
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}

export type McpRegistration = {
  readonly sessionID: string
  readonly name: string
  readonly config: McpServerConfig
}

export type McpRefusal = "unknown_session" | "duplicate_name" | "invalid_config" | "cross_session"

export type McpRegistrationOutcome =
  | { readonly kind: "registered"; readonly registration: McpRegistration }
  | { readonly kind: "refused"; readonly code: McpRefusal; readonly message: string }

export type McpToolRequest = {
  readonly sessionID: string
  readonly server: string
  readonly tool: string
  readonly input: unknown
  /** The exact text the user must see before a write runs. */
  readonly write?: { readonly content: string }
}

export type McpRequestOutcome =
  | { readonly kind: "queued"; readonly requestId: string; readonly registration: McpRegistration }
  | { readonly kind: "needs_authorization"; readonly requestId: string; readonly shown: string }
  | { readonly kind: "refused"; readonly code: McpRefusal; readonly message: string }

export type McpRegistry = {
  readonly register: (input: { readonly sessionID: string; readonly name: string; readonly config: unknown }) => McpRegistrationOutcome
  readonly unregister: (input: { readonly sessionID: string; readonly name: string }) => boolean
  readonly list: (sessionID: string) => readonly McpRegistration[]
  /** Prepares a request; a write request waits for `authorize` with the same text. */
  readonly request: (input: McpToolRequest) => McpRequestOutcome
  readonly authorize: (requestId: string, shownContent: string) => boolean
  readonly pending: () => readonly string[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null
}

/** Validates a stdio config without inventing defaults: an unknown field is refused, not dropped. */
export function decodeMcpConfig(raw: unknown): McpServerConfig | undefined {
  if (!isRecord(raw)) return undefined
  const type = raw["type"]
  if (type !== "stdio") return undefined
  const command = raw["command"]
  if (typeof command !== "string" || command.length === 0) return undefined
  const args = raw["args"]
  if (args !== undefined) {
    if (!Array.isArray(args)) return undefined
    for (const arg of args) if (typeof arg !== "string") return undefined
  }
  const env = raw["env"]
  if (env !== undefined) {
    if (!isRecord(env)) return undefined
    for (const key of Object.keys(env)) if (typeof env[key] !== "string") return undefined
  }
  return {
    type: "stdio",
    command: command,
    ...(args === undefined ? {} : { args: args.map((arg) => String(arg)) }),
    ...(env === undefined ? {} : { env: copyEnv(env) }),
  }
}

function copyEnv(env: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(env)) {
    const value = env[key]
    if (typeof value === "string") out[key] = value
  }
  return out
}

export function createMcpRegistry(options: {
  readonly sessionID: () => string | null
  readonly nextRequestId: () => string
}): McpRegistry {
  const held = new Map<string, Map<string, McpRegistration>>()
  const waiting = new Map<string, { request: McpToolRequest; shown: string }>()

  const forSession = (sessionID: string): Map<string, McpRegistration> => {
    const existing = held.get(sessionID)
    if (existing !== undefined) return existing
    const created = new Map<string, McpRegistration>()
    held.set(sessionID, created)
    return created
  }

  return {
    register(input) {
      const current = options.sessionID()
      if (current === null) return { kind: "refused", code: "unknown_session", message: "this host connection has no session" }
      if (input.sessionID !== current)
        return { kind: "refused", code: "cross_session", message: "a server can only be registered for the connected session" }
      const config = decodeMcpConfig(input.config)
      if (config === undefined) return { kind: "refused", code: "invalid_config", message: "the MCP config is not a stdio server" }
      const bucket = forSession(current)
      if (bucket.has(input.name))
        return { kind: "refused", code: "duplicate_name", message: "a server with this name is already registered for the session" }
      const registration: McpRegistration = { sessionID: current, name: input.name, config: config }
      bucket.set(input.name, registration)
      return { kind: "registered", registration: registration }
    },
    unregister(input) {
      const bucket = held.get(input.sessionID)
      if (bucket === undefined) return false
      return bucket.delete(input.name)
    },
    list(sessionID) {
      return [...(held.get(sessionID)?.values() ?? [])]
    },
    request(input) {
      const current = options.sessionID()
      if (current === null) return { kind: "refused", code: "unknown_session", message: "this host connection has no session" }
      if (input.sessionID !== current)
        return { kind: "refused", code: "cross_session", message: "the request names another session" }
      const registration = held.get(current)?.get(input.server)
      if (registration === undefined)
        return { kind: "refused", code: "cross_session", message: "no such server is registered for this session" }
      const requestId = options.nextRequestId()
      if (input.write !== undefined) {
        waiting.set(requestId, { request: input, shown: input.write.content })
        return { kind: "needs_authorization", requestId: requestId, shown: input.write.content }
      }
      return { kind: "queued", requestId: requestId, registration: registration }
    },
    authorize(requestId, shownContent) {
      const heldRequest = waiting.get(requestId)
      if (heldRequest === undefined) return false
      if (heldRequest.shown !== shownContent) return false
      waiting.delete(requestId)
      return true
    },
    pending() {
      return [...waiting.keys()]
    },
  }
}
