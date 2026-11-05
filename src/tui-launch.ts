import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BRIDGE_BASIC_USERNAME, resolveStateDir } from "./launcher";

// The TUI keys its persisted tabs by channel (`<XDG_STATE_HOME>/opencode/<channel>/tui`), so two
// backends sharing a channel share one tab list. A tab opened against the real opencode service then
// carries a session id the bridge does not have, and every switch surfaces "session not found". The
// bridge cannot change the TUI, so it owns the launch recipe and gives each bridge state directory its
// own channel.

export const DEFAULT_TUI_DIR = "/Users/zyno/OmO Projects/my-tui/opencode";

export type BridgeStateFile = {
  readonly url: string;
  readonly password: string;
  readonly pid?: number;
};

export function channelForStateDir(stateDir: string): string {
  const digest = createHash("sha256").update(resolve(stateDir), "utf8").digest("hex").slice(0, 8);
  return `bridge-${digest}`;
}

export function tuiDirFrom(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMO_BRIDGE_TUI_DIR?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return DEFAULT_TUI_DIR;
}

export function tuiBunFrom(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMO_BRIDGE_TUI_BUN?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  return process.execPath;
}

export class TuiLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TuiLaunchError";
  }
}

async function readBridgeState(stateDir: string): Promise<BridgeStateFile> {
  const file = Bun.file(resolve(stateDir, "bridge.json"));
  if (!(await file.exists())) {
    throw new TuiLaunchError(`no bridge.json in ${stateDir}: start the bridge first (bun run bin/omo-bridge start)`);
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (error) {
    throw new TuiLaunchError(`bridge.json in ${stateDir} is not readable JSON: ${String(error)}`);
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const url = typeof record.url === "string" ? record.url : undefined;
  const password = typeof record.password === "string" ? record.password : undefined;
  if (url === undefined || password === undefined) {
    throw new TuiLaunchError(`bridge.json in ${stateDir} carries no url/password pair`);
  }
  return { url, password, pid: typeof record.pid === "number" ? record.pid : undefined };
}

export async function runTui(argv: readonly string[]): Promise<void> {
  const stateDir = resolveStateDir(process.env);
  const state = await readBridgeState(stateDir);
  const dir = tuiDirFrom();
  if (!existsSync(dir)) {
    throw new TuiLaunchError(
      `the TUI checkout is not at ${dir}; set OMO_BRIDGE_TUI_DIR to the my-tui opencode checkout`,
    );
  }
  const channel = channelForStateDir(stateDir);
  const bun = tuiBunFrom();
  // Any child the TUI spawns resolves `bun` from PATH; the OmO runtime wrapper cannot dlopen the
  // fork's ad-hoc-signed libopentui, so the TUI's own bun has to come first.
  const bunDir = dirname(bun);
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && entry !== bunDir)
    .join(":");
  const child = Bun.spawn([bun, "run", "dev", "--server", state.url, ...argv], {
    cwd: dir,
    env: {
      ...process.env,
      PATH: path.length > 0 ? `${bunDir}:${path}` : bunDir,
      OPENCODE_PASSWORD: state.password,
      OPENCODE_TUI_CHANNEL: channel,
      TERM: process.env.TERM ?? "xterm-256color",
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  process.exitCode = code;
  console.error(`omo-bridge: TUI exited ${code} (channel ${channel}, basic user ${BRIDGE_BASIC_USERNAME})`);
}
