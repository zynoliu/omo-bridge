
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
  const child = path.join(qaRoot, "..", "..", "packages", "tui", "test", "fixture", "mcp-pty-child.tsx")
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
    env: { ...process.env, TERM: "xterm-256color" },
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
    const ready = await waitFor(evidence, (text) => text.includes("MCP_PTY_READY"), READY_TIMEOUT_MS)
    const asked = await waitFor(evidence, (text) => plain(text).includes("approval: echo bridge-mcp-ok"), UPDATE_TIMEOUT_MS)
    const terminal = child.terminal
    /* the approval is one real Enter keystroke; nothing is retried */
    if (asked && terminal !== undefined) terminal.write("d")
    const refused = await waitFor(evidence, (text) => plain(text).includes("MCP_REFUSED"), UPDATE_TIMEOUT_MS)

    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "mcp-deny-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("mcp-allow-pty.txt")
    const png = path.join(context.out, "mcp-deny-screen.png")
    const screen = ready
      ? await screenText({ qaRoot: context.qaRoot, out: context.out, bytes: Buffer.from(captured, "utf8"), cols: TERMINAL_COLS, rows: TERMINAL_ROWS, png: png })
      : ""
    if (ready) {
      fs.writeFileSync(path.join(context.out, "mcp-deny-screen.txt"), screen, { mode: 0o600 })
      artifacts.push("mcp-allow-screen.txt", "mcp-allow-screen.png")
    }
    const flat = screen.replace(/\s+/g, " ")
    const outputShown = flat.split("bridge-mcp-ok").length - 1

    checks = [
      {
        name: "pty-renders-approval",
        expected: "the real PTY shows the write request with its exact content",
        observed: asked ? "approval shown with the exact command" : "not shown; tail: " + plain(captured).slice(-200).trim(),
        pass: ready && asked,
      },
      {
        name: "refused-write-does-not-run",
        expected: "refusing the write runs nothing",
        observed: (/runs=(\d+)/.exec(flat)?.[1] ?? "no run recorded") + (flat.includes("MCP_REFUSED") ? ", refused shown" : ", refusal missing"),
        pass: /runs=0\b/.test(flat) && flat.includes("MCP_REFUSED"),
      },
      {
        name: "output-appears-once",
        expected: "no command output appears on screen",
        observed: String(outputShown) + " occurrence(s) of the output",
        pass: outputShown === 0,
      },
    ]
  } finally {
    cleanupDetail.push(await stop(child))
    cleanupDetail.push("no file was written outside the evidence directory")
  }

  return { checks: checks, cleanup: { ok: true, detail: cleanupDetail }, artifacts: artifacts }
}
