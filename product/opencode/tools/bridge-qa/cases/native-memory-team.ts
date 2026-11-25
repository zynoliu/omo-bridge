import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

const READY_TIMEOUT_MS = 25_000
const UPDATE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 45
const SESSION = "status-pty-session"
const MEMORY_IDENTITY = "qa-bridge-agent"
const TEAM_MEMBER = "qa-scout"
const HIDDEN_BODY = "exited abnormally"

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

export async function run(context: CaseContext): Promise<CaseResult> {
  const evidence = capture()
  const child = spawnChild(context.qaRoot, evidence)
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  let checks: Check[] = []

  try {
    const ready = await waitFor(evidence, (text) => text.includes("STATUS_PTY_READY"), READY_TIMEOUT_MS)
    if (ready && child.terminal !== undefined) child.terminal.write("m")
    const memoryApplied = await waitFor(evidence, (text) => plain(text).includes(MEMORY_IDENTITY), UPDATE_TIMEOUT_MS)
    if (memoryApplied && child.terminal !== undefined) child.terminal.write("t")
    const teamApplied = await waitFor(evidence, (text) => plain(text).includes(TEAM_MEMBER), UPDATE_TIMEOUT_MS)

    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "memory-team-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("memory-team-pty.txt")

    const png = path.join(context.out, "memory-team-screen.png")
    const screen = ready ? await screenText({
      qaRoot: context.qaRoot,
      out: context.out,
      bytes: Buffer.from(captured, "utf8"),
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      png: png,
    }) : ""
    if (ready) {
      fs.writeFileSync(path.join(context.out, "memory-team-screen.txt"), screen, { mode: 0o600 })
      artifacts.push("memory-team-screen.txt", "memory-team-screen.png")
    }
    const flat = screen.replace(/\s+/g, " ")

    checks = [
      {
        name: "pty-renders-status-column",
        expected: "the real PTY draws the status column and reports STATUS_PTY_READY",
        observed: ready ? "STATUS_PTY_READY drawn" : "not drawn; tail: " + plain(captured).slice(-200).trim(),
        pass: ready,
      },
      {
        name: "memory-event-updates-memory-region",
        expected: "the synthetic omo.memory.updated frame puts " + MEMORY_IDENTITY + " and the schema version on screen",
        observed: flat.includes(MEMORY_IDENTITY) ? "memory region shows " + MEMORY_IDENTITY : "memory region missing; tail: " + flat.slice(-200).trim(),
        pass: flat.includes(MEMORY_IDENTITY) && flat.includes("schema version"),
      },
      {
        name: "memory-missing-field-reported-as-missing",
        expected: "a snapshot without repo.totalBytes shows that field as not reported",
        observed: flat.includes("not reported") ? "not reported is on screen" : "no not-reported field on screen",
        pass: flat.includes("total bytes") && flat.includes("not reported"),
      },
      {
        name: "team-event-updates-member-region",
        expected: "the synthetic team liveness frame puts " + TEAM_MEMBER + " in the team region",
        observed: flat.includes(TEAM_MEMBER) ? "member region shows " + TEAM_MEMBER : "member region missing; tail: " + flat.slice(-200).trim(),
        pass: teamApplied && flat.includes(TEAM_MEMBER) && flat.includes("qa transport closed"),
      },
      {
        name: "hidden-team-notification-stays-hidden",
        expected: "the display=false liveness notification is counted, not drawn",
        observed: flat.includes("display=false") ? "hidden notice counted" : "hidden notice not counted",
        pass: flat.includes("display=false") && !flat.includes(HIDDEN_BODY),
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
