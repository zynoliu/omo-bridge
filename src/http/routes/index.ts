import type { Route, RouteContext } from "../router";
import {
  handleConfigGet,
  handleFsFind,
  handleFsList,
  handleLocationGet,
  handleProjectList,
  handleVcsBase,
  handleVcsDiff,
  handleVcsGet,
} from "../handlers/fs-location";
import {
  handleSessionActive,
  handleSessionDiff,
  handleSessionGet,
  handleSessionInboxList,
  handleSessionList,
  handleSessionLog,
  handleSessionMessageGet,
  handleSessionMessages,
  handleSessionView,
  handleSessionWait,
} from "../handlers/sessions";
import { eventRoute } from "./events";

type Handler = (request: Request, url: URL) => Response | Promise<Response>;

// Handlers take (request, url); the router passes a context.
function route(method: Route["method"], path: string, handler: Handler): Route {
  return { method, path, handler: (context: RouteContext) => handler(context.request, context.url) };
}

export const fsLocationRoutes: Route[] = [
  route("GET", "/api/fs/list", handleFsList),
  route("GET", "/api/fs/find", handleFsFind),
  route("GET", "/api/location", handleLocationGet),
  route("GET", "/api/project", handleProjectList),
  route("GET", "/api/config", handleConfigGet),
  route("GET", "/api/vcs", handleVcsGet),
  route("GET", "/api/vcs/base", handleVcsBase),
  route("GET", "/api/vcs/diff", handleVcsDiff),
];

// /api/session/active is registered before the :sessionID pattern: the router takes the first
// path match, so the static route has to win or "active" would be read as a session id.
export const sessionRoutes: Route[] = [
  route("GET", "/api/session", handleSessionList),
  route("GET", "/api/session/active", handleSessionActive),
  route("GET", "/api/session/:sessionID", handleSessionGet),
  route("GET", "/api/session/:sessionID/message", handleSessionMessages),
  route("GET", "/api/session/:sessionID/message/:messageID", handleSessionMessageGet),
  route("GET", "/api/session/:sessionID/inbox", handleSessionInboxList),
  route("GET", "/api/session/:sessionID/diff", handleSessionDiff),
  route("POST", "/api/session/:sessionID/view", handleSessionView),
  route("POST", "/api/experimental/session/:sessionID/wait", handleSessionWait),
  route("GET", "/api/experimental/session/:sessionID/log", handleSessionLog),
];

export const routes: Route[] = [eventRoute, ...fsLocationRoutes, ...sessionRoutes];
