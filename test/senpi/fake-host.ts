import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeFrame {
  connection: number;
  frame: Record<string, unknown>;
}

export interface FakeConnectionSummary {
  index: number;
  capabilities: string[];
  frames: Record<string, unknown>[];
}

export interface FakeHostOptions {
  rejectAuth?: boolean;
  enforceInteractiveUserForStop?: boolean;
  /** The `inputs` of a `get_pending_inputs` answer; defaults to two queued inputs. */
  pendingInputs?: readonly Record<string, unknown>[];
  /** The `commands` of a `get_commands` answer. */
  commands?: readonly Record<string, unknown>[];
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
}

const HANDSHAKE_COMMAND = "get_protocol_info";

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
   * RpcClient resolves `waitForIdle` on the `agent_idle` event, which the host sends once the
   * turn's `agent_end` has been delivered.
   */
  finishTurn(): void {
    this.emit({ type: "agent_end" });
    this.emit({ type: "agent_idle" });
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
          instanceId: "fake-host-instance",
          generation: 0,
          engineVersion: "fake",
          protocolVersion: 1,
          capabilities: ["retain_on_disconnect", "session_kind", "subscribe_sessions"],
          agentDir: this.dir,
          mode: "multi",
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
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: { sessionId: "rpc-1", attached: true, state: { sessionId: "rpc-1", paused: false } },
      });
      return;
    }
    if (type === "list_sessions") {
      this.write(socket, {
        type: "response",
        id,
        command: type,
        success: true,
        data: {
          sessions: [
            {
              sessionId: "rpc-1",
              durableSessionId: "durable-1",
              sessionPath: join(this.dir, "session.jsonl"),
              cwd: this.dir,
              status: "open",
              attachments: 1,
            },
          ],
        },
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

  private write(socket: Bun.Socket<ConnectionState>, payload: unknown): void {
    socket.write(`${JSON.stringify(payload)}\n`);
  }
}
