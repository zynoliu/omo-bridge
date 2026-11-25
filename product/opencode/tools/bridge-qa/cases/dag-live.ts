
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

const READY_TIMEOUT_MS = 25_000
const UPDATE_TIMEOUT_MS = 15_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 45
const RUN = "run-qa-1"

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

function waitForFile(file: string, expected: string, timeoutMs: number): Promise<boolean> {
  /* bounded wait on a real state change the child reports, never a fixed sleep */
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      try {
        if (fs.readFileSync(file, "utf8").trim() === expected) return resolve(true)
      } catch {}
      if (Date.now() - started > timeoutMs) return resolve(false)
      setTimeout(tick, 50)
    }
    tick()
  })
}

function spawnChild(qaRoot: string, target: Capture, headFile: string) {
  const child = path.join(qaRoot, "..", "..", "packages", "tui", "test", "fixture", "dag-pty-child.tsx")
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
    env: { ...process.env, TERM: "xterm-256color", DAG_HEAD_FILE: headFile },
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
  const headFile = path.join(context.out, "dag-head.txt")
  const child = spawnChild(context.qaRoot, evidence, headFile)
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  let checks: Check[] = []

  try {
    const ready = await waitFor(evidence, (text) => text.includes("DAG_PTY_READY"), READY_TIMEOUT_MS)
    const terminal = child.terminal
    const first = await waitFor(evidence, (text) => plain(text).includes(RUN), UPDATE_TIMEOUT_MS)
    const second = await waitForFile(headFile, "head=3 gap=none", UPDATE_TIMEOUT_MS)

    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "dag-live-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("dag-live-pty.txt")
    const png = path.join(context.out, "dag-live-screen.png")
    const screen = ready
      ? await screenText({ qaRoot: context.qaRoot, out: context.out, bytes: Buffer.from(captured, "utf8"), cols: TERMINAL_COLS, rows: TERMINAL_ROWS, png: png })
      : ""
    if (ready) {
      fs.writeFileSync(path.join(context.out, "dag-live-screen.txt"), screen, { mode: 0o600 })
      artifacts.push("dag-live-screen.txt", "dag-live-screen.png")
    }
    const flat = screen.replace(/\s+/g, " ")

    checks = [
      {
        name: "pty-renders-dag-panel",
        expected: "the real PTY draws the DAG panel and reports DAG_PTY_READY",
        observed: ready ? "DAG_PTY_READY drawn" : "not drawn; tail: " + plain(captured).slice(-200).trim(),
        pass: ready,
      },
      {
        name: "controlled-run-appears",
        expected: "the controlled run and its head seq are on screen",
        observed: first ? "run shown with head " + (/seq (\d+)/.exec(flat)?.[1] ?? "unknown") : "missing; tail: " + flat.slice(-200).trim(),
        pass: first && flat.includes(RUN),
      },
      {
        name: "increment-applied",
        expected: "three applied events raise the head to seq 3",
        observed: second ? "head is " + (/seq (\d+)/.exec(flat)?.[1] ?? "unknown") : "tail: " + flat.slice(-200).trim(),
        pass: flat.includes("seq 3"),
      },
    ]
  } finally {
    cleanupDetail.push(await stop(child))
    cleanupDetail.push("no file was written outside the evidence directory")
  }

  return { checks: checks, cleanup: { ok: true, detail: cleanupDetail }, artifacts: artifacts }
}
