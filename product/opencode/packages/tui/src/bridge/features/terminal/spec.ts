import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { clampSize, refuse } from "./state.ts";
import type { TerminalRefusal, TerminalSize } from "./state.ts";

export type TerminalSpec = {
  readonly sessionID: string;
  readonly title?: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: string;
  readonly size?: TerminalSize;
};

export type AcceptedTerminalSpec = {
  readonly kind: "accepted";
  readonly sessionID: string;
  readonly title: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: string;
  readonly size: TerminalSize;
};

export type TerminalSpecCheck = AcceptedTerminalSpec | TerminalRefusal;

const REQUIRED_ENV_KEYS = ["HOME", "PATH"];

/**
 * Accepts only a shell, a working directory and a complete environment the caller supplies. The child is
 * spawned with exactly `spec.env`, so an ambient variable reaches it only if the caller passes that key.
 * A directory at or above the ambient home, and an environment home anywhere inside the real home tree,
 * are refused: a shell that inherits the user's home falls back to it for profiles, history and caches.
 */
export function checkTerminalSpec(spec: TerminalSpec, homeDirectory: string): TerminalSpecCheck {
  if (typeof spec.sessionID !== "string" || spec.sessionID.trim().length === 0) {
    return refuse("invalid-session", "a terminal must be bound to a non-empty session id");
  }
  const size = clampSize(spec.size);
  if (size === null) return refuse("invalid-size", "terminal size must be integers between 1 and 1000 columns and rows");
  const cwd = checkCwd(spec.cwd, homeDirectory);
  if (cwd.kind === "refused") return cwd;
  const env = checkEnv(spec.env, homeDirectory);
  if (env.kind === "refused") return env;
  const shell = checkShell(spec.shell);
  if (shell.kind === "refused") return shell;
  return {
    kind: "accepted",
    sessionID: spec.sessionID,
    title: spec.title === undefined ? "Terminal" : spec.title,
    cwd: cwd.path,
    env: env.env,
    shell: shell.path,
    size: size,
  };
}

function checkCwd(cwd: string, homeDirectory: string): { readonly kind: "accepted"; readonly path: string } | TerminalRefusal {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return refuse("invalid-cwd", "the terminal working directory must be absolute");
  const resolved = resolveExisting(cwd);
  if (resolved === null) return refuse("cwd-unavailable", "the terminal working directory is not an existing directory: " + cwd);
  const home = resolveExisting(homeDirectory) ?? homeDirectory;
  if (contains(resolved, home)) {
    return refuse("cwd-reaches-home", "a terminal is never opened at the ambient home directory or above it");
  }
  return { kind: "accepted", path: resolved };
}

function checkEnv(env: Readonly<Record<string, string>>, homeDirectory: string): { readonly kind: "accepted"; readonly env: Readonly<Record<string, string>> } | TerminalRefusal {
  if (env === null || typeof env !== "object") return refuse("invalid-env", "the terminal environment must be supplied explicitly");
  const entries = Object.entries(env);
  if (entries.length === 0) return refuse("invalid-env", "the terminal environment must be supplied explicitly; nothing is inherited");
  for (const key of REQUIRED_ENV_KEYS) {
    if (!entries.some(([held]) => held === key)) {
      return refuse("invalid-env", "the terminal environment must define " + key + "; it is never inherited from this process");
    }
  }
  for (const [key, value] of entries) {
    if (key.length === 0) return refuse("invalid-env", "the terminal environment has an empty variable name");
    if (typeof value !== "string" || value.includes("\u0000")) return refuse("invalid-env", "terminal environment variable " + key + " is not a plain string");
  }
  const home = entries.filter(([key]) => key === "HOME").map(([, value]) => value)[0];
  if (!path.isAbsolute(home)) return refuse("env-home-uncontrolled", "the terminal HOME must be an absolute path");
  const homeDirectoryResolved = resolveExisting(homeDirectory) ?? homeDirectory;
  const envHome = resolveExisting(home) ?? path.resolve(home);
  if (overlaps(envHome, homeDirectoryResolved)) {
    return refuse("env-home-uncontrolled", "the terminal HOME points at the ambient home tree; give the shell an isolated home");
  }
  return { kind: "accepted", env: Object.fromEntries(entries) };
}

function checkShell(shell: string): { readonly kind: "accepted"; readonly path: string } | TerminalRefusal {
  if (typeof shell !== "string" || !path.isAbsolute(shell)) return refuse("invalid-shell", "the terminal shell must be an absolute path");
  if (!isExecutable(shell)) return refuse("shell-unavailable", "the terminal shell is not an executable file: " + shell);
  return { kind: "accepted", path: shell };
}

function resolveExisting(target: string): string | null {
  try {
    if (!statSync(target).isDirectory()) return null;
    return realpathSync(target);
  } catch {
    return null;
  }
}

function isExecutable(target: string): boolean {
  try {
    if (!statSync(target).isFile()) return false;
    accessSync(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function contains(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function overlaps(first: string, second: string): boolean {
  return contains(first, second) || contains(second, first);
}
