import { resolveConfig, type Config } from "./config";
import { setSessionReadTransport } from "./http/handlers/sessions";
import { setSessionWriteTransport } from "./http/handlers/prompt";
import { createServer, type BridgeServer } from "./http/server";
import { SessionMap } from "./model/session-map";
import { SenpiTransport, defaultKeyRoot } from "./senpi/transport";

export type BridgeRuntime = {
  config: Config;
  server: BridgeServer;
  transport: SenpiTransport | undefined;
  sessionMap: SessionMap;
  close: () => Promise<void>;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Without OMO_BRIDGE_SENPI_SOCKET the server still starts and session routes answer 503. */
export async function createRuntime(env: NodeJS.ProcessEnv = process.env): Promise<BridgeRuntime> {
  const config = resolveConfig(env);
  const agentDir = defaultKeyRoot(env);
  const socketPath = env.OMO_BRIDGE_SENPI_SOCKET?.trim();

  let transport: SenpiTransport | undefined;
  if (socketPath !== undefined && socketPath.length > 0) {
    const candidate = new SenpiTransport({ socketPath, keyRoot: agentDir });
    try {
      // connect() also declares this client's width and capabilities (setClientInfo).
      await candidate.connect();
      transport = candidate;
    } catch (error) {
      await candidate.dispose().catch(() => undefined);
      console.warn(`omo-bridge: senpi transport not connected (${socketPath}): ${messageOf(error)}`);
    }
  }

  setSessionReadTransport(transport);
  setSessionWriteTransport(transport);
  const sessionMap = SessionMap.open({ stateDir: config.stateDir, agentDir });
  const server = createServer(config);

  let closed = false;
  return {
    config,
    server,
    transport,
    sessionMap,
    close: async () => {
      if (closed) return;
      closed = true;
      setSessionReadTransport(undefined);
      setSessionWriteTransport(undefined);
      try {
        await transport?.dispose();
      } finally {
        server.stop(true);
      }
    },
  };
}
