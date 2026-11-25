/**
 * The CLI's TUI document (`<config dir>/cli.json`) is where a user sets the theme and keybinds, and
 * the official TUI handler reads it through the CLI's Effect `Config.Service`. Bridge mode starts the
 * same TUI outside that Effect runtime, so this module reads the same document with the same
 * precedence (`$OPENCODE_CLI_CONFIG_CONTENT` over the file) and hands it to the TUI's config
 * provider, which watches the file and calls `get()` again when it changes.
 *
 * The host refuses its own config RPC, so nothing here goes over the transport: a local bridge reads
 * the local document. `session.permissions` is the one setting the host owns — it publishes an
 * approval preset, so the host's preset is layered over whatever the file says.
 *
 * Read-only on purpose: the launcher refuses `update`, so a bridge session never rewrites the user's
 * CLI config.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "@opencode/tui/config";
import { parse, type ParseError } from "jsonc-parser";

export type BridgeTuiConfigOptions = {
  readonly directory: string;
  readonly overlay?: Readonly<Record<string, unknown>>;
  readonly decode: (value: unknown) => Config.Info | undefined;
  readonly environment?: Readonly<Record<string, string | undefined>>;
};

export type BridgeTuiConfig = {
  readonly path: string;
  readonly get: () => Promise<Config.Info>;
};

const EMPTY: Config.Info = {};

export function createBridgeTuiConfig(options: BridgeTuiConfigOptions): BridgeTuiConfig {
  const file = path.join(options.directory, "cli.json");
  const environment = options.environment ?? process.env;

  return {
    path: file,
    /* Read per call, never cached: the TUI's config provider calls `get()` again when the directory
       changes, and that is how a theme or keybind edit lands without restarting the TUI. */
    async get() {
      const fromFile = parseDocument(readTextFile(file));
      /* The same precedence as the CLI's own loader: the environment document wins over the file. */
      const fromEnvironment = parseDocument(environment.OPENCODE_CLI_CONFIG_CONTENT);
      const layered = mergeRecords(mergeRecords({}, fromFile), fromEnvironment);
      return options.decode(mergeRecords(layered, options.overlay)) ?? EMPTY;
    },
  };
}

function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    /* An absent or unreadable file is "no customisation", the same answer the CLI's loader gives. */
    return undefined;
  }
}

function parseDocument(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) return undefined;
  return isRecord(value) ? value : undefined;
}

function mergeRecords(
  base: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay ?? {})) {
    result[key] = isRecord(result[key]) && isRecord(value) ? mergeRecords(result[key], value) : value;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
