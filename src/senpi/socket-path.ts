import { statSync, type Stats } from "node:fs";
import { SenpiTransportError } from "./errors";

const MISSING_SOCKET_ERRNOS: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Diagnose a private socket that is not on disk before a client opens a connection to it.
 *
 * A missing private socket is the bridge's most common real failure (the engine is not running),
 * and it must answer `socket_missing` rather than a raw errno. Bun 1.3.x reports the connect
 * failure as a socket `error` event emitted before the client can attach its listener, so the
 * ENOENT escapes the awaited chain as an uncaught exception (Bun 1.4.x defers that event past the
 * listener). Consulting the filesystem first keeps the raw errno off the process on every runtime:
 * a path that is not there cannot be connected to at all.
 */
export function assertPrivateSocketExists(socketPath: string): void {
  let entry: Stats;
  try {
    entry = statSync(socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Any other stat failure (permissions, an unavailable filesystem) belongs to the client.
    if (code === undefined || !MISSING_SOCKET_ERRNOS.has(code)) return;
    throw new SenpiTransportError(
      "socket_missing",
      `no private senpi host at ${socketPath}: the socket path does not exist`,
      { cause: error },
    );
  }
  if (!entry.isSocket()) {
    throw new SenpiTransportError(
      "socket_missing",
      `no private senpi host at ${socketPath}: the path exists but is not a socket`,
    );
  }
}
