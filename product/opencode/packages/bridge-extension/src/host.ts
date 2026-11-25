/**
 * The host half of the client-MCP seam.
 *
 * The extension API documents `registerMcpServer(name, config)` where the config is the same shape as
 * an `mcpServers` entry (upstream/senpi/packages/coding-agent/src/core/extensions/types.ts:2947 and
 * builtin/mcp/config-schema.ts ServerSchema). A registration is not persisted, so the host registers
 * again on every load; this module only speaks to an injected API object, which keeps it testable and
 * stops it from starting a server of its own.
 */
import { decodeMcpConfig } from "./mcp.ts"
import type { McpServerConfig } from "./mcp.ts"

export type HostMcpApi = {
  readonly registerMcpServer: (name: string, config: unknown) => void
  readonly unregisterMcpServer: (name: string) => void
}

export type HostRegistration =
  | { readonly kind: "registered"; readonly name: string; readonly config: McpServerConfig }
  | { readonly kind: "refused"; readonly message: string }

export function registerSessionServers(
  api: HostMcpApi,
  servers: readonly { readonly name: string; readonly config: unknown }[],
): readonly HostRegistration[] {
  const outcomes: HostRegistration[] = []
  for (const server of servers) {
    const config = decodeMcpConfig(server.config)
    if (config === undefined) {
      outcomes.push({ kind: "refused", message: "server " + server.name + " is not a stdio server" })
      continue
    }
    api.registerMcpServer(server.name, {
      type: config.type,
      command: config.command,
      ...(config.args === undefined ? {} : { args: [...config.args] }),
      ...(config.env === undefined ? {} : { env: { ...config.env } }),
    })
    outcomes.push({ kind: "registered", name: server.name, config: config })
  }
  return outcomes
}

export function unregisterSessionServers(api: HostMcpApi, names: readonly string[]): number {
  let removed = 0
  for (const name of names) {
    api.unregisterMcpServer(name)
    removed += 1
  }
  return removed
}
