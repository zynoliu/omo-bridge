/**
 * A stand-in host: the server half of the published RPC exchange, with no OmO daemon behind it.
 *
 * It exists because most event-cluster capability rows cannot be observed without a provider
 * credential. A stand-in host that answers the same handshake the launcher performs and then writes
 * the frames the projector consumes exercises the shipping transport (`openBridgeTransport`), the
 * shipping event stream (`createBridgeOpencodeApi(...).event.subscribe`) and the shipping projector
 * (`packages/bridge-core/src/host-projection.ts`) -- only the far end is scripted.
 *
 * The handshake is the one `tools/bridge-qa/cases/tui-permission-once.ts` plays against the launcher:
 * a key record at `<directory>/agent/rpc/keys/<launchId>` (0600, `keys` exactly 0700) and the
 * `senpi-rpc-server` / `senpi-rpc-client` HMAC proofs. Every other command is answered `success: true`
 * with the scripted `data`, so `open_session`, `prompt` and `subscribe_sessions` are accepted as a
 * real host accepts them.
 *
 * What this file is NOT: proof that a real host emits these frames. The stream records it can write
 * (`{ kind: "partial" }`, ...) are the bridge's own vocabulary in
 * `packages/bridge-core/src/stream.ts`; the host's real live records are `message_update`,
 * `tool_execution_*`, `compaction_*` and the like, which the projector counts as unprojectable.
 * A case reports which side of that line each frame came from.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts";

export type StandinHandshake = {
  infoReceived: boolean;
  serverProofSent: boolean;
  authenticateReceived: boolean;
  clientProofVerified: boolean;
};

export type StandinStop = { readonly ok: boolean; readonly detail: readonly string[] };

export type StandinHost = {
  readonly socketPath: string;
  readonly recordPath: string;
  readonly launchId: string;
  /** Which steps of the documented handshake arrived and verified. */
  readonly handshake: StandinHandshake;
  /** Command types the client asked for, in arrival order. */
  readonly requests: () => readonly string[];
  /** Every parsed frame the client wrote, as received. */
  readonly received: () => readonly Record<string, unknown>[];
  /** Writes one frame to the authenticated client; false when no client has authenticated yet. */
  readonly send: (frame: Record<string, unknown>) => boolean;
  /** Stops the listener, proves nothing answers on the path, then removes the socket and key record. */
  readonly stop: () => Promise<StandinStop>;
};

export type StandinHostOptions = {
  /** Root the documented key record is published under: `<directory>/agent/rpc/keys/<launchId>`. */
  readonly directory: string;
  readonly socketPath: string;
  /** The `data` each command answers with; a command with no entry answers `{}`. */
  readonly responses?: Readonly<Record<string, Record<string, unknown>>>;
};

type Frame = Record<string, unknown>;

type ClientSocket = { write(chunk: Uint8Array): unknown };

type ConnectionState = {
  readonly decoder: JsonlFrameDecoder;
  clientNonce?: string;
  serverNonce?: string;
};

function isRecord(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(source: Frame, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function proof(key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("hex");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name + ": " + error.message;
  return String(error);
}

/**
 * Publishes the key record the documented host publishes, then serves the server half of the
 * exchange. Directory modes are the ones `loadKeyRecord` enforces: `keys` exactly 0700, `rpc` and the
 * agent directory not group/other writable.
 */
export function startStandinHost(options: StandinHostOptions): StandinHost {
  const agentDir = path.join(options.directory, "agent");
  const rpcDir = path.join(agentDir, "rpc");
  const keysDir = path.join(rpcDir, "keys");
  const launchId = randomUUID();
  const recordPath = path.join(keysDir, launchId);
  const key = randomBytes(32);

  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(agentDir, 0o755);
  fs.chmodSync(rpcDir, 0o755);
  fs.chmodSync(keysDir, 0o700);
  const record = {
    version: 1,
    launch_id: launchId,
    key: key.toString("hex"),
    pid: process.pid,
    process_start: null,
    endpoint: options.socketPath,
    created_at: new Date().toISOString(),
  };
  fs.writeFileSync(recordPath, JSON.stringify(record), { mode: 0o600 });
  fs.chmodSync(recordPath, 0o600);

  const handshake: StandinHandshake = {
    infoReceived: false,
    serverProofSent: false,
    authenticateReceived: false,
    clientProofVerified: false,
  };
  const requests: string[] = [];
  const received: Frame[] = [];
  const connections = new WeakMap<object, ConnectionState>();
  const responses = options.responses ?? {};
  let client: ClientSocket | undefined;

  const answer = (socket: ClientSocket, frame: Frame) => {
    socket.write(encodeFrame(frame));
  };

  /** The response a real host gives a command: the same id and command, `success: true`. */
  const reply = (socket: ClientSocket, id: string, command: string) => {
    answer(socket, {
      id: id,
      type: "response",
      command: command,
      success: true,
      data: responses[command] ?? {},
    });
  };

  const server = Bun.listen({
    unix: options.socketPath,
    socket: {
      open() {},
      data(socket, chunk) {
        const state = connections.get(socket) ?? { decoder: new JsonlFrameDecoder() };
        connections.set(socket, state);
        let lines: readonly string[];
        try {
          lines = state.decoder.push(chunk);
        } catch {
          socket.end();
          return;
        }
        for (const line of lines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;
          const id = readString(parsed, "id") ?? "";
          const type = readString(parsed, "type") ?? "";
          received.push(parsed);

          if (type === "get_protocol_info") {
            const auth = isRecord(parsed.auth) ? parsed.auth : undefined;
            const clientNonce = auth === undefined ? "" : (readString(auth, "client_nonce") ?? "");
            if (!/^[0-9a-f]{64}$/.test(clientNonce)) {
              answer(socket, { id: id, type: "response", command: type, success: false, error: "auth_required" });
              continue;
            }
            handshake.infoReceived = true;
            state.clientNonce = clientNonce;
            state.serverNonce = randomBytes(32).toString("hex");
            answer(socket, {
              id: id,
              type: "response",
              command: type,
              success: true,
              data: {
                auth: {
                  launch_id: launchId,
                  server_nonce: state.serverNonce,
                  server_proof: proof(key, ["senpi-rpc-server", launchId, clientNonce, state.serverNonce]),
                },
              },
            });
            handshake.serverProofSent = true;
            continue;
          }

          if (type === "authenticate") {
            handshake.authenticateReceived = true;
            const offered = readString(parsed, "client_proof") ?? "";
            const expected = proof(key, [
              "senpi-rpc-client",
              launchId,
              state.serverNonce ?? "",
              state.clientNonce ?? "",
            ]);
            const ok =
              /^[0-9a-f]{64}$/.test(offered) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(offered, "hex"));
            if (ok) {
              handshake.clientProofVerified = true;
              client = socket;
            }
            answer(socket, {
              id: id,
              type: "response",
              command: type,
              success: ok,
              ...(ok ? {} : { error: "auth_failed" }),
            });
            continue;
          }

          /* Anything else with a correlation id is a command; the stand-in host accepts every one it is
             asked for and reports the data the case scripted, or an empty payload. */
          if (id.length > 0) {
            requests.push(type);
            reply(socket, id, type);
          }
        }
      },
      close() {},
      error() {},
    },
  });

  const stop = async (): Promise<StandinStop> => {
    const detail: string[] = [];
    let ok = true;
    client = undefined;
    server.stop(true);
    try {
      const connection = await Bun.connect({
        unix: options.socketPath,
        socket: { open() {}, data() {}, close() {}, error() {} },
      });
      connection.end();
      ok = false;
      detail.push("the stand-in listener still accepts connections after stop");
    } catch (error) {
      detail.push("stand-in listener stopped (later connect failed: " + describeError(error) + ")");
    }
    for (const target of [options.socketPath, recordPath]) {
      try {
        fs.rmSync(target, { force: true });
      } catch {
        ok = false;
        detail.push("could not remove " + path.basename(target));
      }
    }
    fs.rmSync(agentDir, { recursive: true, force: true });
    detail.push(
      fs.existsSync(options.socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(recordPath) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
      "launch id " + launchId.slice(0, 8) + " (synthetic, generated by this fixture)",
    );
    return { ok: ok, detail: detail };
  };

  return {
    socketPath: options.socketPath,
    recordPath: recordPath,
    launchId: launchId,
    handshake: handshake,
    requests: () => [...requests],
    received: () => [...received],
    send(frame: Record<string, unknown>) {
      const target = client;
      if (target === undefined) return false;
      try {
        target.write(encodeFrame(frame));
        return true;
      } catch {
        return false;
      }
    },
    stop: stop,
  };
}
