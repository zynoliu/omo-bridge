import { homedir } from "node:os";
import { join } from "node:path";
import { RpcClient } from "@code-yeongyu/senpi";
import { SenpiTransportError, mapSenpiError } from "./errors";
import { RawChannel } from "./raw";
import { assertPrivateSocketExists } from "./socket-path";

export const DEFAULT_CLIENT_WIDTH = 80;
export const DEFAULT_CLIENT_CAPABILITIES = ["interactive_user", "question"] as const;

export type SenpiClientEvent = Parameters<Parameters<RpcClient["onEvent"]>[0]>[0];
export type SenpiSessionSummary = Awaited<ReturnType<RpcClient["listSessions"]>>[number];
export type SenpiSessionState = Awaited<ReturnType<RpcClient["getState"]>>;
export type SenpiOpenSessionResult = Awaited<ReturnType<RpcClient["openSession"]>>;
export type SenpiPromptOptions = Exclude<Parameters<RpcClient["prompt"]>[1], undefined>;
export type SenpiPromptResult = Awaited<ReturnType<RpcClient["prompt"]>>;
export type SenpiImages = Parameters<RpcClient["steer"]>[1];
export type SenpiSteerRecovery = Parameters<RpcClient["steer"]>[2];
export type SenpiQueuedDisposition = Awaited<ReturnType<RpcClient["steer"]>>;
export type SenpiAbortOptions = Exclude<Parameters<RpcClient["abort"]>[0], undefined>;
export type SenpiAbortAnswer = Awaited<ReturnType<RpcClient["abort"]>>;
export type SenpiEntriesPage = Exclude<Parameters<RpcClient["getEntries"]>[1], undefined>;
export type SenpiEntriesResult = Awaited<ReturnType<RpcClient["getEntries"]>>;
export type SenpiMessages = Awaited<ReturnType<RpcClient["getMessages"]>>;
export type SenpiModelInfo = Awaited<ReturnType<RpcClient["getAvailableModels"]>>[number];
export type SenpiSelectedModel = Awaited<ReturnType<RpcClient["setModel"]>>;
export type SenpiExtensionUIResponse = Parameters<RpcClient["sendExtensionUIResponse"]>[0];
export type SenpiPendingInputs = Awaited<ReturnType<RpcClient["getPendingInputs"]>>;
export type SenpiSlashCommand = Awaited<ReturnType<RpcClient["getCommands"]>>[number];

/** Facade methods an older client may not carry; a missing one degrades instead of throwing. */
type OptionalClientMethod = "getPendingInputs" | "getCommands" | "setSessionName" | "waitForIdle";

export interface SenpiTransportOptions {
  socketPath?: string;
  keyRoot?: string;
  width?: number;
  capabilities?: readonly string[];
  onEvent?: (event: SenpiClientEvent) => void;
  onDisconnect?: (error: SenpiTransportError) => void;
}

export interface SenpiOpenSessionOptions {
  sessionPath?: string;
  cwd?: string;
  retainOnDisconnect?: boolean;
}

export interface SenpiConnectResult {
  socketPath: string;
  keyRoot: string;
  width: number;
  capabilities: readonly string[];
}

export function defaultKeyRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OMO_BRIDGE_KEY_ROOT?.trim();
  if (explicit) return explicit;
  const agentDir = env.OMO_CODING_AGENT_DIR?.trim();
  if (agentDir) return agentDir;
  return join(homedir(), ".omo", "agent");
}

const SHARED_SOCKET_SUFFIX = join(".omo", "agent", "rpc", "rpc.sock");

function assertPrivateSocket(socketPath: string): void {
  if (socketPath.endsWith(SHARED_SOCKET_SUFFIX)) {
    throw new SenpiTransportError(
      "shared_socket_forbidden",
      `refusing to connect to the shared senpi daemon socket ${socketPath}; the bridge only uses its own private socket`,
    );
  }
}

export class SenpiTransport {
  readonly raw: RawChannel;

  private readonly socketPath: string | undefined;
  private readonly keyRoot: string;
  private readonly width: number;
  private readonly capabilities: readonly string[];
  private readonly eventListeners = new Set<(event: SenpiClientEvent) => void>();
  private readonly disconnectListeners = new Set<(error: SenpiTransportError) => void>();
  private client: RpcClient | undefined;
  private unsubscribeClient: (() => void) | undefined;
  private connectedResult: SenpiConnectResult | undefined;
  private sessionIdValue: string | undefined;
  private disposed = false;

  constructor(options: SenpiTransportOptions = {}) {
    this.socketPath = options.socketPath ?? process.env.OMO_BRIDGE_SENPI_SOCKET?.trim() ?? undefined;
    this.keyRoot = options.keyRoot ?? defaultKeyRoot();
    this.width = options.width ?? DEFAULT_CLIENT_WIDTH;
    this.capabilities = options.capabilities ?? DEFAULT_CLIENT_CAPABILITIES;
    if (options.onEvent) this.eventListeners.add(options.onEvent);
    if (options.onDisconnect) this.disconnectListeners.add(options.onDisconnect);
    this.raw = new RawChannel({
      socketPath: this.socketPath,
      keyRoot: this.keyRoot,
      width: this.width,
      capabilities: this.capabilities,
      onDisconnect: (error) => this.emitDisconnect(error),
    });
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  get clientCapabilities(): readonly string[] {
    return this.capabilities;
  }

  async connect(): Promise<SenpiConnectResult> {
    if (this.connectedResult) return this.connectedResult;
    if (this.disposed) {
      throw new SenpiTransportError("transport_gone", "the senpi transport was disposed");
    }
    const socketPath = this.socketPath;
    if (!socketPath) {
      throw new SenpiTransportError(
        "socket_missing",
        "OMO_BRIDGE_SENPI_SOCKET is not set; the bridge only talks to a private senpi socket",
      );
    }
    assertPrivateSocket(socketPath);
    assertPrivateSocketExists(socketPath);

    const client = new RpcClient({
      socketPath,
      keyRoot: this.keyRoot,
      onDisconnect: (error) => {
        this.connectedResult = undefined;
        this.sessionIdValue = undefined;
        this.client = undefined;
        this.emitDisconnect(mapSenpiError(error));
      },
    });
    // Track the client before the attempt can fail, so dispose() covers an in-flight connect too.
    this.client = client;
    try {
      await client.start();
      await client.setClientInfo(this.width, [...this.capabilities]);
    } catch (error) {
      if (this.client === client) this.client = undefined;
      await client.stop().catch(() => undefined);
      throw mapSenpiError(error);
    }
    if (this.disposed) {
      if (this.client === client) this.client = undefined;
      await client.stop().catch(() => undefined);
      throw new SenpiTransportError("transport_gone", "the senpi transport was disposed while connecting");
    }
    this.unsubscribeClient = client.onEvent((event) => {
      for (const listener of this.eventListeners) listener(event);
    });
    try {
      await this.raw.connect();
    } catch (error) {
      this.unsubscribeClient?.();
      this.unsubscribeClient = undefined;
      this.client = undefined;
      await client.stop().catch(() => undefined);
      throw mapSenpiError(error);
    }
    this.connectedResult = {
      socketPath,
      keyRoot: this.keyRoot,
      width: this.width,
      capabilities: this.capabilities,
    };
    return this.connectedResult;
  }

  async openSession(options: SenpiOpenSessionOptions = {}): Promise<SenpiOpenSessionResult> {
    const client = this.requireClient();
    const wireOptions: Parameters<RpcClient["openSession"]>[0] = {
      retain_on_disconnect: options.retainOnDisconnect ?? true,
      ...(options.sessionPath === undefined ? {} : { sessionPath: options.sessionPath }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
    try {
      const opened = await client.openSession(wireOptions);
      this.sessionIdValue = opened.sessionId;
      return opened;
    } catch (error) {
      throw mapSenpiError(error);
    }
  }

  listSessions(): Promise<SenpiSessionSummary[]> {
    return this.call((client) => client.listSessions());
  }

  prompt(message: string, options?: SenpiPromptOptions): Promise<SenpiPromptResult> {
    return this.callSession((client) =>
      options === undefined ? client.prompt(message) : client.prompt(message, options),
    );
  }

  steer(message: string, images?: SenpiImages, recovery?: SenpiSteerRecovery): Promise<SenpiQueuedDisposition> {
    return this.callSession((client) => client.steer(message, images, recovery));
  }

  followUp(message: string, images?: SenpiImages, recovery?: SenpiSteerRecovery): Promise<SenpiQueuedDisposition> {
    return this.callSession((client) => client.followUp(message, images, recovery));
  }

  abort(options?: SenpiAbortOptions): Promise<SenpiAbortAnswer> {
    return this.call(async (client) => {
      if (options === undefined) {
        await client.abort();
        return undefined as SenpiAbortAnswer;
      }
      return client.abort(options);
    });
  }

  getState(): Promise<SenpiSessionState> {
    return this.callSession((client) => client.getState());
  }

  getEntries(since?: string, page?: SenpiEntriesPage): Promise<SenpiEntriesResult> {
    return this.callSession((client) => client.getEntries(since, page));
  }

  getMessages(): Promise<SenpiMessages> {
    return this.callSession((client) => client.getMessages());
  }

  setModel(provider: string, modelId: string): Promise<SenpiSelectedModel> {
    return this.callSession((client) => client.setModel(provider, modelId));
  }

  getAvailableModels(): Promise<SenpiModelInfo[]> {
    return this.call((client) => client.getAvailableModels());
  }

  /** The host's slash-command surface; a client without the command answers an empty surface. */
  async getCommands(): Promise<SenpiSlashCommand[]> {
    const listed = await this.callWhenSupported("getCommands", (client) => client.getCommands());
    return listed ?? [];
  }

  /**
   * The pending inputs in durable custody. A client older than the pending-input ledger has no such
   * method: the answer is undefined, which the inbox handler renders as an empty list.
   */
  async getPendingInputs(knownClientMessageIds?: readonly string[]): Promise<SenpiPendingInputs | undefined> {
    return this.callWhenSupported("getPendingInputs", (client) => client.getPendingInputs(knownClientMessageIds));
  }

  /** Rename the attached session; a client without the command leaves the name alone. */
  async setSessionName(name: string): Promise<void> {
    await this.callWhenSupported("setSessionName", (client) => client.setSessionName(name), { session: true });
  }

  /**
   * Resolve once the session is idle. A client without the wait resolves at once: there is nothing
   * this facade can wait on, and a missing method must not turn a wait into a failure.
   */
  async waitForIdle(timeout?: number): Promise<void> {
    await this.callWhenSupported("waitForIdle", (client) => client.waitForIdle(timeout));
  }

  sendExtensionUIResponse(response: SenpiExtensionUIResponse): Promise<void> {
    return this.call((client) => client.sendExtensionUIResponse(response));
  }

  onEvent(listener: (event: SenpiClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onDisconnect(listener: (error: SenpiTransportError) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.raw.close();
    this.unsubscribeClient?.();
    this.unsubscribeClient = undefined;
    const client = this.client;
    this.client = undefined;
    this.connectedResult = undefined;
    this.sessionIdValue = undefined;
    if (client) await client.stop();
  }

  private requireClient(): RpcClient {
    if (!this.client) {
      throw new SenpiTransportError("not_connected", "call connect() before using the senpi transport");
    }
    return this.client;
  }

  private emitDisconnect(error: SenpiTransportError): void {
    for (const listener of this.disconnectListeners) listener(error);
  }

  private async call<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
    try {
      return await operation(this.requireClient());
    } catch (error) {
      throw mapSenpiError(error);
    }
  }

  /**
   * Run one facade call whose client method may be absent on an older client. The client is still
   * required first (a disconnected transport must answer `not_connected`), and a refusal from a
   * present method is mapped exactly like every other call.
   */
  private async callWhenSupported<T>(
    method: OptionalClientMethod,
    operation: (client: RpcClient) => Promise<T>,
    options: { session?: boolean } = {},
  ): Promise<T | undefined> {
    const client = this.requireClient();
    if (options.session === true && this.sessionIdValue === undefined) {
      throw new SenpiTransportError("no_session", "call openSession() before this command");
    }
    if (typeof (client as unknown as Record<string, unknown>)[method] !== "function") return undefined;
    try {
      return await operation(client);
    } catch (error) {
      throw mapSenpiError(error);
    }
  }

  private callSession<T>(operation: (client: RpcClient) => Promise<T>): Promise<T> {
    return this.call((client) => {
      if (this.sessionIdValue === undefined) {
        throw new SenpiTransportError("no_session", "call openSession() before this command");
      }
      return operation(client);
    });
  }
}
