import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { resolveConfig, type Config } from "./config";
import {
  setSessionInboxTransport,
  type InboxCommand,
  type SessionInboxTransport,
} from "./http/handlers/inbox";
import { setSessionWriteTransport, type PromptCommand, type SessionWriteTransport } from "./http/handlers/prompt";
import { setSessionReadTransport, type SessionReadTransport } from "./http/handlers/sessions";
import { setSessionManagementTransport } from "./http/handlers/session-write";
import { createRuntime, type BridgeRuntime } from "./runtime";
import { SenpiTransportError, mapSenpiError } from "./senpi/errors";
import type {
  SenpiAbortAnswer,
  SenpiAbortOptions,
  SenpiOpenSessionOptions,
  SenpiOpenSessionResult,
  SenpiTransport,
} from "./senpi/transport";

// Launcher and lifecycle for the bridge process.
//
// The bridge never talks to a machine-wide daemon: it ensures a private senpi host on
// `<stateDir>/senpi.sock`, started from `<repo>/launch-spec.json`, and records how to reach itself
// in `<stateDir>/bridge.json`. `start` runs in the foreground, `status` probes the recorded bridge,
// and `stop` ends only the recorded pid and socket.
//
// Launch spec shape (docs/rpc.md, "Launch spec (--launch-spec <file>)"):
//   {
//     "spec_version": 1,
//     "core": { "session_runtime": "in-process", "multi_session": true, "extensions": ["."] },
//     "tunables": { "idleExitMs": 900000, "coldStart": "transient" },
//     "env": { "OMO_NATIVE": "1" }
//   }
// The pinned senpi package exports `parseHostLaunchSpec`/`loadHostLaunchSpec` at runtime, but its
// published `dist/index.d.ts` does not declare them, so this module validates the document
// structurally (and calls the runtime parser when it is present) instead of importing the types.

export const BRIDGE_STATE_FILE = "bridge.json";
export const PRIVATE_SOCKET_NAME = "senpi.sock";
export const DEFAULT_LAUNCH_SPEC = "launch-spec.json";
export const BRIDGE_STATE_MODE = 0o600;
export const STATE_DIR_MODE = 0o700;
export const BRIDGE_BASIC_USERNAME = "opencode";

const DEFAULT_STATE_DIR = "./state";
const ENABLE_COMMAND_TIMEOUT_MS = 60_000;
const STOP_COMMAND_TIMEOUT_MS = 15_000;
const SOCKET_WAIT_TIMEOUT_MS = 10_000;
const TERMINATE_TIMEOUT_MS = 5_000;
const STATUS_PROBE_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 50;
const DEFAULT_RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 5_000] as const;

// Variables an omo/senpi CLI child must never inherit:
// - BUN_BE_BUN and SENPI_RPC_INTERNAL_KEY_STDIN make the CLI believe it is a supervised host and
//   abort with `internal_key_unavailable` before it parses argv.
// - SENPI_RPC_HOST_* is the lifecycle/watch identity of the host this bridge process runs inside.
// - PI_SESSION_*, PI_GOAL_STORE_FILE, PI_PROVIDER, PI_MODEL and the reasoning knobs are transient
//   session context that must not cross into a daemon (docs/rpc.md, "Daemon environment scope").
const STRIPPED_ENV_KEYS: ReadonlySet<string> = new Set([
  "BUN_BE_BUN",
  "SENPI_RPC_INTERNAL_KEY_STDIN",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_SESSION_CWD",
  "PI_GOAL_STORE_FILE",
  "PI_PROVIDER",
  "PI_MODEL",
  "PI_REASONING_LEVEL",
  "PI_PROMPT_CACHE_SAFE_WAIT_SECONDS",
]);
const STRIPPED_ENV_PREFIXES: readonly string[] = ["SENPI_RPC_HOST_"];
const SPEC_ENV_NAME = /^(SENPI|OMO|PI)_[A-Z0-9_]+$/u;

export class LauncherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export type BridgeState = {
  url: string;
  pid: number;
  password: string;
  socket: string;
};

export type LaunchSpecDocument = {
  spec_version: 1;
  core: { session_runtime: string; multi_session: true; extensions: string[] };
  tunables?: { idleExitMs?: number; coldStart?: string };
  env?: Record<string, string>;
};

export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type RunCommand = (argv: readonly string[], env: Record<string, string>, timeoutMs: number) => Promise<CommandResult>;
export type SpawnDetached = (argv: readonly string[], env: Record<string, string>) => number;

export type EnsuredHost = {
  socket: string;
  pid: number | undefined;
  mode: "ensure" | "fallback";
};

export type LauncherDeps = {
  createRuntime?: (env: NodeJS.ProcessEnv) => Promise<BridgeRuntime>;
  runCommand?: RunCommand;
  spawnDetached?: SpawnDetached;
  fetch?: typeof fetch;
  isPidAlive?: (pid: number) => boolean;
  reconnectDelaysMs?: readonly number[];
  terminateTimeoutMs?: number;
};

export type StartOptions = {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  stateDir?: string;
  launchSpecPath?: string;
  deps?: LauncherDeps;
};

export type ShutdownReport = {
  stopped: boolean;
  pid: number;
  socket: string;
  host: CommandResult | undefined;
};

export type StartedBridge = {
  readonly config: Config;
  readonly state: BridgeState;
  /** The agent directory this bridge gave the private host (models.json source and RPC key root). */
  readonly agentDir: string;
  readonly runtime: BridgeRuntime;
  readonly host: EnsuredHost;
  readonly recovery: SessionRecovery | undefined;
  /** The transport proxy installed into the http handlers (undefined without a connected host). */
  readonly transport: (SessionReadTransport & SessionWriteTransport & SessionInboxTransport) | undefined;
  /** In-process shutdown: close SSE, dispose the transport, stop the private host. Never kills this pid. */
  readonly stop: () => Promise<ShutdownReport>;
};

export type BridgeStatusReport = {
  running: boolean;
  reachable: boolean;
  stateFile: string;
  pid?: number;
  url?: string;
  socket?: string;
  socketPresent: boolean;
  error?: string;
};

export type BridgeStopReport = {
  stopped: boolean;
  stateFile: string;
  pid?: number;
  socket?: string;
  host?: CommandResult | undefined;
  reason?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}

/**
 * Structural validation of the launch spec document. Mirrors the four refusals documented for
 * `--launch-spec`: malformed documents, an env key outside the brand lane, an extension path that
 * leaves the spec directory, and a missing extension.
 */
export function parseLaunchSpecDocument(text: string, specPath: string): LaunchSpecDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LauncherError(`launch spec is not valid JSON: ${messageOf(error)}`);
  }
  if (!isRecord(parsed)) throw new LauncherError("launch spec must be a JSON object");
  if (parsed.spec_version !== 1) {
    throw new LauncherError(`launch spec spec_version must be 1 (found ${JSON.stringify(parsed.spec_version)})`);
  }
  const core = parsed.core;
  if (!isRecord(core)) throw new LauncherError("launch spec core must be an object");
  if (typeof core.session_runtime !== "string" || core.session_runtime.length === 0) {
    throw new LauncherError("launch spec core.session_runtime must be a non-empty string");
  }
  if (core.multi_session !== true) {
    throw new LauncherError("launch spec core.multi_session must be true: a daemon serves many clients");
  }
  const extensions = stringArray(core.extensions);
  if (extensions === undefined) throw new LauncherError("launch spec core.extensions must be an array of strings");

  const specDir = resolve(dirname(specPath));
  for (const extension of extensions) {
    const absolute = resolve(specDir, extension);
    if (absolute !== specDir && !absolute.startsWith(specDir + sep)) {
      throw new LauncherError(`launch spec extension escapes the spec directory: ${extension}`);
    }
    if (!existsSync(absolute)) throw new LauncherError(`launch spec extension does not exist: ${extension}`);
  }

  let tunables: LaunchSpecDocument["tunables"];
  if (parsed.tunables !== undefined) {
    if (!isRecord(parsed.tunables)) throw new LauncherError("launch spec tunables must be an object");
    tunables = {};
    if (parsed.tunables.idleExitMs !== undefined) {
      if (typeof parsed.tunables.idleExitMs !== "number" || !Number.isFinite(parsed.tunables.idleExitMs)) {
        throw new LauncherError("launch spec tunables.idleExitMs must be a number");
      }
      tunables.idleExitMs = parsed.tunables.idleExitMs;
    }
    if (parsed.tunables.coldStart !== undefined) {
      if (typeof parsed.tunables.coldStart !== "string") {
        throw new LauncherError("launch spec tunables.coldStart must be a string");
      }
      tunables.coldStart = parsed.tunables.coldStart;
    }
  }

  let env: Record<string, string> | undefined;
  if (parsed.env !== undefined) {
    if (!isRecord(parsed.env)) throw new LauncherError("launch spec env must be an object");
    env = {};
    for (const [key, value] of Object.entries(parsed.env)) {
      if (!SPEC_ENV_NAME.test(key)) {
        throw new LauncherError(`launch spec env key is outside the SENPI_/OMO_/PI_ lane: ${key}`);
      }
      if (typeof value !== "string") throw new LauncherError(`launch spec env value for ${key} must be a string`);
      env[key] = value;
    }
  }

  return {
    spec_version: 1,
    core: { session_runtime: core.session_runtime, multi_session: true, extensions },
    ...(tunables === undefined ? {} : { tunables }),
    ...(env === undefined ? {} : { env }),
  };
}

/**
 * Validates the spec file before any host is started. The runtime parser, when the package exposes
 * it, re-proves ownership, modes and extension resolution; its typings are missing from the pinned
 * `dist/index.d.ts`, so it is reached through an untyped view.
 */
export async function validateLaunchSpecFile(specPath: string): Promise<LaunchSpecDocument> {
  if (!existsSync(specPath)) throw new LauncherError(`launch spec not found: ${specPath}`);
  const text = readFileSync(specPath, "utf8");
  const document = parseLaunchSpecDocument(text, specPath);

  const module = (await import("@code-yeongyu/senpi")) as unknown as Record<string, unknown>;
  const parse = module.parseHostLaunchSpec;
  if (typeof parse === "function") {
    try {
      (parse as (value: string) => unknown)(text);
    } catch (error) {
      throw new LauncherError(`launch spec refused by @code-yeongyu/senpi: ${messageOf(error)}`);
    }
  }
  const load = module.loadHostLaunchSpec;
  if (typeof load === "function") {
    try {
      await (load as (value: string) => Promise<unknown>)(specPath);
    } catch (error) {
      throw new LauncherError(`launch spec refused by @code-yeongyu/senpi: ${messageOf(error)}`);
    }
  }
  return document;
}

/** The env an omo/senpi child receives: inherited variables minus every host/session identity. */
export function sanitizeHostEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (STRIPPED_ENV_KEYS.has(key)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  const raw = override ?? env.OMO_BRIDGE_STATE_DIR ?? DEFAULT_STATE_DIR;
  const trimmed = raw.trim();
  return resolve(trimmed.length === 0 ? DEFAULT_STATE_DIR : trimmed);
}

/**
 * The user's real home from the account database, so an isolated `HOME` (a QA harness, a sandbox)
 * cannot move the agent directory the bridge points its private host at.
 */
function realHomeDir(): string {
  try {
    const home = userInfo().homedir;
    if (home.length > 0) return home;
  } catch {
    // No account entry: fall back to the environment's home.
  }
  return homedir();
}

/** The agent directory the private host reads models.json from and publishes its RPC key under. */
export function defaultAgentDir(): string {
  return join(realHomeDir(), ".omo", "agent");
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of [
    "OMO_BRIDGE_AGENT_DIR",
    "OMO_CODING_AGENT_DIR",
    "SENPI_CODING_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OMO_BRIDGE_KEY_ROOT",
  ]) {
    const value = env[key]?.trim();
    if (value !== undefined && value.length > 0) return resolve(value);
  }
  return defaultAgentDir();
}

/**
 * The environment an omo/senpi child receives. The agent directory is always resolved here and
 * written explicitly, so the private host reads the user's real model configuration instead of
 * whatever bare default its own process would pick; every inherited host/session identity is
 * still stripped by `sanitizeHostEnvironment`.
 */
export function privateHostEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { ...sanitizeHostEnvironment(env), OMO_CODING_AGENT_DIR: resolveAgentDir(env) };
}

export function resolveOmoBinary(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OMO_BRIDGE_OMO_BIN?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const configured = env.OMO_BIN?.trim();
  if (configured !== undefined && configured.length > 0 && existsSync(configured)) return configured;
  return "omo";
}

/**
 * Refuses any socket that is not the bridge's own: the machine-wide daemon, its shard endpoints and
 * anything outside the recorded state directory are somebody else's lifecycle.
 */
export function assertPrivateSocket(socket: string, stateDir?: string): string {
  const absolute = resolve(socket);
  const sharedRoot = join(homedir(), ".omo", "agent", "rpc");
  if (absolute === join(sharedRoot, "rpc.sock") || absolute.startsWith(sharedRoot + sep)) {
    throw new LauncherError(`refusing to use the shared senpi socket ${absolute}`);
  }
  if (stateDir !== undefined && dirname(absolute) !== resolve(stateDir)) {
    throw new LauncherError(`refusing to use a socket outside the bridge state directory: ${absolute}`);
  }
  return absolute;
}

export function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

function isBridgeState(value: unknown): value is BridgeState {
  if (!isRecord(value)) return false;
  return (
    typeof value.url === "string" &&
    typeof value.pid === "number" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.password === "string" &&
    typeof value.socket === "string"
  );
}

export function readBridgeState(file: string): BridgeState | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isBridgeState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeBridgeState(file: string, state: BridgeState): void {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: BRIDGE_STATE_MODE });
  renameSync(temporary, file);
  // `mode` on write is filtered by the umask; the state carries the bridge password.
  chmodSync(file, BRIDGE_STATE_MODE);
}

function isPidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes a dead bridge's record so a restart does not inherit it; refuses while it is alive. */
export function cleanStaleBridgeState(file: string, alive: (pid: number) => boolean = isPidAlive): boolean {
  if (!existsSync(file)) return false;
  const state = readBridgeState(file);
  if (state === undefined) {
    unlinkSync(file);
    return true;
  }
  if (alive(state.pid)) {
    throw new LauncherError(`another omo-bridge is already running (pid ${state.pid}, ${state.url})`);
  }
  unlinkSync(file);
  return true;
}

function isSocketFile(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  return existsSync(path);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone: the host stop or the launcher's own shutdown removed it.
  }
}

const defaultRunCommand: RunCommand = async (argv, env, timeoutMs) => {
  const child = Bun.spawn({
    cmd: [...argv],
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    child.kill();
  }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
};

const defaultSpawnDetached: SpawnDetached = (argv, env) => {
  const child = Bun.spawn({
    cmd: [...argv],
    env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.unref();
  return child.pid;
};

/** The last JSON object printed on stdout; `senpi host` writes exactly one such line. */
export function parseJsonLine(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines.reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Diagnostics are not JSON; keep looking for the contract line.
    }
  }
  return undefined;
}

async function waitForSocket(socket: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isSocketFile(socket)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return isSocketFile(socket);
}

export async function ensurePrivateHost(options: {
  socket: string;
  stateDir: string;
  launchSpecPath: string;
  env: NodeJS.ProcessEnv;
  deps?: LauncherDeps;
}): Promise<EnsuredHost> {
  const socket = assertPrivateSocket(options.socket, options.stateDir);
  await validateLaunchSpecFile(options.launchSpecPath);
  if (pathExists(socket) && !isSocketFile(socket)) removeFile(socket);

  const env = privateHostEnvironment(options.env);
  const binary = resolveOmoBinary(options.env);
  const run = options.deps?.runCommand ?? defaultRunCommand;
  const spawn = options.deps?.spawnDetached ?? defaultSpawnDetached;

  const ensured = await run(
    [binary, "host", "ensure", "--socket", socket, "--launch-spec", options.launchSpecPath, "--json"],
    env,
    ENABLE_COMMAND_TIMEOUT_MS,
  ).catch((error: unknown) => ({ exitCode: 1, stdout: "", stderr: messageOf(error) }) satisfies CommandResult);

  const answer = parseJsonLine(ensured.stdout);
  const action = answer?.action;
  const served = ensured.exitCode === 0 && answer?.socket === socket && action !== "error" && action !== "refuse";
  if (served) {
    return {
      socket,
      pid: typeof answer?.pid === "number" ? answer.pid : undefined,
      mode: "ensure",
    };
  }

  // `host ensure` is unavailable (an older CLI, a refused endpoint): a bare multi-session host on
  // the same private socket serves the same wire protocol.
  try {
    const pid = spawn([binary, "--mode", "rpc", "--listen", `unix://${socket}`, "--multi-session"], env);
    if (!(await waitForSocket(socket, SOCKET_WAIT_TIMEOUT_MS))) {
      throw new LauncherError(`the fallback senpi host did not answer on ${socket}`);
    }
    return { socket, pid, mode: "fallback" };
  } catch (error) {
    const detail = ensured.stderr.trim() || ensured.stdout.trim() || "no answer";
    throw new LauncherError(
      `could not start a private senpi host on ${socket} (ensure exit ${ensured.exitCode}: ${detail}): ${messageOf(error)}`,
    );
  }
}

async function stopPrivateHost(
  socket: string,
  stateDir: string,
  env: NodeJS.ProcessEnv,
  deps: LauncherDeps,
): Promise<CommandResult | undefined> {
  const absolute = assertPrivateSocket(socket, stateDir);
  if (!isSocketFile(absolute)) return undefined;
  const run = deps.runCommand ?? defaultRunCommand;
  const sanitized = privateHostEnvironment(env);
  return run(
    [resolveOmoBinary(env), "host", "stop", "--socket", absolute, "--json"],
    sanitized,
    STOP_COMMAND_TIMEOUT_MS,
  ).catch(() => undefined);
}

export type SessionRecoveryState = "attached" | "detached" | "stopped";

export type SessionRecovery = {
  readonly state: SessionRecoveryState;
  readonly detached: boolean;
  readonly attempts: number;
  readonly lastSessionPath: string | undefined;
  onStateChange: (listener: (state: SessionRecoveryState) => void) => () => void;
  waitForState: (target: SessionRecoveryState, timeoutMs?: number) => Promise<void>;
  rememberSession: (sessionPath: string) => void;
  stop: () => void;
};

/**
 * Keeps the HTTP server up while the private host is gone. Reads fail with `transport_gone` (which
 * the handlers render as 503 `ServiceUnavailableError`) until `connect()` and, when a transcript is
 * known, `openSession({ sessionPath })` succeed; the transport's own `onEvent` listeners survive the
 * reconnect, so the event stream resumes without replay.
 */
export function createSessionRecovery(options: {
  transport: SenpiTransport;
  reconnectDelaysMs?: readonly number[];
  onError?: (error: unknown) => void;
}): SessionRecovery {
  const delays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const listeners = new Set<(state: SessionRecoveryState) => void>();
  let state: SessionRecoveryState = "attached";
  let lastSessionPath: string | undefined;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let running = false;

  const notify = (): void => {
    for (const listener of [...listeners]) listener(state);
  };
  const transition = (next: SessionRecoveryState): void => {
    if (state === next) return;
    state = next;
    notify();
  };

  const schedule = (): void => {
    if (stopped || timer !== undefined) return;
    const index = Math.min(Math.max(attempts - 1, 0), delays.length - 1);
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) void attempt();
    }, delays[index] ?? 0);
    // A retry must not keep an otherwise idle process alive.
    (timer as { unref?: () => void }).unref?.();
  };

  const attempt = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    attempts += 1;
    try {
      await options.transport.connect();
      if (stopped) return;
      const sessionPath = lastSessionPath;
      if (sessionPath !== undefined) {
        await options.transport.openSession({ sessionPath, retainOnDisconnect: true });
      }
      if (stopped) return;
      transition("attached");
    } catch (error) {
      if (stopped) return;
      options.onError?.(error);
      transition("detached");
      schedule();
    } finally {
      running = false;
    }
  };

  const unsubscribe = options.transport.onDisconnect(() => {
    if (stopped) return;
    transition("detached");
    schedule();
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    unsubscribe();
    transition("stopped");
  };

  const onStateChange = (listener: (state: SessionRecoveryState) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const waitForState = (target: SessionRecoveryState, timeoutMs = 10_000): Promise<void> => {
    if (state === target) return Promise.resolve();
    return new Promise<void>((resolveWait, rejectWait) => {
      const deadline = setTimeout(() => {
        unsubscribeWait();
        rejectWait(new Error(`timed out waiting for the senpi session to become ${target}`));
      }, timeoutMs);
      const unsubscribeWait = onStateChange((next) => {
        if (next !== target) return;
        clearTimeout(deadline);
        unsubscribeWait();
        resolveWait();
      });
    });
  };

  return {
    get state() {
      return state;
    },
    get detached() {
      return state !== "attached";
    },
    get attempts() {
      return attempts;
    },
    get lastSessionPath() {
      return lastSessionPath;
    },
    onStateChange,
    waitForState,
    rememberSession(sessionPath) {
      const trimmed = sessionPath.trim();
      if (trimmed.length > 0) lastSessionPath = trimmed;
    },
    stop,
  };
}

function sessionPathOf(opened: SenpiOpenSessionResult): string | undefined {
  if (typeof opened !== "object" || opened === null) return undefined;
  const value = (opened as { sessionPath?: unknown }).sessionPath;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function createTransportProxy(
  transport: SenpiTransport,
  recovery: SessionRecovery,
): SessionReadTransport & SessionWriteTransport & SessionInboxTransport {
  const call = <T>(operation: (target: SenpiTransport) => Promise<T>): Promise<T> => {
    if (recovery.state !== "attached") {
      return Promise.reject(
        new SenpiTransportError("transport_gone", "the private senpi host is detached; reconnecting in the background"),
      );
    }
    return operation(transport).catch((error: unknown) => {
      throw mapSenpiError(error);
    });
  };

  return {
    get sessionId(): string | undefined {
      return transport.sessionId;
    },
    get streaming(): boolean {
      return transport.streaming;
    },
    listSessions: () => call((target) => target.listSessions()),
    getState: () => call((target) => target.getState()),
    getEntries: (since, page) => call((target) => target.getEntries(since, page)),
    getMessages: () => call((target) => target.getMessages()),
    async waitForIdle(timeout) {
      await call((target) => target.waitForIdle(timeout));
    },
    async openSession(options?: SenpiOpenSessionOptions): Promise<SenpiOpenSessionResult> {
      const opened = await call((target) => target.openSession(options));
      const sessionPath = options?.sessionPath ?? sessionPathOf(opened);
      if (sessionPath !== undefined) recovery.rememberSession(sessionPath);
      return opened;
    },
    abort: (options?: SenpiAbortOptions) => call((target) => target.abort(options)),
    getPendingInputs: (knownClientMessageIds?: readonly string[]) =>
      call((target) => target.getPendingInputs(knownClientMessageIds)),
    prompt: (message, options) => call((target) => target.prompt(message, options)),
    steer: (message, images, steerOptions) => call((target) => target.steer(message, images, steerOptions)),
    followUp: (message, images, steerOptions) => call((target) => target.followUp(message, images, steerOptions)),
    async setSessionName(name: string): Promise<void> {
      await call((target) => target.setSessionName(name));
    },
    raw: {
      // One channel backs both the prompt and inbox command sets; the facade's RawChannel accepts
      // every RpcCommand, so the union is the honest type for the proxy.
      request: <T>(command: PromptCommand | InboxCommand) => call((target) => target.raw.request<T>(command)),
    },
  };
}

function clearHandlerTransports(): void {
  setSessionReadTransport(undefined);
  setSessionWriteTransport(undefined);
  setSessionInboxTransport(undefined);
  setSessionManagementTransport(undefined);
}

function installHandlerTransports(proxy: SessionReadTransport & SessionWriteTransport & SessionInboxTransport): void {
  setSessionReadTransport(proxy);
  setSessionWriteTransport(proxy);
  setSessionInboxTransport(proxy);
}

export async function start(options: StartOptions = {}): Promise<StartedBridge> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? {};
  const repoRoot = options.repoRoot ?? dirname(import.meta.dir);
  const stateDir = resolveStateDir(env, options.stateDir);
  const socket = join(stateDir, PRIVATE_SOCKET_NAME);
  const stateFile = join(stateDir, BRIDGE_STATE_FILE);
  const launchSpecPath = options.launchSpecPath ?? join(repoRoot, DEFAULT_LAUNCH_SPEC);

  mkdirSync(stateDir, { recursive: true, mode: STATE_DIR_MODE });
  cleanStaleBridgeState(stateFile, deps.isPidAlive);

  const password = env.OMO_BRIDGE_PASSWORD !== undefined && env.OMO_BRIDGE_PASSWORD.length > 0
    ? env.OMO_BRIDGE_PASSWORD
    : generatePassword();
  const config = resolveConfig({ ...env, OMO_BRIDGE_PASSWORD: password, OMO_BRIDGE_STATE_DIR: stateDir });

  const host = await ensurePrivateHost({ socket, stateDir, launchSpecPath, env, deps });
  const agentDir = resolveAgentDir(env);

  const runtimeEnv: NodeJS.ProcessEnv = {
    ...env,
    OMO_BRIDGE_PASSWORD: password,
    OMO_BRIDGE_STATE_DIR: stateDir,
    OMO_BRIDGE_SENPI_SOCKET: host.socket,
    OMO_BRIDGE_KEY_ROOT: agentDir,
  };

  let runtime: BridgeRuntime;
  try {
    runtime = await (deps.createRuntime ?? createRuntime)(runtimeEnv);
  } catch (error) {
    await stopPrivateHost(host.socket, stateDir, env, deps);
    throw error;
  }

  const transport = runtime.transport;
  let recovery: SessionRecovery | undefined;
  let proxy: (SessionReadTransport & SessionWriteTransport & SessionInboxTransport) | undefined;
  if (transport !== undefined) {
    recovery = createSessionRecovery({ transport, reconnectDelaysMs: deps.reconnectDelaysMs });
    proxy = createTransportProxy(transport, recovery);
    installHandlerTransports(proxy);
  } else {
    clearHandlerTransports();
  }

  const state: BridgeState = {
    url: `http://${config.host}:${runtime.server.port}`,
    pid: process.pid,
    password,
    socket: host.socket,
  };
  writeBridgeState(stateFile, state);

  let stopped = false;
  let lastReport: ShutdownReport | undefined;

  const stop = async (): Promise<ShutdownReport> => {
    if (stopped && lastReport !== undefined) return lastReport;
    stopped = true;
    recovery?.stop();
    clearHandlerTransports();
    // Stop accepting connections first: every open SSE stream is part of the served surface and
    // must close before the transport it streams from goes away.
    await Promise.resolve(runtime.server.stop(true));
    try {
      await transport?.dispose();
    } catch {
      // A transport that is already gone has nothing left to close.
    }
    const hostResult = await stopPrivateHost(state.socket, stateDir, env, deps);
    const recorded = readBridgeState(stateFile);
    if (recorded === undefined || recorded.pid === state.pid) removeFile(stateFile);
    lastReport = { stopped: true, pid: state.pid, socket: state.socket, host: hostResult };
    return lastReport;
  };

  return { config, state, agentDir, runtime, host, recovery, transport: proxy, stop };
}

export async function status(options: { env?: NodeJS.ProcessEnv; stateDir?: string; deps?: LauncherDeps } = {}): Promise<BridgeStatusReport> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? {};
  const stateDir = resolveStateDir(env, options.stateDir);
  const stateFile = join(stateDir, BRIDGE_STATE_FILE);
  const state = readBridgeState(stateFile);
  if (state === undefined) {
    return { running: false, reachable: false, stateFile, socketPresent: false };
  }
  const alive = (deps.isPidAlive ?? isPidAlive)(state.pid);
  const socketPresent = isSocketFile(state.socket);
  if (!alive) {
    return {
      running: false,
      reachable: false,
      stateFile,
      pid: state.pid,
      url: state.url,
      socket: state.socket,
      socketPresent,
      error: "the recorded omo-bridge process is gone",
    };
  }

  const fetchImpl = deps.fetch ?? fetch;
  const credentials = Buffer.from(`${BRIDGE_BASIC_USERNAME}:${state.password}`, "utf8").toString("base64");
  try {
    const response = await fetchImpl(`${state.url}/api/info`, {
      headers: { authorization: `Basic ${credentials}` },
      signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
    });
    return {
      running: true,
      reachable: response.status === 200,
      stateFile,
      pid: state.pid,
      url: state.url,
      socket: state.socket,
      socketPresent,
      ...(response.status === 200 ? {} : { error: `GET /api/info answered ${response.status}` }),
    };
  } catch (error) {
    return {
      running: true,
      reachable: false,
      stateFile,
      pid: state.pid,
      url: state.url,
      socket: state.socket,
      socketPresent,
      error: messageOf(error),
    };
  }
}

async function terminate(pid: number, alive: (pid: number) => boolean, timeoutMs: number): Promise<boolean> {
  if (!alive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await delay(POLL_INTERVAL_MS);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process ended between the check and the signal.
  }
  return !alive(pid);
}

/** Ends only the bridge recorded in `<stateDir>/bridge.json` and the private socket it names. */
export async function stop(options: { env?: NodeJS.ProcessEnv; stateDir?: string; deps?: LauncherDeps } = {}): Promise<BridgeStopReport> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? {};
  const stateDir = resolveStateDir(env, options.stateDir);
  const stateFile = join(stateDir, BRIDGE_STATE_FILE);
  const state = readBridgeState(stateFile);
  if (state === undefined) {
    return { stopped: false, stateFile, reason: "no bridge state file" };
  }

  // Validate before signalling anything: a tampered or stale record must never reach the shared
  // daemon or a socket some other process owns.
  const socket = assertPrivateSocket(state.socket, stateDir);
  if (state.pid === process.pid) {
    throw new LauncherError("refusing to stop the current process; use a signal or the in-process handle");
  }
  const alive = deps.isPidAlive ?? isPidAlive;
  await terminate(state.pid, alive, deps.terminateTimeoutMs ?? TERMINATE_TIMEOUT_MS);

  const hostResult = await stopPrivateHost(socket, stateDir, env, deps);
  removeFile(stateFile);
  return { stopped: true, stateFile, pid: state.pid, socket, host: hostResult };
}

const USAGE = `omo-bridge <command>

Commands:
  start    Run the bridge in the foreground on a private senpi host (default)
  status   Probe the bridge recorded in <stateDir>/bridge.json
  stop     End the recorded omo-bridge process and its private senpi host
  tui      Launch the TUI against this bridge with its own isolated TUI state
`;

export async function runForeground(options: StartOptions = {}): Promise<void> {
  let started: StartedBridge;
  try {
    started = await start(options);
  } catch (error) {
    console.error(`omo-bridge: ${messageOf(error)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`omo-bridge listening on ${started.state.url}`);
  console.log(`omo-bridge private senpi host (${started.host.mode}) on ${started.state.socket}`);
  console.log(`omo-bridge agent dir ${started.agentDir}`);
  if (started.recovery === undefined) {
    console.warn("omo-bridge: no senpi transport is attached; session routes answer 503");
  }

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`omo-bridge: ${signal} received, shutting down`);
    void started.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`omo-bridge: shutdown failed: ${messageOf(error)}`);
        process.exit(0);
      },
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The HTTP server keeps the loop alive; this promise parks `runForeground` until a signal.
  await new Promise<void>(() => undefined);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "start";
  try {
    if (command === "start") {
      await runForeground();
      return;
    }
    if (command === "status") {
      console.log(JSON.stringify(await status()));
      return;
    }
    if (command === "stop") {
      console.log(JSON.stringify(await stop()));
      return;
    }
    if (command === "tui") {
      const { runTui } = await import("./tui-launch");
      await runTui(argv.slice(1));
      return;
    }
    if (command === "help" || command === "--help" || command === "-h") {
      console.log(USAGE);
      return;
    }
    console.error(`omo-bridge: unknown command ${JSON.stringify(command)}\n\n${USAGE}`);
    process.exitCode = 2;
  } catch (error) {
    console.error(`omo-bridge: ${messageOf(error)}`);
    process.exitCode = 1;
  }
}
