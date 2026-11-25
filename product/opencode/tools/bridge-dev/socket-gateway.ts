/**
 * The local end of the isolated host's socket (plan task 29).
 *
 * The bridge dials a Unix socket on this machine; the host that answers runs inside a container. This
 * gateway owns exactly that seam: it listens on a 0600 socket in the caller's temporary directory and,
 * for each accepted connection, runs one non-TTY `docker exec -i` into the same container running a
 * byte-transparent relay to the host's own socket.
 *
 * It deliberately knows nothing about the protocol. It does not read, parse, log or rewrite a single
 * byte in either direction, so the handshake and every key-bearing frame stay between the two real
 * endpoints. Nothing here can leak a credential because nothing here ever looks at one.
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

export type SocketGatewayOptions = {
  /** The socket the bridge dials. Its parent directory is created if missing. */
  readonly socketPath: string;
  /** The container that runs the official host. */
  readonly container: string;
  /** The host's socket path inside that container. */
  readonly containerSocket: string;
  /** Path of the relay script inside the container. */
  readonly relayPath?: string;
  /** Extra `docker exec` arguments, for example a user to run as. */
  readonly execArgs?: readonly string[];
  /**
   * How one connection reaches the host, defaulting to the documented `docker exec -i` relay. A test
   * may supply a local relay so the gateway's own seam — listening, mode, fan-out, teardown — is what
   * gets exercised without a container.
   */
  readonly spawnRelay?: (containerSocket: string) => ReturnType<typeof spawn>;
};

export type SocketGateway = {
  readonly socketPath: string;
  /** Connections currently forwarded, so a caller can assert nothing was left behind. */
  readonly open: () => number;
  readonly close: () => Promise<void>;
};

const DEFAULT_RELAY = "/opt/bridge-relay.mjs";

export async function openSocketGateway(options: SocketGatewayOptions): Promise<SocketGateway> {
  await mkdir(path.dirname(options.socketPath), { recursive: true, mode: 0o700 });
  /* A stale socket from an earlier run would make listen() fail; only the file at this exact path is
     removed, and it sits in a directory this run created. */
  await rm(options.socketPath, { force: true });

  const children = new Set<ReturnType<typeof spawn>>();
  const server = net.createServer((connection) => {
    const child =
      options.spawnRelay !== undefined
        ? options.spawnRelay(options.containerSocket)
        : spawn(
            "docker",
            [
              "exec",
              "-i",
              ...(options.execArgs ?? []),
              options.container,
              "node",
              options.relayPath ?? DEFAULT_RELAY,
              options.containerSocket,
            ],
            { stdio: ["pipe", "pipe", "pipe"] },
          );
    children.add(child);
    child.on("exit", () => {
      children.delete(child);
      connection.destroy();
    });
    child.on("error", () => {
      children.delete(child);
      connection.destroy();
    });
    connection.on("close", () => {
      child.kill("SIGTERM");
    });
    connection.pipe(child.stdin as unknown as NodeJS.WritableStream);
    (child.stdout as unknown as NodeJS.ReadableStream).pipe(connection);
    /* The relay's stderr is diagnostic only; it is forwarded without the payload it describes. */
    (child.stderr as unknown as NodeJS.ReadableStream).pipe(process.stderr, { end: false });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  await chmod(options.socketPath, 0o600);

  return {
    socketPath: options.socketPath,
    open: () => children.size,
    close: async () => {
      for (const child of children) child.kill("SIGTERM");
      children.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.socketPath, { force: true });
    },
  };
}
