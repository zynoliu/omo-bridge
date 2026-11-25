export { createMcpRegistry, decodeMcpConfig } from "./mcp.ts"
export type { McpRegistration, McpRegistrationOutcome, McpRegistry, McpRequestOutcome, McpServerConfig, McpToolRequest } from "./mcp.ts"
export { registerSessionServers, unregisterSessionServers } from "./host.ts"
export type { HostMcpApi, HostRegistration } from "./host.ts"
export { default as bridgeCompanionExtension } from "./extension.ts"
export {
  MCP_PING_REQUEST,
  MCP_REGISTER_REQUEST,
  MCP_REPLY_REQUEST,
  MCP_REQUEST_EVENT,
} from "./extension.ts"
export type { ExtensionHostApi, McpRegisterReport, McpReplyRecord, McpRoundTrip } from "./extension.ts"
