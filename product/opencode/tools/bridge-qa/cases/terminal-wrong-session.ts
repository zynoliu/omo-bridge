import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { createTerminalStore, screenText } from "../../../packages/tui/src/bridge/features/terminal/index.ts"
import type { TerminalSnapshot, TerminalStore } from "../../../packages/tui/src/bridge/features/terminal/index.ts"

const OWNER = "qa-terminal-owner"
const OTHER = "qa-terminal-other"
const SHELL = "/bin/sh"
const DENIED = "BRIDGE_T19_DENIED"
const WAIT_TIMEOUT_MS = 15_000

function held(store: TerminalStore, id: string): TerminalSnapshot {
  const snapshot = store.snapshot(id)
  if (snapshot === undefined) throw new Error("terminal " + id + " is not held by the store")
  return snapshot
}

function visible(store: TerminalStore, id: string): string {
  return screenText(held(store, id).screen)
}

function hasLine(line: string): (text: string) => boolean {
  return (text) => text.split("\n").some((current) => current.trim() === line)
}

/* The subscription exists before the caller writes; the deadline only bounds how long a missing state change is waited for. */
function waitForScreen(store: TerminalStore, id: string, predicate: (text: string) => boolean): Promise<boolean> {
  if (predicate(visible(store, id))) return Promise.resolve(true)
  const settled = Promise.withResolvers<boolean>()
  const stop = store.subscribe(() => {
    if (predicate(visible(store, id))) settled.resolve(true)
  })
  const timer = setTimeout(() => settled.resolve(false), WAIT_TIMEOUT_MS)
  return settled.promise.then((value) => {
    clearTimeout(timer)
    stop()
    return value
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = []
  const detail: string[] = []
  const artifacts: string[] = []
  const store = createTerminalStore()

  const fixture = path.join(context.out, "fixture")
  const cwd = path.join(fixture, "work")
  const home = path.join(fixture, "home")
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 })
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const realCwd = fs.realpathSync(cwd)
  const realHome = fs.realpathSync(home)

  const opened = store.open({
    sessionID: OWNER,
    cwd: realCwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: realHome,
      PWD: realCwd,
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
      TMPDIR: realHome,
      SHELL: SHELL,
    },
    shell: SHELL,
    title: "QA terminal",
  })
  const terminal = opened.kind === "opened" ? opened.terminal : undefined

  try {
    checks.push({
      name: "pty-opened-for-owner",
      expected: "a terminal bound to the owning session running in the fixture directory",
      observed:
        opened.kind === "opened"
          ? "pid " + String(opened.terminal.pid) + ", session " + opened.terminal.sessionID + ", cwd " + opened.terminal.cwd
          : "open refused: " + opened.code + " " + opened.message,
      pass: terminal !== undefined && terminal.sessionID === OWNER && terminal.cwd === realCwd,
    })

    if (terminal !== undefined) {
      const printed = waitForScreen(store, terminal.id, hasLine(realCwd))
      store.input(OWNER, terminal.id, "pwd\n")
      const baseline = await printed
      const before = visible(store, terminal.id)
      checks.push({
        name: "owner-input-reaches-pty",
        expected: "the owning session's pwd prints " + realCwd,
        observed: baseline ? "line matches " + realCwd : "screen tail " + JSON.stringify(before.slice(-200)),
        pass: baseline,
      })

      const refused = store.input(OTHER, terminal.id, "echo " + DENIED + "\n")
      checks.push({
        name: "cross-session-input-refused",
        expected: "input from another session is refused with session-mismatch",
        observed: refused.kind === "refused" ? refused.kind + ": " + refused.code + " " + refused.message : "written " + String(refused.bytes) + " bytes",
        pass: refused.kind === "refused" && refused.code === "session-mismatch",
      })

      const after = visible(store, terminal.id)
      checks.push({
        name: "target-pty-unchanged",
        expected: "the refused write leaves the target screen byte-for-byte unchanged",
        observed: after === before ? "screen identical, " + String(after.length) + " characters" : "screen changed: " + JSON.stringify(after.slice(-200)),
        pass: after === before,
      })
      checks.push({
        name: "refused-input-never-ran",
        expected: "the refused command never reached the shell",
        observed: after.includes(DENIED) ? "denied text present" : "denied text absent",
        pass: !after.includes(DENIED),
      })

      const answered = waitForScreen(
        store,
        terminal.id,
        (text) => text.split("\n").filter((line) => line.trim() === realCwd).length === 2,
      )
      store.input(OWNER, terminal.id, "pwd\n")
      const stillOwned = await answered
      const finalScreen = visible(store, terminal.id)
      checks.push({
        name: "owner-still-drives-target",
        expected: "the owning session keeps working with the same terminal after the refusal",
        observed: stillOwned ? "second pwd line printed" : "screen tail " + JSON.stringify(finalScreen.slice(-200)),
        pass: stillOwned,
      })
      checks.push({
        name: "target-remains-alive",
        expected: "the target pty is still running under its owner",
        observed: held(store, terminal.id).status + ", pid alive " + String(isAlive(terminal.pid)),
        pass: held(store, terminal.id).status === "running" && isAlive(terminal.pid),
      })

      fs.writeFileSync(path.join(context.out, "screen-before.txt"), before, { mode: 0o600 })
      fs.writeFileSync(path.join(context.out, "screen-after.txt"), finalScreen, { mode: 0o600 })
      artifacts.push("screen-before.txt", "screen-after.txt")
    }
  } finally {
    if (terminal !== undefined) {
      const receipt = await store.close(OWNER, terminal.id)
      if (receipt.kind === "closed") {
        detail.push("pty child exited with code " + String(receipt.exitCode))
        detail.push(
          receipt.stillAlive.length === 0
            ? "no process remains: " + String(receipt.signalled.length) + " descendant(s) signalled, none alive"
            : "still alive after close: " + receipt.stillAlive.join(","),
        )
        detail.push(isAlive(receipt.pid) ? "shell pid still alive" : "shell pid gone")
      } else {
        detail.push("close refused: " + receipt.code)
      }
    } else {
      detail.push("no terminal was opened, no process was created")
    }
    await store.dispose()
    detail.push("store disposed")
  }

  const cleanupOk = detail.every(
    (entry) => !entry.includes("still alive") && !entry.includes("refused") && !entry.includes("did not exit"),
  )
  return { checks: checks, cleanup: { ok: cleanupOk, detail: detail }, artifacts: artifacts }
}
