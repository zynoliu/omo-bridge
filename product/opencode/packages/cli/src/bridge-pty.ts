/**
 * In-process terminals for bridge mode.
 *
 * The terminal pane is a client feature: in the HTTP client it talks to the server's persistent PTY
 * service over `client.api.experimental.persistentPty.*` and `client.persistentPty.connect`. The bridge
 * runs no server, so this module drives the fork's own service directly — `packages/core`'s
 * `PersistentPty`, the same implementation `packages/server/src/handlers/pty.ts` wraps. Nothing here
 * spawns a shell of its own: `create` asks that service, which owns the daemon, the binary probe and
 * the replay buffer.
 *
 * The service is Effect-based, so it is built once behind a managed runtime and reused: a layer built
 * per call would restart the daemon and lose every running terminal.
 */
import { Effect, ManagedRuntime } from "effect";
import { LayerNode } from "@opencode/util/effect/layer-node";
/* The fork ships this service; the path is relative because workspace links do not expose it. */
import { PersistentPty } from "../../core/src/persistent-pty.ts";

export type PtyInfo = PersistentPty.Info;
export type PtySnapshot = PersistentPty.Snapshot;
export type PtyAttachment = PersistentPty.Attachment;

export type PtyCreateInput = {
  readonly command?: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly title: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols?: number;
  readonly rows?: number;
};

/** Everything the terminal surface needs, in plain async form. */
export type BridgePty = {
  readonly list: (sessionID?: string) => Promise<readonly PtyInfo[]>;
  readonly get: (id: string) => Promise<PtyInfo>;
  readonly create: (sessionID: string, input: PtyCreateInput) => Promise<PtyInfo>;
  readonly snapshot: (id: string) => Promise<PtySnapshot>;
  readonly read: (sessionID: string, lines?: number) => Promise<unknown>;
  readonly write: (id: string, data: string, attachmentID?: string) => Promise<void>;
  readonly resize: (id: string, cols: number, rows: number, attachmentID?: string) => Promise<void>;
  readonly input: (id: string, attachmentID: string, cols: number, rows: number, data: Uint8Array) => Promise<void>;
  readonly remove: (id: string) => Promise<void>;
  readonly rename: (id: string, title: string | null) => Promise<PtyInfo>;
  readonly attach: (id: string, input: Parameters<PersistentPty.Interface["attach"]>[1]) => Promise<PtyAttachment>;
  readonly shutdown: () => Promise<void>;
  /** Opens the live byte stream the terminal pane reads and writes, in the shape it expects. */
  readonly connect: (input: BridgePtyConnectInput) => Promise<BridgePtySocket>;
  /** Releases the runtime this module built; never spawns anything itself. */
  readonly handoff: () => Promise<unknown>;
  readonly dispose: () => Promise<void>;
};

type PtyRuntime = ManagedRuntime.ManagedRuntime<PersistentPty.Service, unknown>;

/* The service brands its ids; this adapter carries them as strings and re-brands them at the call, so
   no caller has to import the schema just to name a terminal. */
type PtyId = Parameters<PersistentPty.Interface["get"]>[0];
type SessionId = Parameters<PersistentPty.Interface["create"]>[0];
const asPtyId = (value: string): PtyId => value as PtyId;
const asSessionId = (value: string): SessionId => value as SessionId;


/** Renders a tagged Effect error without pulling its whole structure into the log line. */
function describePtyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { _tag?: unknown })._tag;
    return typeof tag === "string" ? tag : "unknown pty error";
  }
  return String(error);
}

/** The terminal pane treats what `connect` returns as a socket: message events, send, close. */
export type BridgePtySocket = {
  binaryType: "arraybuffer";
  /** Mirrors WebSocket.OPEN (1) and CLOSED (3): the pane refuses to write unless the socket is open. */
  readonly readyState: number;
  readonly addEventListener: (type: "message", listener: (event: { readonly data: ArrayBuffer | string }) => void) => void;
  readonly removeEventListener: (type: "message", listener: (event: { readonly data: ArrayBuffer | string }) => void) => void;
  readonly send: (frame: Uint8Array) => void;
  readonly close: () => void;
};

export type BridgePtyConnectInput = {
  readonly ptyID: string;
  readonly cursor: number;
  readonly attachmentID: string;
  readonly takeover?: boolean;
};

/** Splits the pane's 5-byte frame header: flag, cols, rows, then the optional input bytes. */
function readFrame(frame: Uint8Array): { readonly size: { readonly cols: number; readonly rows: number }; readonly data?: Uint8Array } {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const hasData = frame[0] === 1;
  const size = { cols: view.getUint16(1), rows: view.getUint16(3) };
  if (!hasData) return { size: size };
  return { size: size, data: frame.subarray(5) };
}

export function createBridgePty(): BridgePty {
  let runtime: PtyRuntime | undefined;

  const getRuntime = (): PtyRuntime => {
    runtime ??= ManagedRuntime.make(LayerNode.compile(PersistentPty.node));
    return runtime;
  };

  /* One helper so every call runs inside the same runtime and rethrows the service's tagged errors
     unchanged: a caller that sees `PersistentPty.NotFoundError` knows the host has no such terminal. */
  /* The service's effects may need their own environment (the daemon touches the filesystem); the
     runtime supplies it, so the helper only requires the service in the type. */
  const call = <A>(run: (service: PersistentPty.Interface) => Effect.Effect<A, unknown, any>): Promise<A> =>
    getRuntime().runPromise(
      Effect.gen(function* () {
        const service = yield* PersistentPty.Service;
        return yield* run(service);
      }),
    ) as Promise<A>;

  return {
    list: (sessionID) => call((service) => service.list(sessionID === undefined ? undefined : asSessionId(sessionID))),
    get: (id) => call((service) => service.get(asPtyId(id))),
    create: (sessionID, input) => call((service) => service.create(asSessionId(sessionID), input)),
    snapshot: (id) => call((service) => service.snapshot(asPtyId(id))),
    read: (sessionID, lines) => call((service) => service.read(asSessionId(sessionID), lines)),
    write: (id, data, attachmentID) => call((service) => service.write(asPtyId(id), data, attachmentID)),
    resize: (id, cols, rows, attachmentID) => call((service) => service.resize(asPtyId(id), cols, rows, attachmentID)),
    input: (id, attachmentID, cols, rows, data) => call((service) => service.input(asPtyId(id), attachmentID, cols, rows, data)),
    remove: (id) => call((service) => service.remove(asPtyId(id))),
    rename: (id, title) => call((service) => service.rename(asPtyId(id), title)),
    attach: (id, input) => call((service) => service.attach(asPtyId(id), input)),
    shutdown: () => call((service) => service.shutdown()),
    handoff: () => call((service) => service.handoff()),
    connect: async (input) => {
      const listeners = new Set<(event: { readonly data: ArrayBuffer | string }) => void>();
      /* The handshake is emitted while `connect` is still resolving, so anything written before the pane
         attaches its listener is held here and flushed on the first `addEventListener` — a dropped
         `attached` message would leave the pane waiting for a size it already has. */
      const backlog: (ArrayBuffer | string)[] = [];
      const emit = (data: ArrayBuffer | string) => {
        if (listeners.size === 0) {
          backlog.push(data);
          return;
        }
        for (const listener of listeners) listener({ data: data });
      };
      const json = (value: Record<string, unknown>) => emit(JSON.stringify(value));
      const attachment = await call((service) =>
        service.attach(asPtyId(input.ptyID), {
          cursor: input.cursor,
          attachmentID: input.attachmentID,
          /* The pane asks for `takeover`, which is what makes it the controller of this terminal. */
          role: input.takeover === true ? "controller" : "observer",
          takeover: input.takeover,
          onEvent: (event) => {
            switch (event.type) {
              case "output": {
                const bytes = event.data;
                const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                emit(buffer as ArrayBuffer);
                return;
              }
              case "resized":
                json({ type: "resized", cols: event.cols, rows: event.rows, checkpoint: Buffer.from(event.checkpoint).toString("base64") });
                return;
              case "exited":
                json({ type: "exited", exitCode: event.exitCode ?? null });
                return;
              case "controller_changed":
                json({ type: "controller_changed", attachmentID: event.attachmentID ?? null });
                return;
              case "title_changed":
                json({ type: "title_changed", title: event.title });
                return;
              case "foreground_process_changed":
                json({ type: "foreground_process_changed", process: event.process });
                return;
            }
          },
          onEnd: () => json({ type: "exited", exitCode: null }),
        }),
      );
      json({ type: "attached", inputProtocol: 1, info: { size: attachment.info.size }, role: attachment.role });
      json({ type: "replay_complete" });
      /* An attachment is inert until activated: without this the daemon never forwards output to it. */
      attachment.activate();
      let closed = false;
      return {
        /* The terminal pane gates every write on `readyState === WebSocket.OPEN`; without this the socket
           looks unopened and every keystroke is dropped even though output renders. */
        get readyState() {
          return closed ? 3 : 1;
        },
        binaryType: "arraybuffer" as const,
        addEventListener: (type, listener) => {
          if (type !== "message") return;
          listeners.add(listener);
          while (backlog.length > 0) {
            const data = backlog.shift();
            if (data !== undefined) listener({ data: data });
          }
        },
        removeEventListener: (type, listener) => {
          if (type === "message") listeners.delete(listener);
        },
        send: (frame) => {
          const parsed = readFrame(frame);
          /* A dropped keystroke must be visible: the write is not awaited here, but a refusal is logged
             rather than swallowed, which is what an unobserved promise would do. */
          const report = (error: unknown) => {
            process.stderr.write("bridge-log: terminal input rejected by the pty service: " + describePtyError(error) + "\n");
          };
          if (parsed.data !== undefined) {
            call((service) => service.input(asPtyId(input.ptyID), input.attachmentID, parsed.size.cols, parsed.size.rows, parsed.data as Uint8Array)).catch(report);
            return;
          }
          call((service) => service.control(asPtyId(input.ptyID), input.attachmentID, parsed.size.cols, parsed.size.rows)).catch(report);
        },
        close: () => {
          closed = true;
          listeners.clear();
          attachment.detach();
        },
      };
    },
    dispose: async () => {
      const current = runtime;
      runtime = undefined;
      if (current !== undefined) await current.dispose();
    },
  };
}
