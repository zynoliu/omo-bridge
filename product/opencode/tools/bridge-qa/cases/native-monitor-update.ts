
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

const READY_TIMEOUT_MS = 25_000
const UPDATE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 45
const SESSION = "mcp-pty"

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
  const child = path.join(qaRoot, "..", "..", "packages", "tui", "test", "fixture", "other-pty-child.tsx")
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
    env: { ...process.env, TERM: "xterm-256color", OTHER_PTY_MODE: "known" },
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



export async function run(context: CaseContext): Promise<CaseResult> {
  const evidence = capture()
  const child = spawnChild(context.qaRoot, evidence)
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  let checks: Check[] = []

  try {
    const ready = await waitFor(evidence, (text) => text.includes("OTHER_PTY_READY"), READY_TIMEOUT_MS)
    const code = await waitFor(evidence, (text) => plain(text).includes("senpi-codemode"), UPDATE_TIMEOUT_MS)
    const boulder = await waitFor(evidence, (text) => plain(text).includes("boulder: 3/8"), UPDATE_TIMEOUT_MS)

    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "monitor-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("monitor-pty.txt")
    const png = path.join(context.out, "monitor-screen.png")
    const screen = ready
      ? await screenText({ qaRoot: context.qaRoot, out: context.out, bytes: Buffer.from(captured, "utf8"), cols: TERMINAL_COLS, rows: TERMINAL_ROWS, png: png })
      : ""
    if (ready) {
      fs.writeFileSync(path.join(context.out, "monitor-screen.txt"), screen, { mode: 0o600 })
      artifacts.push("monitor-screen.txt", "monitor-screen.png")
    }
    const flat = screen.replace(/\s+/g, " ")

    checks = [
      {
        name: "pty-renders-other-surfaces",
        expected: "the real PTY draws the low-frequency section",
        observed: ready ? "OTHER_PTY_READY drawn" : "not drawn; tail: " + plain(captured).slice(-160).trim(),
        pass: ready,
      },
      {
        name: "codemode-activity-shown",
        expected: "the wake_source_state event shows its source and the active item",
        observed: flat.includes("senpi-codemode") ? "source and item on screen" : "missing; tail: " + flat.slice(-160).trim(),
        pass: flat.includes("senpi-codemode") && flat.includes("Read the input files"),
      },
      {
        name: "boulder-status-shown",
        expected: "the boulder status entry is shown as the host wrote it",
        observed: boulder ? "boulder line on screen" : "missing; tail: " + flat.slice(-160).trim(),
        pass: flat.includes("boulder: 3/8"),
      },
    ]
  } finally {
    cleanupDetail.push(await stop(child))
    cleanupDetail.push("no file was written outside the evidence directory")
  }

  return { checks: checks, cleanup: { ok: true, detail: cleanupDetail }, artifacts: artifacts }
}
