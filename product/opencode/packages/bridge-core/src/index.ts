export * from "./contracts.ts";
export * from "./transport.ts";
export * from "./sessions.ts";
export * from "./session-diff.ts";
export * from "./id-scheme.ts";
export * from "./stream.ts";
export { HostEventProjector } from "./host-projection.ts";
export type { HostProjectionOptions, HostProjectionStats } from "./host-projection.ts";
export * from "./dialogs.ts";
export * from "./recovery.ts";
export * from "./interaction.ts";
export { BridgeData } from "./data.ts";
export type { DataView, ViewSession } from "./data.ts";
export { BridgeClient, UnsupportedCapability, UNSUPPORTED_CAPABILITY } from "./client.ts";
export type { ClientDependencies } from "./client.ts";
export {
  AGENT_REQUEST_MARKER,
  agentInstruction,
  translatePromptAgentSelection,
} from "./prompt-input.ts";
export type { PromptAgentSelection, PromptTranslation } from "./prompt-input.ts";
export {
  answerForEffect,
  decidePermission,
  loadPermissionRuleDocument,
  matchesRulePattern,
  parsePermissionRuleDocument,
  PERMISSION_DIALOG_TITLE,
  PERMISSION_RULES_FILE,
  permissionAskOfTitle,
  permissionRulesPath,
  PermissionRuleError,
  RULES_DOCUMENT_VERSION,
  ruleMatches,
  SessionPermissionRules,
} from "./permission-rules.ts";
export type {
  PermissionAnswer,
  PermissionAsk,
  PermissionDecision,
  PermissionEffect,
  PermissionRule,
  PermissionRuleChange,
  PermissionRuleDocument,
  PermissionRuleFailureCode,
  PermissionRuleset,
} from "./permission-rules.ts";
export { createInProcessClient } from "./in-process-client.ts";
export type { InProcessClient, InProcessClientOptions } from "./in-process-client.ts";
export { createEventSurface, EventSurfaceError } from "./event-surface.ts";
export type { EventSurface, EventSubscriptionOptions } from "./event-surface.ts";
export { createSessionSurface, SurfaceNotFound } from "./opencode-surface.ts";
export type { SessionSurface } from "./opencode-surface.ts";
export { createPartSurface } from "./part-surface.ts";
export type { PartSurface, ProjectedPart } from "./part-surface.ts";
export { createPtySurface, PtyUnavailable } from "./pty-surface.ts";
export type { PtySurface, PtySurfaceOptions, PtyToken } from "./pty-surface.ts";
export { CLIENT_API_GROUPS, UnimplementedApiGroup, createClientSurfaceStubs, unimplementedGroup } from "./client-surface.ts";
export type { ClientApiGroup, ClientSurfaceStub } from "./client-surface.ts";
export { createBridgeClientGroups } from "./bridge-opencode-client.ts";
export type { BridgeClientDeps, BridgeClientGroups, BridgeConfigGroup, BridgeEventGroup, BridgeSessionGroup } from "./bridge-opencode-client.ts";
export { createBridgeOpencodeApi } from "./opencode-api.ts";
export type { BridgeClientApi, BridgeOpencodeApiDeps, BridgePtySurface } from "./opencode-api.ts";
