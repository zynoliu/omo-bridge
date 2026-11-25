import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTerminalStore, isEmptyScreen, screenText } from "../../src/bridge/features/terminal/index.ts";
import type { TerminalOpenOutcome, TerminalSnapshot, TerminalStore } from "../../src/bridge/features/terminal/index.ts";

type Fixture = { readonly root: string; readonly cwd: string; readonly home: string };

const fixtures: string[] = [];
const stores: TerminalStore[] = [];

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-t19-"));
  mkdirSync(path.join(root, "home"), { mode: 0o700 });
  mkdirSync(path.join(root, "work"), { mode: 0o700 });
  fixtures.push(root);
  return {
    root: realpathSync(root),
    cwd: realpathSync(path.join(root, "work")),
    home: realpathSync(path.join(root, "home")),
  };
}

function controlledEnv(fx: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: fx.home,
    PWD: fx.cwd,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    TMPDIR: fx.home,
    SHELL: "/bin/sh",
    ...extra,
  };
}

function openStore(): TerminalStore {
  const store = createTerminalStore();
  stores.push(store);
  return store;
}

function opened(outcome: TerminalOpenOutcome): TerminalSnapshot {
  if (outcome.kind !== "opened") throw new Error("terminal was refused: " + outcome.code + " " + outcome.message);
  return outcome.terminal;
}

function held(store: TerminalStore, id: string): TerminalSnapshot {
  const snapshot = store.snapshot(id);
  if (snapshot === undefined) throw new Error("terminal " + id + " is not held by the store");
  return snapshot;
}

function visible(store: TerminalStore, id: string): string {
  return screenText(held(store, id).screen);
}

function hasLine(line: string): (text: string) => boolean {
  return (text) => text.split("\n").some((held) => held.trim() === line);
}

/* The predicate is subscribed to before the caller writes, so the resolved value is the evidence, and the deadline only bounds how long a missing one is waited for. */
function waitForScreen(store: TerminalStore, id: string, predicate: (text: string) => boolean, timeoutMs = 15_000): Promise<boolean> {
  if (predicate(visible(store, id))) return Promise.resolve(true);
  const settled = Promise.withResolvers<boolean>();
  const stop = store.subscribe(() => {
    if (predicate(visible(store, id))) settled.resolve(true);
  });
  const timer = setTimeout(() => settled.resolve(false), timeoutMs);
  return settled.promise.then((value) => {
    clearTimeout(timer);
    stop();
    return value;
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function firstMatch(text: string, pattern: RegExp): number {
  const matched = text.match(pattern);
  return matched === null ? Number.NaN : Number(matched[1]);
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.dispose()));
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bridge terminal", () => {
  test("opens the controlled shell without running a command", () => {
    const fx = fixture();
    const store = openStore();
    const terminal = opened(store.open({ sessionID: "session-alpha", cwd: fx.cwd, env: controlledEnv(fx), shell: "/bin/sh" }));
    expect(terminal.argv).toEqual(["/bin/sh"]);
    expect(terminal.shell).toBe("/bin/sh");
    expect(terminal.cwd).toBe(fx.cwd);
    expect(terminal.pid).toBeGreaterThan(0);
    expect(terminal.size).toEqual({ cols: 80, rows: 24 });
    expect(terminal.status).toBe("running");
    expect(isEmptyScreen(terminal.screen)).toBe(true);
    expect(isAlive(terminal.pid)).toBe(true);
  }, 20_000);

  test("spawns with the supplied environment and inherits nothing", async () => {
    const fx = fixture();
    const store = openStore();
    process.env.BRIDGE_T19_AMBIENT = "ambient-should-not-arrive";
    try {
      const terminal = opened(
        store.open({
          sessionID: "session-alpha",
          cwd: fx.cwd,
          env: controlledEnv(fx, { BRIDGE_T19_CONTROLLED: "controlled-sentinel" }),
          shell: "/bin/sh",
        }),
      );
      expect(process.env.BRIDGE_T19_AMBIENT).toBe("ambient-should-not-arrive");
      const seen = waitForScreen(store, terminal.id, hasLine("BRIDGE_T19_ENV_END"));
      expect(store.input("session-alpha", terminal.id, "/usr/bin/env\necho BRIDGE_T19_ENV_END\n").kind).toBe("written");
      expect(await seen).toBe(true);
      const text = visible(store, terminal.id);
      expect(text).toContain("HOME=" + fx.home);
      expect(text).toContain("PATH=/usr/bin:/bin");
      expect(text).toContain("BRIDGE_T19_CONTROLLED=controlled-sentinel");
      expect(text).not.toContain("ambient-should-not-arrive");
    } finally {
      delete process.env.BRIDGE_T19_AMBIENT;
    }
  }, 20_000);

  test("streams pty output into the panel screen", async () => {
    const fx = fixture();
    const store = openStore();
    const terminal = opened(store.open({ sessionID: "session-alpha", cwd: fx.cwd, env: controlledEnv(fx), shell: "/bin/sh" }));
    let notifications = 0;
    const stop = store.subscribe(() => {
      notifications += 1;
    });
    const changedDirectory = waitForScreen(store, terminal.id, (text) => text.includes(fx.cwd));
    expect(store.input("session-alpha", terminal.id, "pwd\n").kind).toBe("written");
    expect(await changedDirectory).toBe(true);
    const sized = waitForScreen(store, terminal.id, hasLine("24 80"));
    expect(store.input("session-alpha", terminal.id, "stty size\n").kind).toBe("written");
    expect(await sized).toBe(true);
    stop();
    expect(notifications).toBeGreaterThan(0);
    expect(visible(store, terminal.id)).toContain(fx.cwd);
  }, 20_000);

  test("applies a resize to the running pty", async () => {
    const fx = fixture();
    const store = openStore();
    const terminal = opened(store.open({ sessionID: "session-alpha", cwd: fx.cwd, env: controlledEnv(fx), shell: "/bin/sh" }));
    const opened80 = waitForScreen(store, terminal.id, hasLine("24 80"));
    store.input("session-alpha", terminal.id, "stty size\n");
    expect(await opened80).toBe(true);
    expect(store.resize("session-alpha", terminal.id, { cols: 120, rows: 40 })).toEqual({
      kind: "applied",
      size: { cols: 120, rows: 40 },
    });
    expect(held(store, terminal.id).size).toEqual({ cols: 120, rows: 40 });
    const resized = waitForScreen(store, terminal.id, hasLine("40 120"));
    store.input("session-alpha", terminal.id, "stty size\n");
    expect(await resized).toBe(true);
  }, 20_000);

  test("refuses another session's input and leaves the target untouched", async () => {
    const fx = fixture();
    const store = openStore();
    const terminal = opened(store.open({ sessionID: "session-alpha", cwd: fx.cwd, env: controlledEnv(fx), shell: "/bin/sh" }));
    const ready = waitForScreen(store, terminal.id, hasLine("BRIDGE_T19_READY"));
    store.input("session-alpha", terminal.id, "pwd\necho BRIDGE_T19_READY\n");
    expect(await ready).toBe(true);
    expect(visible(store, terminal.id)).toContain(fx.cwd);
    const before = visible(store, terminal.id);
    const attempt = store.input("session-beta", terminal.id, "echo BRIDGE_T19_DENIED\n");
    const after = visible(store, terminal.id);
    expect(attempt.kind).toBe("refused");
    if (attempt.kind !== "refused") throw new Error("cross-session input was accepted");
    expect(attempt.code).toBe("session-mismatch");
    expect(after).toBe(before);
    const crossResize = store.resize("session-beta", terminal.id, { cols: 100, rows: 30 });
    expect(crossResize.kind).toBe("refused");
    expect(held(store, terminal.id).size).toEqual({ cols: 80, rows: 24 });
    const crossClose = await store.close("session-beta", terminal.id);
    expect(crossClose.kind).toBe("refused");
    expect(held(store, terminal.id).status).toBe("running");
    expect(isAlive(terminal.pid)).toBe(true);
    const answered = waitForScreen(store, terminal.id, (text) => text.split("\n").filter((line) => line.trim() === fx.cwd).length === 2);
    store.input("session-alpha", terminal.id, "pwd\n");
    expect(await answered).toBe(true);
    expect(visible(store, terminal.id)).not.toContain("BRIDGE_T19_DENIED");
  }, 20_000);

  test("closing reaps the whole process tree", async () => {
    const fx = fixture();
    const store = openStore();
    const terminal = opened(store.open({ sessionID: "session-alpha", cwd: fx.cwd, env: controlledEnv(fx), shell: "/bin/sh" }));
    const spawned = waitForScreen(store, terminal.id, hasLine("BRIDGE_T19_JOBS"));
    store.input(
      "session-alpha",
      terminal.id,
      "sh -c 'trap \"\" HUP; exec sleep 300' & echo ESCAPED=$!\nsleep 300 & echo PLAIN=$!\necho BRIDGE_T19_JOBS\n",
    );
    expect(await spawned).toBe(true);
    const escaped = firstMatch(visible(store, terminal.id), /ESCAPED=(\d+)/);
    const plain = firstMatch(visible(store, terminal.id), /PLAIN=(\d+)/);
    expect(Number.isInteger(escaped)).toBe(true);
    expect(Number.isInteger(plain)).toBe(true);
    expect(isAlive(escaped)).toBe(true);
    expect(isAlive(plain)).toBe(true);
    const receipt = await store.close("session-alpha", terminal.id);
    expect(receipt.kind).toBe("closed");
    if (receipt.kind !== "closed") throw new Error("close was refused for the owning session");
    expect(receipt.stillAlive).toEqual([]);
    expect(isAlive(terminal.pid)).toBe(false);
    expect(isAlive(escaped)).toBe(false);
    expect(isAlive(plain)).toBe(false);
    expect(held(store, terminal.id).status).toBe("closed");
    const late = store.input("session-alpha", terminal.id, "echo AFTER\n");
    expect(late.kind).toBe("refused");
    const again = await store.close("session-alpha", terminal.id);
    expect(again.kind).toBe("closed");
  }, 20_000);

  test("refuses a spec that would reach the ambient home", () => {
    const fx = fixture();
    const atHome = createTerminalStore({ homeDirectory: () => fx.root });
    stores.push(atHome);
    expect(atHome.open({ sessionID: "session-alpha", cwd: fx.root, env: controlledEnv(fx), shell: "/bin/sh" })).toMatchObject({
      kind: "refused",
      code: "cwd-reaches-home",
    });
    expect(
      atHome.open({ sessionID: "session-alpha", cwd: fx.cwd, env: { ...controlledEnv(fx), HOME: fx.root }, shell: "/bin/sh" }),
    ).toMatchObject({ kind: "refused", code: "env-home-uncontrolled" });
    const elsewhere = createTerminalStore({ homeDirectory: () => path.join(fx.root, "ambient") });
    stores.push(elsewhere);
    expect(
      elsewhere.open({ sessionID: "session-alpha", cwd: fx.cwd, env: { PATH: "/usr/bin:/bin" }, shell: "/bin/sh" }),
    ).toMatchObject({ kind: "refused", code: "invalid-env" });
    expect(elsewhere.open({ sessionID: "session-alpha", cwd: fx.cwd, env: controlledEnv(fx), shell: "sh" })).toMatchObject({
      kind: "refused",
      code: "invalid-shell",
    });
    expect(atHome.list()).toEqual([]);
    expect(elsewhere.list()).toEqual([]);
  }, 20_000);
});
