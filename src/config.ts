export type Config = {
  port: number;
  host: string;
  password: string;
  stateDir: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_PORT = 4319;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_STATE_DIR = "./state";
const PASSWORD_REQUIRED = "OMO_BRIDGE_PASSWORD is required";

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`OMO_BRIDGE_PORT must be an integer between 0 and 65535 (found ${JSON.stringify(raw)})`);
  }
  return port;
}

function readHost(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_HOST;
  return raw;
}

function readStateDir(raw: string | undefined): string {
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_STATE_DIR;
  return raw;
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): Config {
  const password = env.OMO_BRIDGE_PASSWORD;
  if (password === undefined || password.length === 0) throw new ConfigError(PASSWORD_REQUIRED);
  return {
    port: readPort(env.OMO_BRIDGE_PORT),
    host: readHost(env.OMO_BRIDGE_HOST),
    password,
    stateDir: readStateDir(env.OMO_BRIDGE_STATE_DIR),
  };
}

export const configDefaults = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  stateDir: DEFAULT_STATE_DIR,
} as const;
