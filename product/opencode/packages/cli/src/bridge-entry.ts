export type BridgeConnectionState = "idle" | "connecting" | "ready" | "failed" | "closed";

export type BridgeEntryOptions = {
  readonly socket: string;
  readonly mini: boolean;
};

export class BridgeEntryUsageError extends Error {}

export function parseBridgeArgs(argv: readonly string[]): BridgeEntryOptions {
  let socket: string | undefined;
  let mini = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mini") {
      mini = true;
      continue;
    }
    if (arg === "--socket") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new BridgeEntryUsageError("--socket requires a path");
      socket = value;
      index += 1;
      continue;
    }
    throw new BridgeEntryUsageError("unknown argument " + String(arg));
  }
  if (socket === undefined || socket.length === 0) {
    throw new BridgeEntryUsageError("an explicit --socket path is required; the bridge never starts an OpenCode service");
  }
  return { socket: socket, mini: mini };
}

export type BridgeEntry = {
  readonly options: BridgeEntryOptions;
  readonly state: () => BridgeConnectionState;
  readonly error: () => string | null;
  readonly connect: () => Promise<BridgeConnectionState>;
  readonly close: () => void;
};

export function createBridgeEntry(
  options: BridgeEntryOptions,
  connect: (socket: string) => Promise<void>,
): BridgeEntry {
  let state: BridgeConnectionState = "idle";
  let error: string | null = null;

  return {
    options: options,
    state: () => state,
    error: () => error,
    async connect() {
      state = "connecting";
      error = null;
      try {
        await connect(options.socket);
        state = "ready";
        return state;
      } catch (cause) {
        state = "failed";
        error = cause instanceof Error ? cause.message : String(cause);
        return state;
      }
    },
    close() {
      state = "closed";
    },
  };
}
