import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

const OMO_RUNTIME_MARKERS = ["/Applications/OmO.app/", "/.omo/binary-runtime/", "/.omo/agent/bundled-bun/"];

/** The OmO runtime bundles a `bun` that cannot dlopen the fork's libopentui, so it is never the TUI's. */
export function isOmoRuntimeBun(path: string): boolean {
  return OMO_RUNTIME_MARKERS.some((marker) => path.includes(marker));
}

export function tuiBunFrom(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OMO_BRIDGE_TUI_BUN?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  for (const entry of (env.PATH ?? "").split(":")) {
    if (entry.length === 0) continue;
    const candidate = join(entry, "bun");
    if (isOmoRuntimeBun(candidate)) continue;
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
}

/**
 * `process.cwd()` answers the physical path, so a directory the launcher compares against it has to be
 * physical too: a symlinked checkout would otherwise answer a different string for the same folder.
 */
function physicalPath(directory: string): string {
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}

function devScriptOf(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const script = parsed.scripts?.dev;
    return typeof script === "string" ? script : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The directory a launched TUI reports as its project. The app reads its default location from its own
 * process cwd (`packages/tui/src/app.tsx:228`), and `tui` runs the checkout's `dev` script, so the
 * answer is the `--cwd` that script gives its child - the fork's `dev` is `bun run --cwd packages/cli
 * src/index.ts` - not the directory the launcher itself was started in. A session filed elsewhere
 * answers another `location.directory`, which the client turns into its catalog key: the sync lands on
 * one key and dialogs read another, which emptied `/models`.
 */
export function tuiProjectDir(dir: string): string {
  const script = devScriptOf(dir);
  const match = script === undefined ? null : /--cwd[= ]+([^\s'"]+)/.exec(script);
  return physicalPath(match === null ? dir : resolve(dir, match[1]!));
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

/**
 * The TUI only submits from a session pane: its composer keymap layer is disabled on the home screen,
 * so `omo-bridge tui` without a session starts an app where Enter does nothing at all.
 */
export function tuiArgs(argv: readonly string[], sessionID: string | undefined): string[] {
  if (sessionID === undefined || argv.includes("--session")) return [...argv];
  return [...argv, "--session", sessionID];
}

type SessionListBody = { data?: Array<{ id?: unknown; location?: { directory?: unknown } }> };

export type EnsureTuiSessionOptions = {
  readonly url: string;
  readonly password: string;
  readonly cwd: string;
  fetch?: typeof fetch;
};

/** How many recent sessions a launch looks through for one filed at the TUI's project directory. */
const REUSE_SCAN_LIMIT = 50;

function sessionFiledIn(body: SessionListBody, directory: string): string | undefined {
  const rows = Array.isArray(body.data) ? body.data : [];
  for (const row of rows) {
    const id = row?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    if (row.location?.directory === directory) return id;
  }
  return undefined;
}

/**
 * Reuses the session the TUI opened last, or creates one, so the app lands with a live session. It
 * must be filed in the directory the app runs in: that directory is both the session's
 * `location.directory` and the app's default location, and the client keys every location catalog by
 * it. Reusing a session filed elsewhere lands the app on the other key, where `/models` reads nothing.
 */
export async function ensureTuiSession(options: EnsureTuiSessionOptions): Promise<string> {
  const call = options.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${BRIDGE_BASIC_USERNAME}:${options.password}`, "utf8").toString("base64")}`;
  const listed = await call(`${options.url}/api/session?limit=${REUSE_SCAN_LIMIT}`, { headers: { authorization: auth } });
  if (!listed.ok) {
    throw new TuiLaunchError(`the bridge refused to list sessions: ${listed.status}`);
  }
  const list = (await listed.json()) as SessionListBody;
  const existing = sessionFiledIn(list, options.cwd);
  if (existing !== undefined) return existing;
  const id = `ses_tui_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const created = await call(`${options.url}/api/session`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ id, title: "tui", location: { directory: options.cwd } }),
  });
  if (!created.ok) {
    throw new TuiLaunchError(`the bridge refused to create a session: ${created.status}`);
  }
  const body = (await created.json()) as { data?: { id?: unknown } };
  return typeof body.data?.id === "string" && body.data.id.length > 0 ? body.data.id : id;
}

export async function runTui(argv: readonly string[]): Promise<void> {  const stateDir = resolveStateDir(process.env);
  const state = await readBridgeState(stateDir);
  const dir = tuiDirFrom();
  if (!existsSync(dir)) {
    throw new TuiLaunchError(
      `the TUI checkout is not at ${dir}; set OMO_BRIDGE_TUI_DIR to the my-tui opencode checkout`,
    );
  }
  const channel = channelForStateDir(stateDir);
  const bun = tuiBunFrom();
  const sessionID = argv.includes("--session")
    ? undefined
    : await ensureTuiSession({ url: state.url, password: state.password, cwd: tuiProjectDir(dir) });
  // Any child the TUI spawns resolves `bun` from PATH; the OmO runtime wrapper cannot dlopen the
  // fork's ad-hoc-signed libopentui, so the TUI's own bun has to come first.
  const bunDir = dirname(bun);
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && entry !== bunDir)
    .join(":");
  const child = Bun.spawn([bun, "run", "dev", "--server", state.url, ...tuiArgs(argv, sessionID)], {
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
