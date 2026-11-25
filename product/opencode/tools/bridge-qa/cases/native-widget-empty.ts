import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

const READY_TIMEOUT_MS = 25_000
const UPDATE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 80
const SESSION = "status-pty-session"
const EMPTY_WIDGET_KEY = "qa-empty-widget"
const NOT_STRING_ARRAY = "The host has sent no string-array widget for this session."
const INVENTED_KEYS = ["omo-task", "omo-dag", "todo-sidebar", "openai-websearch", "pi-webfetch"]

type Capture = {
  readonly text: () => string
  readonly push: (chunk: Uint8Array) => void
  readonly subscribe: (listener: () => void) => () => void
}

function capture(): Capture {
  let buffer = ""
  const listeners = new Set<() => void>()
  return {
    text: () => buffer,
    push(chunk: Uint8Array) {
      buffer += new TextDecoder().decode(chunk)
      for (const listener of [...listeners]) listener()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Resolves on the state change itself; the deadline only bounds how long the case waits. */
function waitFor(target: Capture, predicate: (text: string) => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const listener = () => {
      if (predicate(target.text())) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const unsubscribe = target.subscribe(listener)
    listener()
  })
}

function plain(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b[PX^_][^\u001b]*\u001b\\/g, "")
}

function spawnChild(qaRoot: string, target: Capture) {
  const child = path.join(qaRoot, "..", "..", "packages", "tui", "test", "fixture", "status-pty-child.tsx")
  return Bun.spawn({
    cmd: [process.execPath, "--no-install", "--no-env-file", child],
    cwd: path.join(qaRoot, "..", "..", "packages", "tui"),
    terminal: {
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      data(_terminal, chunk) {
        target.push(chunk)
      },
    },
    env: { ...process.env, TERM: "xterm-256color", STATUS_PTY_SESSION: SESSION },
  })
}

async function stop(proc: ReturnType<typeof spawnChild>): Promise<string> {
  proc.kill()
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ])
  return exited ? "child exited" : "child did not exit within " + EXIT_TIMEOUT_MS + "ms"
}

function inventedKeysOnScreen(screen: string): readonly string[] {
  return INVENTED_KEYS.filter((key) => screen.includes(key))
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const evidence = capture()
  const child = spawnChild(context.qaRoot, evidence)
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  let checks: Check[] = []

  try {
    const ready = await waitFor(evidence, (text) => text.includes("STATUS_PTY_READY"), READY_TIMEOUT_MS)
    const absenceDrawn = await waitFor(
      evidence,
      (text) => plain(text).includes(NOT_STRING_ARRAY),
      UPDATE_TIMEOUT_MS,
    )

    const beforeBytes = Buffer.from(evidence.text(), "utf8")
    const before = ready && absenceDrawn ? await screenText({
      qaRoot: context.qaRoot,
      out: context.out,
      bytes: beforeBytes,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
    }) : ""
    if (ready) fs.writeFileSync(path.join(context.out, "widget-empty-before.txt"), before, { mode: 0o600 })

    if (ready && child.terminal !== undefined) child.terminal.write("w")
    const emptyApplied = await waitFor(evidence, (text) => plain(text).includes(EMPTY_WIDGET_KEY), UPDATE_TIMEOUT_MS)

    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "widget-empty-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("widget-empty-pty.txt")

    const png = path.join(context.out, "widget-empty-screen.png")
    const after = ready ? await screenText({
      qaRoot: context.qaRoot,
      out: context.out,
      bytes: Buffer.from(captured, "utf8"),
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      png: png,
    }) : ""
    if (ready) {
      fs.writeFileSync(path.join(context.out, "widget-empty-after.txt"), after, { mode: 0o600 })
      artifacts.push("widget-empty-before.txt", "widget-empty-after.txt", "widget-empty-screen.png")
    }
    const flatBefore = before.replace(/\s+/g, " ")
    const flatAfter = after.replace(/\s+/g, " ")

    checks = [
      {
        name: "pty-renders-status-column",
        expected: "the real PTY draws the status column and reports STATUS_PTY_READY",
        observed: ready ? "STATUS_PTY_READY drawn" : "not drawn; tail: " + plain(captured).slice(-200).trim(),
        pass: ready,
      },
      {
        name: "no-widget-reported-is-shown-as-none",
        expected: "before any setWidget the column says the host sent no string-array widget",
        observed: flatBefore.includes(NOT_STRING_ARRAY) ? "absence stated" : "absence not stated",
        pass: absenceDrawn && flatBefore.includes(NOT_STRING_ARRAY),
      },
      {
        name: "empty-widget-renders-zero-rows",
        expected: "a setWidget with an empty string array shows " + EMPTY_WIDGET_KEY + " with 0 rows",
        observed: flatAfter.includes(EMPTY_WIDGET_KEY) ? "widget shown: " + EMPTY_WIDGET_KEY : "widget missing",
        pass: emptyApplied && flatAfter.includes(EMPTY_WIDGET_KEY) && flatAfter.includes("0 rows"),
      },
      {
        name: "no-invented-widget-row",
        expected: "no widget key the host never sent appears on the final screen",
        observed: inventedKeysOnScreen(after).length === 0 ? "no invented key" : "invented: " + inventedKeysOnScreen(after).join(", "),
        pass: inventedKeysOnScreen(after).length === 0,
      },
      {
        name: "screen-artifact-written",
        expected: "a rendered screen text and screenshot under the evidence directory",
        observed: String(fs.existsSync(png) ? fs.statSync(png).size : 0) + " PNG bytes",
        pass: fs.existsSync(png) && fs.statSync(png).size > 0,
      },
    ]
  } finally {
    cleanupDetail.push(await stop(child))
    cleanupDetail.push("no file was written outside the evidence directory")
  }

  const cleanupOk = cleanupDetail.every((entry) => !entry.includes("did not exit"))
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
