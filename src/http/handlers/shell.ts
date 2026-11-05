import { isAbsolute, resolve } from "node:path";
import { eventBus as sharedEventBus, type EventBus } from "../events";
import { locationInfo } from "./fs-location";
import { HandlerProblem, jsonResponse, noContent, respond } from "./problem";

// Shell endpoints map the TUI's shell surface onto senpi's one-shot `bash()`.
//
// SEMANTIC GAP: senpi has no persistent shell. `POST /api/session/:sessionID/shell` runs one
// non-interactive command and returns once it settled; there is no live PTY, no stdin, and no
// incremental output while it runs. The shell registry below only retains what bash() returned so
// the TUI can read the command, its exit code and its output after the fact.
//
// Handlers take (request, url) and read the transport from a module-level seam: the http layer
// owns no connection, and route mounting stays an independent change (see src/http/routes).

export const DEFAULT_SHELL_OUTPUT_LIMIT = 64 * 1024;
const SHELL_NAME = "bash";
// Shell.Info.file is required by the TUI schema. senpi keeps bash output in memory here, so there
// is no capture file and the field stays empty rather than naming a path that does not exist.
const NO_CAPTURE_FILE = "";

/** The subset of senpi's `BashResult` the bridge consumes (the client may carry more). */
export type ShellBashResult = {
  output: string;
  exitCode?: number | undefined;
  cancelled?: boolean | undefined;
  truncated?: boolean | undefined;
};

/**
 * The transport seam. `bash` is optional because an older senpi client has no such command; a
 * transport without it answers 503 instead of running anything.
 */
export type ShellTransport = {
  bash?: (command: string) => Promise<ShellBashResult>;
};

/** One row of GET /api/shell: the TUI decodes it as `Shell.Info` (packages/schema/src/shell.ts). */
export type ShellInfo = {
  id: string;
  status: "running" | "exited" | "timeout" | "killed";
  command: string;
  cwd: string;
  shell: string;
  file: string;
  exit?: number | undefined;
  signal?: string | undefined;
  metadata: Record<string, unknown>;
  time: { started: number; completed?: number | undefined };
};

/** `Shell.Output`: an absolute byte cursor over the retained combined output. */
export type ShellOutput = {
  output: string;
  cursor: number;
  size: number;
  truncated: boolean;
};

type ShellRecord = {
  id: string;
  sessionID: string;
  command: string;
  output: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number;
  status: "running" | "exited";
  cwd: string;
  cancelled?: boolean;
  truncated?: boolean;
};

let transport: ShellTransport | undefined;
let bus: EventBus = sharedEventBus;

export function setShellTransport(next: ShellTransport | undefined): void {
  transport = next;
}

export function getShellTransport(): ShellTransport | undefined {
  return transport;
}

export function setShellEventBus(next: EventBus | undefined): void {
  bus = next ?? sharedEventBus;
}

const shells = new Map<string, ShellRecord>();
let idSequence = 0;

export function resetShells(): void {
  shells.clear();
  idSequence = 0;
}

function shellNotFound(id: string): HandlerProblem {
  return new HandlerProblem(404, "ShellNotFoundError", `shell not found: ${id}`, { id });
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

function serviceUnavailable(message: string): HandlerProblem {
  return new HandlerProblem(503, "ServiceUnavailableError", message, { service: "senpi" });
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function sessionIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("session");
  const sessionID = at >= 0 ? segments[at + 1] : undefined;
  if (sessionID === undefined || sessionID.length === 0) {
    throw invalidRequest(`no session id in path ${url.pathname}`, "sessionID");
  }
  return sessionID;
}

function shellIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("shell");
  const id = at >= 0 ? segments[at + 1] : undefined;
  if (id === undefined || id.length === 0) {
    throw invalidRequest(`no shell id in path ${url.pathname}`, "id");
  }
  return id;
}

function locationDirectory(url: URL): string {
  const raw = url.searchParams.get("location[directory]");
  const directory = raw === null || raw.trim().length === 0 ? process.cwd() : raw.trim();
  return isAbsolute(directory) ? resolve(directory) : resolve(process.cwd(), directory);
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw.trim().length === 0) return DEFAULT_SHELL_OUTPUT_LIMIT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw invalidRequest(`limit must be a positive integer (found ${JSON.stringify(raw)})`, "limit");
  }
  return value;
}

function readCursor(url: URL): number {
  const raw = url.searchParams.get("cursor");
  if (raw === null || raw.trim().length === 0) return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw invalidRequest(`cursor must be a non-negative integer (found ${JSON.stringify(raw)})`, "cursor");
  }
  return value;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw invalidRequest("shell payload must be JSON", "command");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw invalidRequest("shell payload must be a JSON object", "command");
  }
  return payload as Record<string, unknown>;
}

function nextShellId(): string {
  idSequence += 1;
  return `sh_${Date.now().toString(36)}${idSequence.toString(36)}`;
}

function requireBash(): (command: string) => Promise<ShellBashResult> {
  if (transport === undefined) {
    throw serviceUnavailable("no senpi transport is wired into the http layer");
  }
  const bash = transport.bash;
  if (typeof bash !== "function") {
    throw serviceUnavailable("the senpi client has no bash() command");
  }
  return (command) => bash.call(transport, command);
}

function statusOf(record: ShellRecord): ShellInfo["status"] {
  if (record.status === "running") return "running";
  return record.cancelled === true ? "killed" : "exited";
}

function toShellInfo(record: ShellRecord): ShellInfo {
  return {
    id: record.id,
    status: statusOf(record),
    command: record.command,
    cwd: record.cwd,
    shell: SHELL_NAME,
    file: NO_CAPTURE_FILE,
    ...(record.exitCode === undefined ? {} : { exit: record.exitCode }),
    metadata: { sessionID: record.sessionID },
    time: {
      started: record.startedAt,
      ...(record.endedAt === undefined ? {} : { completed: record.endedAt }),
    },
  };
}

function pageOutput(record: ShellRecord, cursor: number, limit: number): ShellOutput {
  const bytes = Buffer.from(record.output, "utf8");
  const size = bytes.length;
  // A cursor at or past the end reads nothing; the answer still reports the real size so a caller
  // that asked with `Number.MAX_SAFE_INTEGER` can learn how much was captured.
  const start = Math.min(cursor, size);
  const end = Math.min(size, start + limit);
  return {
    output: bytes.subarray(start, end).toString("utf8"),
    cursor: end,
    size,
    truncated: record.truncated === true,
  };
}

export async function handleSessionShell(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const payload = await readBody(request);
    const command = payload.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw invalidRequest("shell payload needs a non-empty command", "command");
    }
    const suppliedId = payload.id;
    if (suppliedId !== undefined && (typeof suppliedId !== "string" || suppliedId.length === 0)) {
      throw invalidRequest("shell payload id must be a non-empty string", "id");
    }
    const bash = requireBash();
    const cwd = locationDirectory(url);
    const record: ShellRecord = {
      id: suppliedId ?? nextShellId(),
      sessionID,
      command,
      output: "",
      startedAt: Date.now(),
      status: "running",
      cwd,
    };
    shells.set(record.id, record);

    // One-shot semantics: started carries the running row, ended carries the merged output.
    bus.publish({ type: "session.shell.started", data: { sessionID, shell: toShellInfo(record) } });

    try {
      const result = await bash(command);
      record.output = typeof result.output === "string" ? result.output : String(result.output ?? "");
      record.exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;
      record.cancelled = result.cancelled === true;
      record.truncated = result.truncated === true;
    } catch (error) {
      // A failed call still settles the record: without an ended event the TUI would keep
      // rendering the shell as running forever.
      record.status = "exited";
      record.endedAt = Date.now();
      bus.publish({
        type: "session.shell.ended",
        data: { sessionID, shell: toShellInfo(record), output: pageOutput(record, 0, Number.MAX_SAFE_INTEGER) },
      });
      throw error;
    }

    record.status = "exited";
    record.endedAt = Date.now();
    bus.publish({
      type: "session.shell.ended",
      data: { sessionID, shell: toShellInfo(record), output: pageOutput(record, 0, Number.MAX_SAFE_INTEGER) },
    });
    return noContent();
  });
}

export async function handleShellList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const directory = locationDirectory(url);
    const data = [...shells.values()]
      .filter((record) => record.cwd === directory)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map(toShellInfo);
    return jsonResponse(200, { location: locationInfo(directory), data });
  });
}

export async function handleShellGet(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const id = shellIdFromPath(url);
    const record = shells.get(id);
    if (record === undefined) throw shellNotFound(id);
    return jsonResponse(200, { location: locationInfo(locationDirectory(url)), data: toShellInfo(record) });
  });
}

export async function handleShellOutput(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const id = shellIdFromPath(url);
    const record = shells.get(id);
    if (record === undefined) throw shellNotFound(id);
    const cursor = readCursor(url);
    const limit = readLimit(url);
    return jsonResponse(200, {
      location: locationInfo(locationDirectory(url)),
      data: pageOutput(record, cursor, limit),
    });
  });
}

export async function handleShellRemove(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const id = shellIdFromPath(url);
    shells.delete(id);
    return noContent();
  });
}
