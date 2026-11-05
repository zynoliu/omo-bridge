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
}

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

  private constructor(dir: string, options: FakeHostOptions) {
    this.dir = dir;
    this.socketPath = join(dir, "s.sock");
    this.options = options;
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
