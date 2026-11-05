import { isTransportGoneError } from "@code-yeongyu/senpi";

export type SenpiErrorCode =
  | "socket_missing"
  | "auth_failed"
  | "transport_gone"
  | "stop_requires_interactive_client"
  | "shared_socket_forbidden"
  | "not_connected"
  | "no_session"
  | "attach_unavailable"
  | "session_not_found"
  | "command_failed";

export class SenpiTransportError extends Error {
  readonly code: SenpiErrorCode;

  constructor(code: SenpiErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SenpiTransportError";
    this.code = code;
  }
}

export const STOP_REQUIRES_INTERACTIVE_CLIENT = "stop_requires_interactive_client";

const AUTH_CODES: ReadonlySet<string> = new Set([
  "auth_failed",
  "auth_required",
  "host_identity_unproven",
  "unsafe_key_record",
  "key_publication_failed",
]);

const UNREACHABLE_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK"]);

// The host's own refusal for a session it does not hold: `RpcSessionRegistryError` carries it as
// `code`, an `RpcCommandError` carries the wire `error`/`errorCode` (`unknown_session`).
const SESSION_NOT_FOUND_CODES: ReadonlySet<string> = new Set(["unknown_session"]);

const GONE_ERRNOS: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);

function stringField(error: unknown, field: "code" | "name" | "errorCode"): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Stop refusals arrive as a plain `stop_requires_interactive_client: ...` message with no
// errorCode, so the prefix is the only signal the host gives.
export function mapSenpiError(error: unknown): SenpiTransportError {
  if (error instanceof SenpiTransportError) return error;

  const message = messageOf(error);
  const code = stringField(error, "code");
  const name = stringField(error, "name");
  const errorCode = stringField(error, "errorCode");

  if (message.startsWith(STOP_REQUIRES_INTERACTIVE_CLIENT) || code === STOP_REQUIRES_INTERACTIVE_CLIENT) {
    return new SenpiTransportError(STOP_REQUIRES_INTERACTIVE_CLIENT, message, { cause: error });
  }
  // The wire message for a registry refusal is the code itself, so the exact match is the host's
  // signal rather than prose inference.
  if (
    (code !== undefined && SESSION_NOT_FOUND_CODES.has(code)) ||
    (errorCode !== undefined && SESSION_NOT_FOUND_CODES.has(errorCode)) ||
    SESSION_NOT_FOUND_CODES.has(message)
  ) {
    return new SenpiTransportError("session_not_found", message, { cause: error });
  }
  if (isTransportGoneError(error) || name === "RpcTransportGoneError" || code === "rpc_transport_gone") {
    return new SenpiTransportError("transport_gone", message || "the senpi transport disconnected", { cause: error });
  }
  if (name === "RpcEndpointAuthError" || (code !== undefined && AUTH_CODES.has(code))) {
    return new SenpiTransportError("auth_failed", message || "the private senpi host refused authentication", {
      cause: error,
    });
  }
  if (code !== undefined && UNREACHABLE_ERRNOS.has(code)) {
    return new SenpiTransportError("socket_missing", `no private senpi host at the socket path (${code}): ${message}`, {
      cause: error,
    });
  }
  if (code !== undefined && GONE_ERRNOS.has(code)) {
    return new SenpiTransportError("transport_gone", message, { cause: error });
  }
  if (/socket closed|disconnected|not connected/i.test(message)) {
    return new SenpiTransportError("transport_gone", message, { cause: error });
  }
  return new SenpiTransportError("command_failed", message, { cause: error });
}
