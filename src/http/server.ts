import { createHash, timingSafeEqual } from "node:crypto";
import { hostname, tmpdir } from "node:os";
import pkg from "../../package.json";
import type { Config } from "../config";
import { validateResponse } from "../contract/validate";
import { createRouter } from "./router";
import { routes } from "./routes";

/** The opencode version the TUI expects, so it does not warn about a protocol mismatch. */
export const BRIDGE_PROTOCOL_VERSION = "2.2.5";

/** The bridge package's own version, read from package.json so the header cannot drift from it. */
export const BRIDGE_VERSION: string = pkg.version;

const VERSION_HEADER = "x-omo-bridge-version";

/** `OMO_BRIDGE_DEBUG_REQUESTS=1` turns on the request/location log below; unset in production. */
const DEBUG_REQUESTS_ENV = "OMO_BRIDGE_DEBUG_REQUESTS";

const DEBUG_REQUESTS_PREFIX = "[omo-bridge:requests]";

export const BASIC_USERNAME = "opencode";

const WWW_AUTHENTICATE = 'Basic realm="opencode"';
const JSON_CONTENT_TYPE = "application/json";

export type BridgeServer = ReturnType<typeof Bun.serve>;

const IDLE_TIMEOUT_SECONDS = 60;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });
}

function errorResponse(
  status: number,
  tag: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { _tag: tag, message }, headers);
}

/** Every response leaves the server through here, so clients can always identify the bridge build. */
function withBridgeVersion(response: Response): Response {
  response.headers.set(VERSION_HEADER, BRIDGE_VERSION);
  return response;
}

function unauthorized(message: string): Response {
  return errorResponse(401, "UnauthorizedError", message, { "www-authenticate": WWW_AUTHENTICATE });
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function credentialsFrom(request: Request): { username: string; password: string } | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const match = /^Basic[ \t]+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
}

/** Returns the 401 response to send, or null when the request carries valid credentials. */
function rejectUnauthenticated(request: Request, config: Config): Response | null {
  const credentials = credentialsFrom(request);
  if (credentials === null) return unauthorized("authentication required");
  const usernameOk = constantTimeEqual(credentials.username, BASIC_USERNAME);
  const passwordOk = constantTimeEqual(credentials.password, config.password);
  return usernameOk && passwordOk ? null : unauthorized("invalid credentials");
}

/**
 * The TUI keys every per-location catalog by `[directory, workspaceID]`
 * (`packages/client/src/solid/data.ts:148`) and publishes a sync under the directory the *response*
 * reports, while readers ask under the directory they *requested*. When a dialog comes up empty, the
 * log below separates a server that answers a different directory from a client that reads another key.
 */
function debugRequestsEnabled(): boolean {
  return process.env[DEBUG_REQUESTS_ENV] === "1";
}

function requestedDirectoryOf(url: URL): string {
  const raw = url.searchParams.get("location[directory]")?.trim();
  return raw === undefined || raw.length === 0 ? "(absent)" : raw;
}

/** The `location.directory` a JSON body carries, or why the body had none worth reading. */
async function answeredDirectoryOf(response: Response): Promise<string> {
  if (response.body === null) return "(no body)";
  const contentType = response.headers.get("content-type") ?? "";
  // Cloning an event stream would buffer it forever and stall the client, so only JSON bodies are read.
  if (!contentType.includes("application/json")) return "(no location: not json)";
  try {
    const body = await response.clone().json();
    const location = (body as { location?: { directory?: unknown } } | null)?.location;
    const directory = location?.directory;
    return typeof directory === "string" ? directory : "(no location)";
  } catch {
    return "(no location: unreadable body)";
  }
}

async function logRequest(request: Request, pending: Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const response = await pending;
  const answered = await answeredDirectoryOf(response);
  const query = url.search.length === 0 ? "(none)" : url.search.slice(1);
  process.stderr.write(
    `${DEBUG_REQUESTS_PREFIX} ${request.method} ${url.pathname} query=${query} ` +
      `requested.location.directory=${requestedDirectoryOf(url)} status=${response.status} ` +
      `response.location.directory=${answered}\n`,
  );
  return response;
}

function infoHandler(config: Config, port: number): Response {
  const body = {
    version: BRIDGE_PROTOCOL_VERSION,
    pid: process.pid,
    hostname: hostname(),
    urls: [`http://${config.host}:${port}`],
    paths: { tmp: tmpdir() },
    capabilities: { persistentPty: false },
  };
  const result = validateResponse("server.info", body);
  if (!result.ok) {
    return errorResponse(500, "InternalError", `server.info contract violation: ${result.errors.join("; ")}`);
  }
  return jsonResponse(200, body);
}

export function createServer(config: Config): BridgeServer {
  let server: BridgeServer | undefined;
  const currentPort = (): number => server?.port ?? config.port;

  const router = createRouter([
    { method: "GET", path: "/api/info", handler: () => infoHandler(config, currentPort()) },
    ...routes,
  ]);

  server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    fetch(request: Request): Response | Promise<Response> {
      const rejected = rejectUnauthenticated(request, config);
      if (rejected !== null) return withBridgeVersion(rejected);
      const response = router(request).then(withBridgeVersion);
      if (!debugRequestsEnabled()) return response;
      return logRequest(request, response);
    },
  });
  return server;
}
