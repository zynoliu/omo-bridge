import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeFrame {
  connection: number;
  frame: Record<string, unknown>;
}

export interface FakeConnectionSummary {
  index: number;
  capabilities: string[];
  /** Frames the client sent to this connection. */
  frames: Record<string, unknown>[];
  /** Frames this connection answered with, so a test can read the wire answer itself. */
  sent: Record<string, unknown>[];
}

export interface FakeHostOptions {
  rejectAuth?: boolean;
  enforceInteractiveUserForStop?: boolean;
  /** The `inputs` of a `get_pending_inputs` answer; defaults to two queued inputs. */
  pendingInputs?: readonly Record<string, unknown>[];
  /** The `commands` of a `get_commands` answer. */
  commands?: readonly Record<string, unknown>[];
  /** Rows a `list_sessions` answer reports; defaults to one durable session in the fake's directory. */
  sessions?: readonly Record<string, unknown>[];
  /**
   * Session entries by transcript path, answered by `get_entries`. The real host serves entries for the
   * session the connection is attached to, which is what lets a test catch a read of the wrong session.
   */
  transcripts?: Record<string, readonly Record<string, unknown>[]>;
  /** The `isStreaming` an `open_session` answer reports; defaults to the recorded value (false). */
  streaming?: boolean;
}

// Two queued inputs in the shape of the host's `PendingInputSnapshot.inputs` projections.
const DEFAULT_PENDING_INPUTS: readonly Record<string, unknown>[] = [
  {
    clientMessageId: "msg_queued_1",
    state: "queued",
    text: "run the full test suite",
    requestedMode: "followUp",
    revision: 1,
    statusCode: "queued_follow_up",
    statusText: "Queued as a follow-up",
    actions: ["edit", "remove"],
    pendingDecoration: true,
    supersededVersions: [],
  },
  {
    clientMessageId: "msg_queued_2",
    state: "queued",
    text: "also check the diff",
    requestedMode: "steer",
    revision: 1,
    statusCode: "queued_steer",
    statusText: "Queued as a steer",
    actions: ["edit", "remove"],
    pendingDecoration: true,
    supersededVersions: [],
  },
];

const DEFAULT_COMMANDS: readonly Record<string, unknown>[] = [
  { name: "fix-tests", description: "Fix failing tests", source: "prompt", sourceInfo: {}, syntax: "slash" },
];

interface ConnectionState {
  index: number;
  buffer: string;
  capabilities: string[];
  frames: Record<string, unknown>[];
  sent: Record<string, unknown>[];
  sessionPath?: string;
  sessionId?: string;
}

const HANDSHAKE_COMMAND = "get_protocol_info";

// The fake answers from the recording in `contracts/senpi/` instead of inventing a handshake.
// `live.jsonl` is a real host's command session; `events.jsonl` carries the event order the pinned
// docs record, because the contract job forbids a model call and so the live capture has no turn.
const RECORDING_DIR = join(import.meta.dir, "..", "..", "contracts", "senpi");

interface RecordedLine {
  readonly frame: Record<string, unknown>;
  readonly role?: string;
}

function readRecording(file: string): RecordedLine[] {
  return readFileSync(join(RECORDING_DIR, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedLine);
}

function asData(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("contracts/senpi/live.jsonl holds no recorded answer for this command");
  }
  return value as Record<string, unknown>;
}

const LIVE_FRAMES = readRecording("live.jsonl");

function recordedAnswer(command: string): Record<string, unknown> {
  const line = LIVE_FRAMES.find(
    (entry) => entry.role === "response" && entry.frame.command === command && entry.frame.success === true,
  );
  return asData(line?.frame.data);
}

/** The live `get_protocol_info` answer: the fake reproduces it instead of advertising an invented set. */
export const RECORDED_HANDSHAKE = recordedAnswer("get_protocol_info");

/** The live `open_session` state; the transport seeds its streaming flag from `isStreaming`. */
export const RECORDED_OPEN_SESSION_STATE = asData(recordedAnswer("open_session").state);

const TURN_END_TYPES = ["agent_end", "agent_settled", "agent_idle"] as const;

/**
 * One turn's terminal frames in recorded order. A live capture that carries a turn wins; otherwise the
 * recorded `agent_end` payload is followed by the `agent_settled`/`agent_idle` seals `rpc.md` documents.
 */
const TURN_END_FRAMES: readonly Record<string, unknown>[] = (() => {
  const fromLive = LIVE_FRAMES.filter(
    (entry) =>
      entry.role === "event" &&
      (TURN_END_TYPES as readonly string[]).includes(String(entry.frame.type)),
  ).map((entry) => entry.frame);
  if (fromLive.length > 0) return fromLive;
  const recordedEnd = readRecording("events.jsonl").find((entry) => entry.frame.type === "agent_end")?.frame;
  return [...(recordedEnd === undefined ? [] : [recordedEnd]), { type: "agent_settled" }, { type: "agent_idle" }];
})();

export class FakeSenpiHost {
  readonly dir: string;
  readonly socketPath: string;
  readonly frames: FakeFrame[] = [];
  readonly connections: FakeConnectionSummary[] = [];

  private readonly server: ReturnType<typeof Bun.listen<ConnectionState>>;
  private readonly sockets = new Set<Bun.Socket<ConnectionState>>();
  private readonly options: FakeHostOptions;
  private readonly pendingInputs: readonly Record<string, unknown>[];
  private readonly commands: readonly Record<string, unknown>[];

  private constructor(dir: string, options: FakeHostOptions) {
    this.dir = dir;
    this.socketPath = join(dir, "s.sock");
    this.options = options;
    this.pendingInputs = options.pendingInputs ?? DEFAULT_PENDING_INPUTS;
    this.commands = options.commands ?? DEFAULT_COMMANDS;
    this.server = Bun.listen<ConnectionState>({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          const state: ConnectionState = {
            index: this.connections.length,
            buffer: "",
            capabilities: [],
            frames: [],
            sent: [],
          };
          this.connections.push(state);
          socket.data = state;
          this.sockets.add(socket);
        },
        data: (socket, chunk) => {
          const state = socket.data;
          state.buffer += chunk.toString();
          for (;;) {
            const newline = state.buffer.indexOf("\n");
            if (newline === -1) return;
            const line = state.buffer.slice(0, newline).trim();
            state.buffer = state.buffer.slice(newline + 1);
            if (line.length === 0) continue;
            const frame = JSON.parse(line) as Record<string, unknown>;
            state.frames.push(frame);
            this.frames.push({ connection: state.index, frame });
            this.respond(socket, state, frame);
          }
        },
        close: (socket) => {
          this.sockets.delete(socket);
        },
        error: (socket) => {
          this.sockets.delete(socket);
        },
      },
    });
  }

  static start(options: FakeHostOptions = {}): FakeSenpiHost {
    return new FakeSenpiHost(mkdtempSync(join(tmpdir(), "senpi-fake-")), options);
  }

  framesOfType(type: string): FakeFrame[] {
    return this.frames.filter((entry) => entry.frame.type === type);
  }

  /** Push one host-to-client frame on every open connection: the host's event stream. */
  emit(frame: Record<string, unknown>): void {
    for (const socket of this.sockets) this.write(socket, frame);
  }

  /**
   * The host's answer to a client waiting for idle. There is no `wait_for_idle` wire command: the
   * RpcClient resolves `waitForIdle` on the `agent_idle` event, which the host sends after the turn's
   * `agent_end` and its settle seal. The frames are replayed in recorded order, not hand-built.
   */
  finishTurn(): void {
    for (const frame of TURN_END_FRAMES) this.emit(frame);
  }

  stop(): void {
    for (const socket of this.sockets) socket.end();
    this.sockets.clear();
    this.server.stop(true);
    rmSync(this.dir, { recursive: true, force: true });
  }

  private respond(socket: Bun.Socket<ConnectionState>, state: ConnectionState, frame: Record<string, unknown>): void {
    const id = frame.id;
    const type = String(frame.type);
    if (type === HANDSHAKE_COMMAND) {
      if (this.options.rejectAuth === true) {
        this.write(socket, {
          type: "response",
          id,
          command: HANDSHAKE_COMMAND,
          success: false,
          error: "auth_failed: the endpoint refused this client",
          errorCode: "auth_failed",
        });
        return;
      }
      this.write(socket, {
        type: "response",
        id,
        command: HANDSHAKE_COMMAND,
        success: true,
        data: {
          ...RECORDED_HANDSHAKE,
          // The recording stores a placeholder agent dir; the fake answers with the directory it owns.
          agentDir: this.dir,
        },
      });
      return;
    }
    if (type === "set_client_info") {
      const capabilities = Array.isArray(frame.capabilities) ? frame.capabilities.map(String) : [];
      state.capabilities = capabilities;
      this.write(socket, { type: "response", id, command: type, success: true });
      return;
    }
    if (type === "open_session") {
      const sessionPath = typeof frame.sessionPath === "string" ? frame.sessionPath : state.sessionPath;
      const sessionId = this.sessionIdFor(sessionPath, state);
      state.sessionPath = sessionPath;
      state.sessionId = sessionId;
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: {
          sessionId,
          sessionPath,
          attached: true,
          state: {
            ...RECORDED_OPEN_SESSION_STATE,
            sessionId,
            sessionFile: sessionPath,
            cwd: typeof frame.cwd === "string" ? frame.cwd : this.dir,
            isStreaming: this.options.streaming ?? RECORDED_OPEN_SESSION_STATE.isStreaming ?? false,
          },
        },
      });
      return;
    }
    if (type === "get_entries") {
      const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : state.sessionId;
      const sessionPath = this.pathForSession(sessionId) ?? state.sessionPath;
      const entries = sessionPath === undefined ? [] : (this.options.transcripts?.[sessionPath] ?? []);
      this.write(socket, { type: "response", id, command: type, success: true, data: { entries, leafId: null } });
      return;
    }
    if (type === "get_messages") {
      this.write(socket, { type: "response", id, command: type, success: true, data: { messages: [] } });
      return;
    }
    if (type === "list_sessions") {
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: { sessions: this.options.sessions ?? [this.defaultSessionRow()] },
      });
      return;
    }
    if (type === "get_state") {
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: { sessionId: "rpc-1", paused: false },
      });
      return;
    }
    if (type === "get_pending_inputs") {
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: {
          lifetimeId: "fake-lifetime",
          throughCursor: this.frames.length,
          inputs: [...this.pendingInputs],
          outcomes: [],
        },
      });
      return;
    }
    if (type === "get_commands") {
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: { commands: [...this.commands] },
      });
      return;
    }
    if (type === "abort") {
      const refused =
        (this.options.enforceInteractiveUserForStop ?? true) &&
        frame.intent === "stop" &&
        !state.capabilities.includes("interactive_user");
      if (refused) {
        this.write(socket, {
          type: "response",
          id,
          command: type,
          success: false,
          error: "stop_requires_interactive_client: declare interactive_user with set_client_info first",
        });
        return;
      }
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: { stopped: true, idle: true, cleared: false },
      });
      return;
    }
    this.write(socket, { type: "response", id, command: type, success: true });
  }

  private defaultSessionRow(): Record<string, unknown> {
    return {
      sessionId: "rpc-1",
      durableSessionId: "durable-1",
      sessionPath: join(this.dir, "session.jsonl"),
      cwd: this.dir,
      status: "open",
      attachments: 1,
    };
  }

  private sessionIdFor(sessionPath: string | undefined, state: ConnectionState): string {
    const known = (this.options.sessions ?? []).find((row) => row.sessionPath === sessionPath);
    if (typeof known?.sessionId === "string") return known.sessionId;
    return state.sessionId ?? "rpc-1";
  }

  private pathForSession(sessionId: string | undefined): string | undefined {
    const row = (this.options.sessions ?? []).find((candidate) => candidate.sessionId === sessionId);
    return typeof row?.sessionPath === "string" ? row.sessionPath : undefined;
  }

  private write(socket: Bun.Socket<ConnectionState>, payload: unknown): void {
    if (typeof payload === "object" && payload !== null) socket.data.sent.push(payload as Record<string, unknown>);
    socket.write(`${JSON.stringify(payload)}\n`);
  }
}
