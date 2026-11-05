import { SenpiTransportError } from "../../senpi/errors";

// One problem type and one transport-error table for every handler. Handlers used to declare a
// private `HandlerProblem` class each, so a problem raised by another handler's helper (catalogs
// calling session-write's `attachSessionTarget`, for example) failed that handler's `instanceof`
// check and was reported as a 503 "the service is down" instead of its own status.

const JSON_CONTENT_TYPE = "application/json";

export class HandlerProblem extends Error {
  readonly status: number;
  readonly tag: string;
  readonly fields: Record<string, unknown>;

  constructor(status: number, tag: string, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = "HandlerProblem";
    this.status = status;
    this.tag = tag;
    this.fields = fields;
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });
}

export function errorResponse(
  status: number,
  tag: string,
  message: string,
  fields: Record<string, unknown> = {},
): Response {
  return jsonResponse(status, { _tag: tag, message, ...fields });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sessionIdFromUrl(url: URL): string | undefined {
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
  const at = segments.indexOf("session");
  if (at < 0) return undefined;
  const sessionID = segments[at + 1];
  if (sessionID === undefined || sessionID.length === 0) return undefined;
  return sessionID;
}

/**
 * A host that answers "I do not know this session" is not an outage: it is the same 404 the
 * bridge's own `sessionNotFound()` raises, so a restored tab falls back instead of reporting a
 * server error. Everything else a transport can refuse (gone, missing socket, not connected,
 * auth, command failed) stays the 503 it was.
 */
function transportProblem(error: SenpiTransportError, sessionID: string | undefined): HandlerProblem {
  if (error.code === "session_not_found") {
    return sessionID === undefined
      ? new HandlerProblem(404, "SessionNotFoundError", `session not found: ${error.message}`)
      : new HandlerProblem(404, "SessionNotFoundError", `session not found: ${sessionID}`, { sessionID });
  }
  return new HandlerProblem(503, "ServiceUnavailableError", error.message, { service: "senpi" });
}

export function problemFor(error: unknown, sessionID?: string): HandlerProblem {
  if (error instanceof HandlerProblem) return error;
  if (error instanceof SenpiTransportError) return transportProblem(error, sessionID);
  return new HandlerProblem(503, "ServiceUnavailableError", messageOf(error), { service: "senpi" });
}

export async function respond(url: URL, operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    const problem = problemFor(error, sessionIdFromUrl(url));
    return errorResponse(problem.status, problem.tag, problem.message, problem.fields);
  }
}
