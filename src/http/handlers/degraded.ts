import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { locationRef, type LocationPublicRef } from "./fs-location";

// Degradation shims for endpoint families that have no senpi capability (plan D3).
// Graded rule: reads answer a contract-valid empty value, idempotent writes with nothing to change
// answer 204, and writes that would change visible state answer the endpoint's declared error _tag.
// No handler may answer 5xx or pretend a state change happened.
// Families already answered by catalogs.ts are not duplicated here: agent / skill / reference /
// websearch lists, integration.list, mcp list, mcp.resource catalog, permission.saved list, form.list.

const JSON_CONTENT_TYPE = "application/json";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

function errorResponse(status: number, tag: string, message: string, fields: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { _tag: tag, message, ...fields });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

function segmentAfter(url: URL, marker: string): string {
  const segments = pathSegments(url);
  const at = segments.indexOf(marker);
  return at >= 0 ? (segments[at + 1] ?? "") : "";
}

function attemptIDFrom(url: URL, marker: string): string {
  const segments = pathSegments(url);
  const at = segments.indexOf(marker);
  if (at < 0) return "";
  // The attempt id follows the oauth/command marker; an action such as `complete` may trail it.
  return url.pathname.endsWith("/complete") ? (segments.at(-2) ?? "") : segmentAfter(url, marker);
}

function requestedDirectory(url: URL): string {
  const raw = url.searchParams.get("location[directory]")?.trim();
  if (raw === undefined || raw.length === 0) return process.cwd();
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

// Matches the catalog handlers: a location that does not exist is a 404, never a 5xx.
function locationFor(url: URL): Response | LocationPublicRef {
  const directory = requestedDirectory(url);
  let stats;
  try {
    stats = statSync(directory);
  } catch {
    return errorResponse(404, "FileNotFoundError", `directory not found: ${directory}`, { path: directory });
  }
  if (!stats.isDirectory()) {
    return errorResponse(400, "InvalidRequestError", `not a directory: ${directory}`, { field: "location.directory" });
  }
  return locationRef(directory);
}

export async function handleWorktreeList(_request: Request, _url: URL): Promise<Response> {
  return jsonResponse(200, []);
}

export async function handleWorktreeRefresh(_request: Request, _url: URL): Promise<Response> {
  return noContent();
}

export async function handleWorktreeCreate(_request: Request, _url: URL): Promise<Response> {
  // `WorktreeError` is declared at 400; 409 is not in this endpoint's declaredStatuses.
  return errorResponse(400, "WorktreeError", "worktrees are not supported by the omo-native engine");
}

export async function handleWorktreeRemove(_request: Request, _url: URL): Promise<Response> {
  // DELETE /api/worktree declares WorktreeError at 400 and NoContent at 204. Removing a worktree
  // the bridge never created cannot succeed; the declared error keeps the TUI's failure toast.
  return errorResponse(400, "WorktreeError", "worktrees are not supported by the omo-native engine");
}

export async function handlePluginUpdate(_request: Request, _url: URL): Promise<Response> {
  // No server plugin is loaded, so there is no package target to update; the write is a no-op.
  return noContent();
}

export async function handleSessionStats(_request: Request, _url: URL): Promise<Response> {
  // SessionStats.Info aggregates per-day steps, tool reliability and per-model usage. senpi keeps
  // no such daily ledger, and zeros would claim the user ran nothing. The endpoint declares
  // InvalidRequestError at 400, which is what the TUI renders as "Could not load stats".
  return errorResponse(400, "InvalidRequestError", "session statistics are not available from this bridge", {
    field: "stats",
    kind: "unsupported",
  });
}

export async function handleSessionGenerate(_request: Request, _url: URL): Promise<Response> {
  // `session.generate` runs a transient model call outside the conversation; the bridge has no
  // such host command. Inherited 400 keeps it out of the 5xx band and inside declaredStatuses.
  return errorResponse(400, "InvalidRequestError", "transient session generation is not supported by this bridge", {
    field: "generate",
    kind: "unsupported",
  });
}

export async function handleRpcCall(_request: Request, url: URL): Promise<Response> {
  const segments = pathSegments(url);
  const at = segments.indexOf("rpc");
  const rpcID = at >= 0 ? (segments[at + 1] ?? "") : "";
  const method = at >= 0 ? (segments[at + 2] ?? "") : "";
  // No plugin RPC is registered on this bridge; `RpcError` is declared at 400.
  return errorResponse(400, "RpcError", `no plugin RPC ${rpcID}.${method} is registered on this bridge`, {
    type: "rpc.not_found",
  });
}

export async function handlePersistentPtyList(_request: Request, _url: URL): Promise<Response> {
  // The declared body is {data: PersistentPty.Info[]}, not a location envelope.
  return jsonResponse(200, { data: [] });
}

export async function handlePersistentPtyCreate(_request: Request, _url: URL): Promise<Response> {
  // This endpoint declares InvalidRequestError at 400 and ServiceUnavailableError at 503. The 400
  // keeps a permanent capability gap out of the 5xx band while staying inside declaredStatuses.
  return errorResponse(400, "InvalidRequestError", "persistent terminals are not supported by the omo-native engine", {
    field: "terminal",
    kind: "unsupported",
  });
}

function ptyNotFound(url: URL): Response {
  const ptyID = segmentAfter(url, "persistent-pty");
  return errorResponse(404, "PtyNotFoundError", `persistent terminal ${ptyID} is not available`, { ptyID });
}

export async function handlePersistentPtySnapshot(_request: Request, url: URL): Promise<Response> {
  return ptyNotFound(url);
}

export async function handlePersistentPtyConnectToken(_request: Request, url: URL): Promise<Response> {
  return ptyNotFound(url);
}

export async function handlePersistentPtyConnect(_request: Request, url: URL): Promise<Response> {
  // The attach path: no terminal can exist, so it answers the same declared not-found error as snapshot.
  return ptyNotFound(url);
}

export async function handleMigrationV1Status(_request: Request, _url: URL): Promise<Response> {
  // V1MigrationStatus accepts "completed", which is what keeps the TUI overlay closed.
  return jsonResponse(200, { status: "completed" });
}

function integrationNotFound(url: URL): Response {
  const integrationID = segmentAfter(url, "integration");
  // `IntegrationNotFoundError` is declared at 404; 409 is not in these endpoints' declaredStatuses.
  return errorResponse(404, "IntegrationNotFoundError", `integration ${integrationID} is not available`, {
    integrationID,
  });
}

function attemptNotFound(url: URL, attemptID: string): Response {
  const integrationID = segmentAfter(url, "integration");
  return errorResponse(
    404,
    "IntegrationAttemptNotFoundError",
    `no connect attempt ${attemptID} exists for integration ${integrationID}`,
    { integrationID, attemptID },
  );
}

export async function handleIntegrationConnectKey(_request: Request, url: URL): Promise<Response> {
  return integrationNotFound(url);
}

export async function handleIntegrationConnectExternal(_request: Request, url: URL): Promise<Response> {
  return integrationNotFound(url);
}

export async function handleIntegrationConnectOAuth(_request: Request, url: URL): Promise<Response> {
  return attemptNotFound(url, "");
}

export async function handleIntegrationOAuthStatus(_request: Request, url: URL): Promise<Response> {
  return attemptNotFound(url, attemptIDFrom(url, "oauth"));
}

export async function handleIntegrationOAuthComplete(_request: Request, url: URL): Promise<Response> {
  return attemptNotFound(url, attemptIDFrom(url, "oauth"));
}

export async function handleIntegrationOAuthCancel(_request: Request, _url: URL): Promise<Response> {
  // Cancelling an attempt that cannot exist is an idempotent no-op, not a failed state change.
  return noContent();
}

export async function handleIntegrationCommandConnect(_request: Request, url: URL): Promise<Response> {
  return attemptNotFound(url, "");
}

export async function handleIntegrationCommandStatus(_request: Request, url: URL): Promise<Response> {
  return attemptNotFound(url, attemptIDFrom(url, "command"));
}

export async function handleIntegrationCommandCancel(_request: Request, url: URL): Promise<Response> {
  return attemptNotFound(url, attemptIDFrom(url, "command"));
}

function credentialUnsupported(): Response {
  // credential.* declares InvalidRequestError at 400; 409 is not a declared status there.
  return errorResponse(400, "InvalidRequestError", "integration credentials are not supported by the omo-native engine", {
    kind: "unsupported",
  });
}

export async function handleCredentialActivate(_request: Request, _url: URL): Promise<Response> {
  return credentialUnsupported();
}

export async function handleCredentialUpdate(_request: Request, _url: URL): Promise<Response> {
  return credentialUnsupported();
}

export async function handleCredentialRemove(_request: Request, _url: URL): Promise<Response> {
  return credentialUnsupported();
}

export async function handleServerPair(_request: Request, _url: URL): Promise<Response> {
  // server.pair declares 400/401; 409 is not a declared status for it.
  return errorResponse(400, "InvalidRequestError", "device pairing is not supported by the omo-native engine", {
    kind: "unsupported",
  });
}

export async function handleUsageLimits(_request: Request, url: URL): Promise<Response> {
  const location = locationFor(url);
  if (location instanceof Response) return location;
  return jsonResponse(200, { location, data: null });
}

export async function handleMcpConnect(_request: Request, _url: URL): Promise<Response> {
  return noContent();
}

export async function handleMcpDisconnect(_request: Request, _url: URL): Promise<Response> {
  return noContent();
}
