import type { RpcClient, RpcCommand, RpcResponse } from "@code-yeongyu/senpi";
import { SenpiTransportError, mapSenpiError } from "./errors";
import { assertPrivateSocketExists } from "./socket-path";

export const SENPI_PACKAGE_ROOT_URL = new URL(import.meta.resolve("@code-yeongyu/senpi"));
// `AttachClient` is not a root export and the package `exports` map blocks `./dist/*`, so the only
// reachable spelling is the resolved package root plus the internal module path.
export const ATTACH_CLIENT_MODULE_URL = new URL("./modes/interactive/attach-client.js", SENPI_PACKAGE_ROOT_URL).href;
const RPC_AUTH_MODULE_URL = new URL("./modes/rpc/rpc-auth-client.js", SENPI_PACKAGE_ROOT_URL).href;

export interface AttachClientInstance {
  connect(path: string): Promise<void>;
  request(command: RpcCommand & { observe?: boolean }): Promise<RpcResponse>;
  close(): void;
}

export type AttachClientConstructor = new (
  onRecord: (record: unknown) => void,
  onDisconnect: (reason?: string) => void,
  options?: { answerDeadlineMs?: number },
) => AttachClientInstance;

interface RpcAuthModule {
  withRpcKeyRoot<T>(root: string, operation: () => Promise<T>): Promise<T>;
}

let attachClientConstructor: Promise<AttachClientConstructor> | undefined;
let rpcAuthModule: Promise<RpcAuthModule> | undefined;

export function loadAttachClient(): Promise<AttachClientConstructor> {
  attachClientConstructor ??= import(ATTACH_CLIENT_MODULE_URL).then((module: unknown) => {
    const candidate = (module as Record<string, unknown>).AttachClient;
    if (typeof candidate !== "function") {
      throw new SenpiTransportError(
        "attach_unavailable",
        `the resolved senpi package does not export AttachClient from ${ATTACH_CLIENT_MODULE_URL}`,
      );
    }
    return candidate as AttachClientConstructor;
  });
  return attachClientConstructor;
}

function loadRpcAuthModule(): Promise<RpcAuthModule> {
  rpcAuthModule ??= import(RPC_AUTH_MODULE_URL).then((module: unknown) => {
    const candidate = (module as Record<string, unknown>).withRpcKeyRoot;
    if (typeof candidate !== "function") {
      throw new SenpiTransportError(
        "attach_unavailable",
        `the resolved senpi package does not export withRpcKeyRoot from ${RPC_AUTH_MODULE_URL}`,
      );
    }
    return module as RpcAuthModule;
  });
  return rpcAuthModule;
}

/** Import-time assertion that the absolute-path AttachClient import still resolves. */
export const attachClientStartup = loadAttachClient();

export interface RawChannelOptions {
  socketPath: string | undefined;
  keyRoot: string;
  width: number;
  capabilities: readonly string[];
  onRecord?: (record: unknown) => void;
  onDisconnect?: (error: SenpiTransportError) => void;
}

/**
 * The command surface `RpcClient` does not expose (multi-session routing and per-item queue edits),
 * sent over its own `AttachClient` socket bound to the same private host.
 */
export class RawChannel {
  private client: AttachClientInstance | undefined;
  private readonly options: RawChannelOptions;
  private readonly recordListeners = new Set<(record: unknown) => void>();

  constructor(options: RawChannelOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const socketPath = this.options.socketPath;
    if (!socketPath) {
      throw new SenpiTransportError(
        "socket_missing",
        "OMO_BRIDGE_SENPI_SOCKET is not set; the bridge only talks to a private senpi socket",
      );
    }
    assertPrivateSocketExists(socketPath);
    const [AttachClient, auth] = await Promise.all([loadAttachClient(), loadRpcAuthModule()]);
    const client = new AttachClient(
      (record) => {
        for (const listener of this.recordListeners) listener(record);
        this.options.onRecord?.(record);
      },
      (reason) => {
        if (this.client !== client) return;
        this.client = undefined;
        this.options.onDisconnect?.(
          new SenpiTransportError("transport_gone", reason ?? "the raw senpi channel disconnected"),
        );
      },
    );
    try {
      await auth.withRpcKeyRoot(this.options.keyRoot, () => client.connect(socketPath));
    } catch (error) {
      client.close();
      throw mapSenpiError(error);
    }
    this.client = client;
    try {
      await this.setClientInfo(this.options.width, this.options.capabilities);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  onRecord(listener: (record: unknown) => void): () => void {
    this.recordListeners.add(listener);
    return () => {
      this.recordListeners.delete(listener);
    };
  }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    const client = this.client;
    if (!client) {
      throw new SenpiTransportError("not_connected", "the raw senpi channel is not connected");
    }
    try {
      const response = await client.request(command);
      if (!response.success) {
        throw mapSenpiError(
          Object.assign(new Error(response.error), { code: response.errorCode, name: "RpcCommandError" }),
        );
      }
      const answer = response as { readonly data?: unknown };
      return (answer.data ?? {}) as T;
    } catch (error) {
      throw mapSenpiError(error);
    }
  }

  interrupt(command: { turnId?: string; intent?: "stop" | "abort" } = {}): Promise<unknown> {
    return this.request({ type: "interrupt", ...command });
  }

  dequeueMessage(
    queuedId: string,
    options: { expectedRevision?: number; effectId?: string } = {},
  ): Promise<unknown> {
    return this.request({ type: "dequeue_message", queuedId, ...options });
  }

  editQueuedMessage(
    queuedId: string,
    text: string,
    options: { expectedRevision?: number; effectId?: string } = {},
  ): Promise<unknown> {
    return this.request({ type: "edit_queued_message", queuedId, text, ...options });
  }

  attachSession(
    sessionId: string,
    durableSessionId: string,
    options: { expectedHostInstance?: string; admissionId?: string; retry?: true } = {},
  ): Promise<unknown> {
    return this.request({ type: "attach_session", sessionId, durableSessionId, ...options });
  }

  subscribeSessions(
    options: {
      sessions?: "all" | { ids: string[] } | { childrenOf: string };
      include_workers?: boolean;
      include_context?: boolean;
    } = {},
  ): Promise<unknown> {
    return this.request({ type: "subscribe_sessions", ...options });
  }

  async setClientInfo(width: number, capabilities: readonly string[] = this.options.capabilities): Promise<void> {
    await this.request({ type: "set_client_info", width, capabilities: [...capabilities] });
  }

  close(): void {
    const client = this.client;
    this.client = undefined;
    client?.close();
  }
}

export type SenpiRpcClient = RpcClient;
