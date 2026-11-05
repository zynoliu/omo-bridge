import { ConfigError } from "./config";
import { createRuntime, type BridgeRuntime } from "./runtime";

async function main(): Promise<void> {
  let runtime: BridgeRuntime;
  try {
    runtime = await createRuntime();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`omo-bridge: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const { config, server } = runtime;
  console.log(`omo-bridge listening on http://${config.host}:${server.port}`);
  if (runtime.transport === undefined) {
    console.warn("omo-bridge: no senpi transport (OMO_BRIDGE_SENPI_SOCKET is unset); session routes answer 503");
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`omo-bridge: ${signal} received, shutting down`);
    void runtime.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`omo-bridge: shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(0);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

void main();
