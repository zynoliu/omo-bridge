import type { Route, RouteContext } from "../router";
import {
  handleAgentList,
  handleCommandList,
  handleIntegrationList,
  handleMcpList,
  handleMcpResourceCatalog,
  handleModelDefault,
  handleModelList,
  handlePermissionSavedList,
  handlePluginCheck,
  handlePluginList,
  handleProviderList,
  handleReferenceList,
  handleSessionSwitchAgent,
  handleSessionSwitchModel,
  handleSkillList,
  handleWebsearchProviders,
} from "../handlers/catalogs";
import {
  handleCredentialActivate,
  handleCredentialRemove,
  handleCredentialUpdate,
  handleIntegrationCommandCancel,
  handleIntegrationCommandConnect,
  handleIntegrationCommandStatus,
  handleIntegrationConnectExternal,
  handleIntegrationConnectKey,
  handleIntegrationConnectOAuth,
  handleIntegrationOAuthCancel,
  handleIntegrationOAuthComplete,
  handleIntegrationOAuthStatus,
  handleMcpConnect,
  handleMcpDisconnect,
  handleMigrationV1Status,
  handlePersistentPtyConnect,
  handlePersistentPtyConnectToken,
  handlePersistentPtyCreate,
  handlePersistentPtyList,
  handlePersistentPtySnapshot,
  handlePluginUpdate,
  handleRpcCall,
  handleServerPair,
  handleSessionGenerate,
  handleSessionStats,
  handleUsageLimits,
  handleWorktreeCreate,
  handleWorktreeList,
  handleWorktreeRefresh,
  handleWorktreeRemove,
} from "../handlers/degraded";
import {
  handleFormCancel,
  handleFormCreate,
  handleFormList,
  handleFormReply,
  handleSessionFormList,
} from "../handlers/form";
import {
  handleConfigGet,
  handleFsFind,
  handleFsList,
  handleFsRead,
  handleLocationGet,
  handleLocationReload,
  handleProjectList,
  handleVcsBase,
  handleVcsBranch,
  handleVcsDiff,
  handleVcsGet,
  handleVcsStatus,
} from "../handlers/fs-location";
import {
  handleSessionBackground,
  handleSessionInboxCancel,
  handleSessionInboxList,
  handleSessionInboxUpdate,
  handleSessionInterrupt,
} from "../handlers/inbox";
import { mediaRoute } from "../handlers/media";
import { handlePermissionCreate, handlePermissionList, handlePermissionReply } from "../handlers/permission";
import {
  handleSessionCommand,
  handleSessionCreate,
  handleSessionPrompt,
  handleSessionSynthetic,
} from "../handlers/prompt";
import {
  handleSessionCompact,
  handleSessionEnvironment,
  handleSessionFork,
  handleSessionMove,
  handleSessionRemove,
  handleSessionRevertClear,
  handleSessionRevertCommit,
  handleSessionRevertStage,
  handleSessionUpdate,
} from "../handlers/session-write";
import {
  handleSessionActive,
  handleSessionDiff,
  handleSessionExport,
  handleSessionGet,
  handleSessionList,
  handleSessionLog,
  handleSessionMessageGet,
  handleSessionMessages,
  handleSessionView,
  handleSessionWait,
} from "../handlers/sessions";
import { handleSessionShell, handleShellGet, handleShellList, handleShellOutput, handleShellRemove } from "../handlers/shell";
import { eventRoute } from "./events";

type Handler = (request: Request, url: URL) => Response | Promise<Response>;

// Handlers take (request, url); the router passes a context.
function route(method: Route["method"], path: string, handler: Handler): Route {
  return { method, path, handler: (context: RouteContext) => handler(context.request, context.url) };
}

export const fsLocationRoutes: Route[] = [
  route("GET", "/api/fs/list", handleFsList),
  route("GET", "/api/fs/find", handleFsFind),
  // `fs.read` declares `/api/fs/read/*`; the wildcard captures a nested relative path.
  route("GET", "/api/fs/read/*", handleFsRead),
  route("GET", "/api/location", handleLocationGet),
  route("POST", "/api/location/reload", handleLocationReload),
  route("GET", "/api/project", handleProjectList),
  route("GET", "/api/config", handleConfigGet),
  route("GET", "/api/vcs", handleVcsGet),
  route("GET", "/api/vcs/base", handleVcsBase),
  route("GET", "/api/vcs/status", handleVcsStatus),
  route("GET", "/api/vcs/branch", handleVcsBranch),
  route("GET", "/api/vcs/diff", handleVcsDiff),
];

// /api/session/active is registered before the :sessionID pattern: the router takes the first
// path match, so the static route has to win or "active" would be read as a session id.
export const sessionRoutes: Route[] = [
  route("GET", "/api/session", handleSessionList),
  route("POST", "/api/session", handleSessionCreate),
  route("GET", "/api/session/active", handleSessionActive),
  route("GET", "/api/session/:sessionID", handleSessionGet),
  route("PATCH", "/api/session/:sessionID", handleSessionUpdate),
  route("DELETE", "/api/session/:sessionID", handleSessionRemove),
  route("POST", "/api/session/:sessionID/prompt", handleSessionPrompt),
  route("POST", "/api/session/:sessionID/synthetic", handleSessionSynthetic),
  route("POST", "/api/session/:sessionID/command", handleSessionCommand),
  route("POST", "/api/session/:sessionID/fork", handleSessionFork),
  route("POST", "/api/session/:sessionID/move", handleSessionMove),
  route("POST", "/api/session/:sessionID/compact", handleSessionCompact),
  route("POST", "/api/session/:sessionID/revert/stage", handleSessionRevertStage),
  route("DELETE", "/api/session/:sessionID/revert", handleSessionRevertClear),
  route("POST", "/api/session/:sessionID/revert/commit", handleSessionRevertCommit),
  route("PUT", "/api/session/:sessionID/environment", handleSessionEnvironment),
  route("POST", "/api/session/:sessionID/model", handleSessionSwitchModel),
  route("POST", "/api/session/:sessionID/agent", handleSessionSwitchAgent),
  route("GET", "/api/session/:sessionID/message", handleSessionMessages),
  route("GET", "/api/session/:sessionID/message/:messageID", handleSessionMessageGet),
  // The inbox family owns the static `inbox` segment at the same depth as `message`, so no
  // :sessionID sub-path pattern can shadow it; static routes such as /api/session/active stay first.
  route("POST", "/api/session/:sessionID/interrupt", handleSessionInterrupt),
  route("POST", "/api/session/:sessionID/background", handleSessionBackground),
  route("GET", "/api/session/:sessionID/inbox", handleSessionInboxList),
  route("DELETE", "/api/session/:sessionID/inbox/:inboxID", handleSessionInboxCancel),
  route("PATCH", "/api/session/:sessionID/inbox/:inboxID", handleSessionInboxUpdate),
  route("GET", "/api/session/:sessionID/diff", handleSessionDiff),
  route("POST", "/api/session/:sessionID/view", handleSessionView),
  route("GET", "/api/experimental/session/:sessionID/export", handleSessionExport),
  route("POST", "/api/session/:sessionID/generate", handleSessionGenerate),
  route("POST", "/api/experimental/session/:sessionID/wait", handleSessionWait),
  route("GET", "/api/experimental/session/:sessionID/log", handleSessionLog),
];

// Interaction surfaces: permission prompts, forms and the shell command table.
export const interactionRoutes: Route[] = [
  route("POST", "/api/session/:sessionID/permission", handlePermissionCreate),
  route("GET", "/api/session/:sessionID/permission", handlePermissionList),
  route("POST", "/api/session/:sessionID/permission/:requestID/reply", handlePermissionReply),
  route("POST", "/api/session/:sessionID/form", handleFormCreate),
  route("GET", "/api/session/:sessionID/form", handleSessionFormList),
  route("POST", "/api/session/:sessionID/form/:formID/reply", handleFormReply),
  route("DELETE", "/api/session/:sessionID/form/:formID", handleFormCancel),
  route("GET", "/api/form", handleFormList),
  route("POST", "/api/session/:sessionID/shell", handleSessionShell),
  route("GET", "/api/shell", handleShellList),
  route("GET", "/api/shell/:id", handleShellGet),
  route("GET", "/api/shell/:id/output", handleShellOutput),
  route("DELETE", "/api/shell/:id", handleShellRemove),
];

// Startup catalog reads. Families with no senpi capability answer contract-valid empties.
export const catalogRoutes: Route[] = [
  route("GET", "/api/model", handleModelList),
  route("GET", "/api/model/default", handleModelDefault),
  route("GET", "/api/provider", handleProviderList),
  route("GET", "/api/agent", handleAgentList),
  route("GET", "/api/command", handleCommandList),
  route("GET", "/api/skill", handleSkillList),
  route("GET", "/api/reference", handleReferenceList),
  route("GET", "/api/mcp", handleMcpList),
  route("GET", "/api/mcp/resource", handleMcpResourceCatalog),
  route("GET", "/api/integration", handleIntegrationList),
  route("GET", "/api/plugin", handlePluginList),
  route("POST", "/api/plugin/check", handlePluginCheck),
  route("POST", "/api/plugin/update", handlePluginUpdate),
  route("GET", "/api/websearch/provider", handleWebsearchProviders),
  route("GET", "/api/permission/saved", handlePermissionSavedList),
];

// Endpoint families senpi cannot back (plan D3). Reads answer an empty value, idempotent writes
// answer 204, and writes that would change visible state answer the endpoint's declared error.
export const degradationRoutes: Route[] = [
  route("GET", "/api/worktree", handleWorktreeList),
  route("DELETE", "/api/worktree", handleWorktreeRemove),
  route("POST", "/api/worktree/refresh", handleWorktreeRefresh),
  route("POST", "/api/worktree", handleWorktreeCreate),
  route("GET", "/api/experimental/session/stats", handleSessionStats),
  route("POST", "/api/rpc/:rpcID/:method", handleRpcCall),
  route("GET", "/api/experimental/session/:sessionID/terminal", handlePersistentPtyList),
  route("POST", "/api/experimental/session/:sessionID/terminal", handlePersistentPtyCreate),
  route("GET", "/api/experimental/persistent-pty/:ptyID/snapshot", handlePersistentPtySnapshot),
  route("GET", "/api/experimental/persistent-pty/:ptyID/connect", handlePersistentPtyConnect),
  route("POST", "/api/experimental/persistent-pty/:ptyID/connect-token", handlePersistentPtyConnectToken),
  route("GET", "/api/experimental/migration/v1", handleMigrationV1Status),
  route("POST", "/api/integration/:integrationID/connect/key", handleIntegrationConnectKey),
  route("POST", "/api/integration/:integrationID/connect/external", handleIntegrationConnectExternal),
  route("POST", "/api/integration/:integrationID/connect/oauth", handleIntegrationConnectOAuth),
  route("GET", "/api/integration/:integrationID/connect/oauth/:attemptID", handleIntegrationOAuthStatus),
  route("POST", "/api/integration/:integrationID/connect/oauth/:attemptID/complete", handleIntegrationOAuthComplete),
  route("DELETE", "/api/integration/:integrationID/connect/oauth/:attemptID", handleIntegrationOAuthCancel),
  route("POST", "/api/integration/:integrationID/connect/command", handleIntegrationCommandConnect),
  route("GET", "/api/integration/:integrationID/connect/command/:attemptID", handleIntegrationCommandStatus),
  route("DELETE", "/api/integration/:integrationID/connect/command/:attemptID", handleIntegrationCommandCancel),
  route("POST", "/api/credential/:credentialID/activate", handleCredentialActivate),
  route("PATCH", "/api/credential/:credentialID", handleCredentialUpdate),
  route("DELETE", "/api/credential/:credentialID", handleCredentialRemove),
  route("POST", "/api/pair", handleServerPair),
  route("GET", "/api/experimental/usage/limits", handleUsageLimits),
  route("POST", "/api/experimental/mcp/:server/connect", handleMcpConnect),
  route("POST", "/api/experimental/mcp/:server/disconnect", handleMcpDisconnect),
];

export const routes: Route[] = [
  eventRoute,
  ...fsLocationRoutes,
  ...sessionRoutes,
  ...interactionRoutes,
  ...catalogRoutes,
  ...degradationRoutes,
  mediaRoute,
];
