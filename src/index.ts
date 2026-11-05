import { type Config, ConfigError, resolveConfig } from "./config";
import { createServer } from "./http/server";

function main(): void {
  let config: Config;
  try {
    config = resolveConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`omo-bridge: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  const server = createServer(config);
  console.log(`omo-bridge listening on http://${config.host}:${server.port}`);

  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
