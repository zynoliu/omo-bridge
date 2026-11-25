import { homedir } from "node:os";
import { applyOutput, clampSize, EMPTY_TERMINAL_SCREEN, refuse } from "./state.ts";
import type { TerminalRefusal, TerminalScreen, TerminalSize } from "./state.ts";
import { checkTerminalSpec } from "./spec.ts";
import type { TerminalSpec } from "./spec.ts";

export type TerminalStatus = "running" | "closing" | "closed";

export type TerminalSnapshot = {
  readonly id: string;
  readonly sessionID: string;
  readonly title: string;
  readonly shell: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly pid: number;
  readonly size: TerminalSize;
  readonly screen: TerminalScreen;
  readonly status: TerminalStatus;
  readonly exitCode: number | null;
};

export type TerminalOpenOutcome = { readonly kind: "opened"; readonly terminal: TerminalSnapshot } | TerminalRefusal;
export type TerminalInputOutcome = { readonly kind: "written"; readonly bytes: number } | TerminalRefusal;
export type TerminalResizeOutcome = { readonly kind: "applied"; readonly size: TerminalSize } | TerminalRefusal;

export type TerminalCloseOutcome =
  | {
      readonly kind: "closed";
      readonly id: string;
      readonly pid: number;
      readonly exitCode: number | null;
      readonly signalled: readonly number[];
      readonly stillAlive: readonly number[];
    }
  | TerminalRefusal;

export type TerminalStoreDeps = {
  readonly homeDirectory?: () => string;
  readonly listDescendants?: (pid: number) => Promise<readonly number[]>;
};

export type TerminalStore = {
  readonly open: (spec: TerminalSpec) => TerminalOpenOutcome;
  readonly list: () => readonly TerminalSnapshot[];
  readonly snapshot: (id: string) => TerminalSnapshot | undefined;
  readonly input: (sessionID: string, id: string, data: string | Uint8Array) => TerminalInputOutcome;
  readonly resize: (sessionID: string, id: string, size: TerminalSize) => TerminalResizeOutcome;
  readonly close: (sessionID: string, id: string) => Promise<TerminalCloseOutcome>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => Promise<void>;
};

type SpawnedShell = {
  readonly pid: number;
  readonly exited: Promise<number>;
};

type TerminalEntry = {
  readonly kind: "terminal";
  readonly id: string;
  readonly sessionID: string;
  readonly title: string;
  readonly shell: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly pid: number;
  readonly shellProcess: SpawnedShell;
  readonly terminal: Bun.Terminal;
  readonly decoder: TextDecoder;
  screen: TerminalScreen;
  size: TerminalSize;
  status: TerminalStatus;
  exitCode: number | null;
  closing: Promise<TerminalCloseOutcome> | null;
};

const EXIT_DEADLINE_MS = 3000;
const REAP_DEADLINE_MS = 2000;
const REAP_POLL_MS = 20;
const PS_ENV = { PATH: "/usr/bin:/bin" };

/**
 * Owns the shells this panel opened. Each terminal is bound to the session that opened it, so input or a
 * resize naming another session is refused before the pty is touched. Closing kills every descendant the
 * shell started and reports whether any pid survived, so the caller never has to infer cleanup from a timer.
 */
export function createTerminalStore(deps: TerminalStoreDeps = {}): TerminalStore {
  const homeDirectory = deps.homeDirectory ?? (() => homedir());
  const listDescendants = deps.listDescendants ?? defaultListDescendants;
  const entries = new Map<string, TerminalEntry>();
  const listeners = new Set<() => void>();
  let counter = 0;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const record = (id: string, chunk: Uint8Array) => {
    const held = entries.get(id);
    if (held === undefined || held.status === "closed") return;
    held.screen = applyOutput(held.screen, held.decoder.decode(chunk, { stream: true }));
    notify();
  };

  const open = (spec: TerminalSpec): TerminalOpenOutcome => {
    const checked = checkTerminalSpec(spec, homeDirectory());
    if (checked.kind === "refused") return checked;
    counter += 1;
    const id = "terminal_" + String(counter).padStart(3, "0");
    const terminal = new Bun.Terminal({
      cols: checked.size.cols,
      rows: checked.size.rows,
      name: "xterm-256color",
      data(_terminal, chunk) {
        record(id, chunk);
      },
    });
    const argv = [checked.shell];
    const spawned = Bun.spawn({
      cmd: argv,
      cwd: checked.cwd,
      env: { ...checked.env },
      terminal: terminal,
    });
    const entry: TerminalEntry = {
      kind: "terminal",
      id: id,
      sessionID: checked.sessionID,
      title: checked.title,
      shell: checked.shell,
      cwd: checked.cwd,
      argv: argv,
      pid: spawned.pid,
      shellProcess: { pid: spawned.pid, exited: spawned.exited },
      terminal: terminal,
      decoder: new TextDecoder(),
      screen: EMPTY_TERMINAL_SCREEN,
      size: checked.size,
      status: "running",
      exitCode: null,
      closing: null,
    };
    entries.set(id, entry);
    void spawned.exited.then((code) => {
      entry.exitCode = code;
      if (entry.status !== "running") return;
      entry.status = "closed";
      if (!entry.terminal.closed) entry.terminal.close();
      notify();
    });
    return { kind: "opened", terminal: snapshotOf(entry) };
  };

  const guard = (sessionID: string, id: string): TerminalEntry | TerminalRefusal => {
    const held = entries.get(id);
    if (held === undefined) return refuse("unknown-terminal", "no terminal is bound to " + id);
    if (held.sessionID !== sessionID) {
      return refuse("session-mismatch", "terminal " + id + " belongs to a different session; the request was refused without touching it");
    }
    return held;
  };

  const input = (sessionID: string, id: string, data: string | Uint8Array): TerminalInputOutcome => {
    const held = guard(sessionID, id);
    if (held.kind === "refused") return held;
    if (held.status !== "running") return refuse("terminal-closed", "terminal " + id + " is " + held.status + " and no longer accepts input");
    const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
    held.terminal.write(data);
    return { kind: "written", bytes: bytes };
  };

  const resize = (sessionID: string, id: string, size: TerminalSize): TerminalResizeOutcome => {
    const held = guard(sessionID, id);
    if (held.kind === "refused") return held;
    if (held.status !== "running") return refuse("terminal-closed", "terminal " + id + " is " + held.status + " and cannot be resized");
    const next = clampSize(size);
    if (next === null) return refuse("invalid-size", "terminal size must be integers between 1 and 1000 columns and rows");
    held.size = next;
    held.terminal.resize(next.cols, next.rows);
    notify();
    return { kind: "applied", size: held.size };
  };

  const close = async (sessionID: string, id: string): Promise<TerminalCloseOutcome> => {
    const held = guard(sessionID, id);
    if (held.kind === "refused") return held;
    if (held.closing !== null) return held.closing;
    held.closing = reap(held, listDescendants, notify);
    return held.closing;
  };

  return {
    open: open,
    list: () => [...entries.values()].map(snapshotOf),
    snapshot: (id) => {
      const held = entries.get(id);
      return held === undefined ? undefined : snapshotOf(held);
    },
    input: input,
    resize: resize,
    close: close,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: async () => {
      await Promise.all([...entries.values()].map((held) => held.closing ?? reap(held, listDescendants, notify)));
    },
  };
}

async function reap(held: TerminalEntry, listDescendants: (pid: number) => Promise<readonly number[]>, notify: () => void): Promise<TerminalCloseOutcome> {
  if (held.status === "closed") return receipt(held, [], []);
  held.status = "closing";
  notify();
  const descendants = await listDescendants(held.pid);
  const signalled = descendants.filter((pid) => signal(pid, "SIGKILL"));
  if (!held.terminal.closed) held.terminal.close();
  const exited = await settledWithin(held.shellProcess.exited, EXIT_DEADLINE_MS);
  if (exited === null) {
    signal(held.pid, "SIGKILL");
    held.exitCode = await settledWithin(held.shellProcess.exited, EXIT_DEADLINE_MS);
  } else {
    held.exitCode = exited;
  }
  held.screen = applyOutput(held.screen, held.decoder.decode());
  held.status = "closed";
  notify();
  return receipt(held, signalled, await survivors([held.pid, ...descendants]));
}

function receipt(held: TerminalEntry, signalled: readonly number[], stillAlive: readonly number[]): TerminalCloseOutcome {
  return { kind: "closed", id: held.id, pid: held.pid, exitCode: held.exitCode, signalled: signalled, stillAlive: stillAlive };
}

function snapshotOf(held: TerminalEntry): TerminalSnapshot {
  return {
    id: held.id,
    sessionID: held.sessionID,
    title: held.title,
    shell: held.shell,
    cwd: held.cwd,
    argv: held.argv,
    pid: held.pid,
    size: held.size,
    screen: held.screen,
    status: held.status,
    exitCode: held.exitCode,
  };
}

async function defaultListDescendants(root: number): Promise<readonly number[]> {
  try {
    const scan = Bun.spawn({
      cmd: ["/bin/ps", "-A", "-o", "pid=,ppid="],
      env: { PATH: PS_ENV.PATH },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(scan.stdout).text();
    const code = await scan.exited;
    if (code !== 0) return [];
    return descendantsOf(processTable(text), root);
  } catch {
    return [];
  }
}

function processTable(text: string): readonly { readonly pid: number; readonly ppid: number }[] {
  const rows: { pid: number; ppid: number }[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({ pid: pid, ppid: ppid });
  }
  return rows;
}

function descendantsOf(rows: readonly { readonly pid: number; readonly ppid: number }[], root: number): readonly number[] {
  const found: number[] = [];
  let frontier = [root];
  while (frontier.length > 0) {
    const children = rows.filter((row) => frontier.includes(row.ppid) && row.pid !== root && !found.includes(row.pid)).map((row) => row.pid);
    found.push(...children);
    frontier = children;
  }
  return found.reverse();
}

async function survivors(pids: readonly number[]): Promise<readonly number[]> {
  const deadline = Date.now() + REAP_DEADLINE_MS;
  let alive = pids.filter(isAlive);
  while (alive.length > 0 && Date.now() < deadline) {
    await Bun.sleep(REAP_POLL_MS);
    alive = alive.filter(isAlive);
  }
  return alive;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, name: string): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false;
  }
}

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
