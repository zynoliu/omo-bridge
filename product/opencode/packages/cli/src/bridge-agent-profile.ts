/**
 * The companion extension's host profile.
 *
 * The official host loads an extension only through configuration it reads at start: `omo daemon run`
 * reads `<agentDir>/settings.json` and loads every entry named by `extensions`. The launcher already
 * knows the host's agent directory - it is the parent chain of `--key-record` - so this module is
 * where the companion extension is merged into that document. Without the write a host starts with no
 * extension, exposes no `registerMcpServer`, and the client MCP tools never appear.
 *
 * The write happens only when an entry is present or configured: an explicit entry (the option or
 * `BRIDGE_COMPANION_EXTENSION`) is trusted as configured, because the path belongs to the host's
 * filesystem rather than this process's; otherwise the locations next to the launcher are probed and
 * the write is skipped when none of them exists. Existing settings are never overwritten: the document
 * is parsed, the entry is appended to `extensions`, and every other key survives. A document that is
 * not a JSON object, or whose `extensions` is not a list of paths, is refused and left untouched.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Set to an entry path to configure one, or to `off` to keep the launcher from staging anything. */
export const COMPANION_EXTENSION_ENV = "BRIDGE_COMPANION_EXTENSION";

export type CompanionProfileAction = "created" | "updated" | "unchanged" | "refused";

export type CompanionProfileRecord = {
  readonly path: string;
  readonly action: CompanionProfileAction;
  /** Every entry the document carries after the call, the companion's included. */
  readonly extensions: readonly string[];
  readonly bytes: number;
  readonly detail?: string;
};

export type StageCompanionProfileOptions = {
  readonly agentDir: string;
  /** An entry the caller already resolved; a host or container path is trusted as configured. */
  readonly extensionEntry?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Discovery root; defaults to this module's directory. */
  readonly moduleDir?: string;
};

/** Locations a shipped launcher may carry the companion extension in, relative to its own directory. */
const SHIPPED_CANDIDATES = [
  "bridge-extension/extension.ts",
  "bridge-extension/src/extension.ts",
  "../bridge-extension/extension.ts",
  "../../bridge-extension/src/extension.ts",
] as const;

export function resolveCompanionExtension(options: StageCompanionProfileOptions): string | undefined {
  const configured = options.extensionEntry ?? (options.environment ?? process.env)[COMPANION_EXTENSION_ENV];
  if (configured !== undefined) {
    const entry = configured.trim();
    if (entry.length === 0 || entry === "off") return undefined;
    return entry;
  }
  const moduleDir = options.moduleDir ?? import.meta.dir;
  for (const candidate of SHIPPED_CANDIDATES) {
    const entry = resolve(moduleDir, candidate);
    try {
      if (lstatSync(entry).isFile()) return entry;
    } catch {
      /* the next candidate is the answer when this location ships nothing */
    }
  }
  return undefined;
}

/**
 * Merges the companion extension into `<agentDir>/settings.json` and reports what it did. Returns
 * `undefined` when no entry is present or configured, so an ordinary launcher run on a tree that
 * ships no extension leaves the host's agent directory exactly as it found it.
 */
export function stageCompanionExtensionProfile(options: StageCompanionProfileOptions): CompanionProfileRecord | undefined {
  const entry = resolveCompanionExtension(options);
  if (entry === undefined) return undefined;
  /* No agent directory means no host has ever run there, so there is nothing to prepare and nothing
     is created: staging never brings an agent directory into existence. */
  if (!existsSync(options.agentDir)) return undefined;
  const file = join(options.agentDir, "settings.json");
  const agent = agentDirectory(options.agentDir);
  if (!agent.ok) return refused(file, agent.detail);
  try {
    if (lstatSync(file).isSymbolicLink()) return refused(file, "settings.json is a symlink");
  } catch {
    /* an absent document is created by this call */
  }

  let existed = false;
  let document: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return refused(file, "the existing settings document is not a JSON object");
    }
    document = parsed as Record<string, unknown>;
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return refused(file, "the existing settings document could not be read: " + describe(error));
    }
    document = {};
  }

  const current = document.extensions;
  if (current !== undefined && (!Array.isArray(current) || current.some((value: unknown) => typeof value !== "string"))) {
    return refused(file, "the existing extensions setting is not a list of paths");
  }
  const extensions: string[] = current === undefined ? [] : [...(current as string[])];
  if (extensions.includes(entry)) return { path: file, action: "unchanged", extensions: extensions, bytes: 0 };

  const text = JSON.stringify({ ...document, extensions: [...extensions, entry] }, null, 2) + "\n";
  try {
    atomicWrite(file, text);
  } catch (error) {
    return refused(file, "the profile could not be written: " + describe(error), extensions);
  }
  return {
    path: file,
    action: existed ? "updated" : "created",
    extensions: [...extensions, entry],
    bytes: Buffer.byteLength(text),
  };
}

function agentDirectory(path: string): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { ok: false, detail: "the agent directory is a symlink" };
    if (!stat.isDirectory()) return { ok: false, detail: "the agent directory is not a directory" };
    return { ok: true };
  } catch {
    return { ok: false, detail: "the agent directory does not exist" };
  }
}

/**
 * A sibling temporary file plus a rename: the host never reads a half-written document, and a failure
 * before the rename leaves the previous one in place. The mode is owner-only because the host treats
 * its agent directory as private state.
 */
function atomicWrite(file: string, text: string): void {
  const temporary = join(dirname(file), ".settings.json." + process.pid + "." + randomBytes(6).toString("hex") + ".tmp");
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(descriptor, text);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* the rename failure is the reported one */
    }
    throw error;
  }
}

function refused(file: string, detail: string, extensions: readonly string[] = []): CompanionProfileRecord {
  return { path: file, action: "refused", extensions: extensions, bytes: 0, detail: detail };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
