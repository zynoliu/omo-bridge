import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * A terminal opens at the size asked for, and a resize reaches the shell it is running.
 *
 * The bridge serves terminals from the fork's own persistent PTY service, so this case drives that
 * service exactly as the pane does: create, read the snapshot, resize, then ask the shell itself
 * (`stty size`) what it thinks its window is. A service that only stored the number would fail that
 * last check.
 */
/* The PTY service derives its roots from the environment at import time, so they are redirected
   before the module is loaded and the user's own state is never touched. */
const roots = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "bridge-resize-"));
  const keys = ["HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const;
  const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  process.env.HOME = dir;
  process.env.XDG_DATA_HOME = path.join(dir, "data");
  process.env.XDG_STATE_HOME = path.join(dir, "state");
  process.env.XDG_CACHE_HOME = path.join(dir, "cache");
  process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  return { dir: dir, previous: previous };
})();

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  let pty: { dispose: () => Promise<void> } | undefined;
  try {
    const { createBridgePty } = await import("../../../packages/cli/src/bridge-pty.ts");
    const service = createBridgePty();
    pty = service;
    const info = await service.create("ses_resize", {
      command: "/bin/sh",
      args: [],
      title: "resize",
      env: { PATH: "/usr/bin:/bin" },
      cols: 80,
      rows: 24,
    });
    const opened = await service.snapshot(info.id);
    record(
      "terminal-opens-at-the-requested-size",
      "80x24",
      String(opened.info.size.cols) + "x" + String(opened.info.size.rows),
      opened.info.size.cols === 80 && opened.info.size.rows === 24,
    );

    const attachment = await service.attach(info.id, {
      cursor: 0,
      attachmentID: "att_resize",
      role: "controller",
      takeover: true,
      onEvent: () => undefined,
      onEnd: () => undefined,
    });
    attachment.activate();
    await service.resize(info.id, 120, 40, "att_resize");
    const resized = await service.snapshot(info.id);
    record(
      "service-reports-the-new-size",
      "120x40",
      String(resized.info.size.cols) + "x" + String(resized.info.size.rows),
      resized.info.size.cols === 120 && resized.info.size.rows === 40,
    );

    /* The shell, not the service, is the authority: `stty size` prints "rows cols". */
    await service.write(info.id, "stty size\n", "att_resize");
    const deadline = Date.now() + 10_000;
    let seen = "";
    while (Date.now() < deadline) {
      seen = JSON.stringify(await service.snapshot(info.id));
      if (seen.includes("40 120")) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    record(
      "resize-reaches-the-shell",
      "stty size prints 40 120",
      seen.includes("40 120") ? "40 120" : "not observed",
      seen.includes("40 120"),
    );

    attachment.detach();
    await service.remove(info.id);
    const listed = await service.list("ses_resize");
    record("terminal-removed", "no terminal left", String(listed.length), listed.length === 0);
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    try {
      await pty?.dispose();
    } catch {
      /* a runtime that is already gone is not a failure of the case */
    }
    for (const [key, value] of roots.previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(roots.dir, { recursive: true, force: true });
    detail.push("terminal runtime disposed and scratch roots removed");
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
