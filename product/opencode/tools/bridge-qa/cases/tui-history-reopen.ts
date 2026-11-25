import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

/**
 * Reopening a session from its recorded history, over real keystrokes: the driver mounts the real
 * Sessions and Transcript components in a PTY with two isolated fixture sessions, the case presses
 * down and enter on the transport, and the TUI must reopen the selected session and show that
 * session's assistant text and tool result rather than the other session's.
 *
 * The active list and the recorded history stay separate: rows come from the bridge's held host
 * payloads, history blocks from the session registry, and history seeded for an id no payload
 * backs must never become a row.
 */

const READY_TIMEOUT_MS = 25_000
const SCREEN_TIMEOUT_MS = 25_000
const EXIT_TIMEOUT_MS = 5_000
const COLS = 120
const ROWS = 48

const ALPHA_ID = "qa-history-alpha"
const BETA_ID = "qa-history-beta"
const ALPHA_TITLE = "History alpha session"
const BETA_TITLE = "History beta session"
const ALPHA_TEXT = "alpha-assistant-text-31"
const BETA_TEXT = "beta-assistant-text-42"
const ALPHA_TOOL_RESULT = "alpha-tool-result-77"
const BETA_TOOL_RESULT = "beta-tool-result-88"
const ALPHA_RECORDED = "alpha recorded turn"
const BETA_RECORDED = "beta recorded turn"
const GHOST_ID = "ghost-history"
const GHOST_ENTRY = "ghost-history-entry"

const DOWN = "\u001b[B"
const ENTER = "\r"

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

function squash(text: string): string {
  return text.replace(/\s+/g, "")
}

/**
 * The driver mounts the production Sessions view and the production Transcript view in a real PTY,
 * against an isolated BridgeData and SessionRegistry this case owns. Both fixture sessions report
 * distinct assistant text and tool results, so landing on the wrong one is visible.
 */
function driverSource(root: string): string {
  return `/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client"
import { BridgeData } from ${JSON.stringify(path.join(root, "packages/bridge-core/src/data.ts"))}
import { DialogRegistry } from ${JSON.stringify(path.join(root, "packages/bridge-core/src/dialogs.ts"))}
import { InteractionController } from ${JSON.stringify(path.join(root, "packages/bridge-core/src/interaction.ts"))}
import { SessionRegistry } from ${JSON.stringify(path.join(root, "packages/bridge-core/src/sessions.ts"))}
import { createBridgeTuiData } from ${JSON.stringify(path.join(root, "packages/tui/src/context/bridge-data.ts"))}
import {
  createSessionsStore,
  Sessions,
} from ${JSON.stringify(path.join(root, "packages/tui/src/bridge/features/sessions/index.ts"))}
import { Transcript } from ${JSON.stringify(path.join(root, "packages/tui/src/bridge/features/transcript/index.ts"))}
import { ConfigProvider } from ${JSON.stringify(path.join(root, "packages/tui/src/config"))}
import { ThemeProvider } from ${JSON.stringify(path.join(root, "packages/tui/src/context/theme"))}
import { bridgeEvents } from ${JSON.stringify(path.join(root, "packages/tui/test/fixture/bridge-events.ts"))}
import { emptyThemeSource } from ${JSON.stringify(path.join(root, "packages/tui/test/fixture/fixture.ts"))}
import { createTuiResolvedConfig } from ${JSON.stringify(path.join(root, "packages/tui/test/fixture/tui-runtime.ts"))}

const ALPHA_ID = ${JSON.stringify(ALPHA_ID)}
const BETA_ID = ${JSON.stringify(BETA_ID)}
const ALPHA_TEXT = ${JSON.stringify(ALPHA_TEXT)}
const BETA_TEXT = ${JSON.stringify(BETA_TEXT)}
const ALPHA_TOOL_RESULT = ${JSON.stringify(ALPHA_TOOL_RESULT)}
const BETA_TOOL_RESULT = ${JSON.stringify(BETA_TOOL_RESULT)}
const GHOST_ID = ${JSON.stringify(GHOST_ID)}
const GHOST_ENTRY = ${JSON.stringify(GHOST_ENTRY)}

function info(id: string, title: string): SessionInfo {
  return {
    id: id,
    projectID: "qa-history-project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: title,
    location: { directory: "/workspace/" + id },
  }
}

function messages(text: string, toolResult: string): SessionMessageInfo[] {
  return [
    { id: "user-" + text, type: "user", time: { created: 1 }, text: "prompt for " + text },
    {
      id: "assistant-" + text,
      type: "assistant",
      agent: "build",
      model: { providerID: "fixture", id: "fixture-model" },
      time: { created: 2, completed: 9 },
      content: [
        { type: "text", text: text },
        {
          type: "tool",
          id: "call-" + text,
          name: "bash",
          time: { created: 3, completed: 4 },
          state: {
            status: "completed",
            input: { command: "cat " + text + ".txt" },
            content: [{ type: "text", text: toolResult }],
            metadata: {},
          },
        },
      ],
    },
  ]
}

const data = new BridgeData()
data.upsertHostSession(info(ALPHA_ID, ${JSON.stringify(ALPHA_TITLE)}))
data.upsertHostSession(info(BETA_ID, ${JSON.stringify(BETA_TITLE)}))
data.setHostMessages(ALPHA_ID, messages(ALPHA_TEXT, ALPHA_TOOL_RESULT))
data.setHostMessages(BETA_ID, messages(BETA_TEXT, BETA_TOOL_RESULT))

/* The ghost entry is history the registry knows but no host payload backs: it must stay history. */
const sessions = new SessionRegistry({ historyByPersistentId: { [GHOST_ID]: [GHOST_ENTRY] } })
const alpha = sessions.open({ persistentId: ALPHA_ID, history: [${JSON.stringify(ALPHA_RECORDED)}] })
if (alpha.kind !== "ok") throw new Error("alpha fixture refused the open")
sessions.park(alpha.value)
const beta = sessions.open({ persistentId: BETA_ID, history: [${JSON.stringify(BETA_RECORDED)}] })
if (beta.kind !== "ok") throw new Error("beta fixture refused the open")
sessions.park(beta.value)

const tui = createBridgeTuiData({
  data: data,
  sessions: sessions,
  dialogs: new DialogRegistry(),
  interaction: new InteractionController(),
  defaultLocation: { directory: "/workspace" },
  events: bridgeEvents(data),
})

const [opened, setOpened] = createSignal<string>()

const renderer = await createCliRenderer({
  externalOutputMode: "passthrough",
  targetFps: 30,
  gatherStats: false,
  exitOnCtrlC: true,
  useKittyKeyboard: {},
  autoFocus: false,
  openConsoleOnError: false,
  useMouse: false,
})
await render(
  () => (
    <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
      <ThemeProvider mode="dark" source={emptyThemeSource}>
        <box flexDirection="column" flexShrink={0}>
          <text>HISTORY_DRIVER_READY</text>
          <Sessions
            data={tui}
            sessions={sessions}
            onOpen={(session) => setOpened(session.persistentId)}
          />
          <Show when={opened()} keyed>
            {(sessionID) => <Transcript data={tui} sessionID={sessionID} />}
          </Show>
        </box>
      </ThemeProvider>
    </ConfigProvider>
  ),
  renderer,
)
`
}

function spawnDriver(root: string, out: string, target: Capture) {
  return Bun.spawn({
    cmd: [process.execPath, "--no-install", "--no-env-file", path.join(out, "driver", "driver.tsx")],
    // The TUI's JSX runtime resolves through the CLI package's tsconfig, as in `bun run dev`.
    cwd: path.join(root, "packages", "cli"),
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_terminal, chunk) {
        target.push(chunk)
      },
    },
    env: {
      ...process.env,
      TERM: "xterm-256color",
      HOME: path.join(out, "home"),
      TMPDIR: path.join(out, "tmp"),
    },
  })
}

async function stop(proc: ReturnType<typeof spawnDriver>): Promise<string> {
  proc.kill()
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ])
  return exited ? "driver exited" : "driver did not exit within " + EXIT_TIMEOUT_MS + "ms"
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const root = path.join(context.qaRoot, "..", "..")
  const driverDirectory = path.join(context.out, "driver")
  fs.mkdirSync(driverDirectory, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(context.out, "home"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(context.out, "tmp"), { recursive: true, mode: 0o700 })
  fs.symlinkSync(path.join(root, "packages", "tui", "node_modules"), path.join(driverDirectory, "node_modules"))
  fs.writeFileSync(path.join(driverDirectory, "driver.tsx"), driverSource(root), { mode: 0o600 })

  const evidence = capture()
  const children: ReturnType<typeof spawnDriver>[] = []
  const cleanupDetail: string[] = []
  const artifacts: string[] = ["driver/driver.tsx"]
  let checks: Check[] = []

  try {
    const driver = spawnDriver(root, context.out, evidence)
    children.push(driver)

    const ready = await waitFor(
      evidence,
      (text) => {
        const flat = squash(plain(text))
        return (
          flat.includes("HISTORY_DRIVER_READY") &&
          flat.includes(squash(ALPHA_TITLE)) &&
          flat.includes(squash(BETA_TITLE)) &&
          flat.includes("Recordedhistory")
        )
      },
      READY_TIMEOUT_MS,
    )

    const terminal = driver.terminal
    const keysSent = ready && terminal !== undefined
    // Two real keystrokes: move the list selection to the second held session, then reopen it.
    if (keysSent && terminal !== undefined) {
      terminal.write(DOWN)
      terminal.write(ENTER)
    }

    const reopened = await waitFor(evidence, (text) => /Reopened\s+qa-history-beta\s+as\s+sess_\d+/.test(plain(text)), SCREEN_TIMEOUT_MS)
    const transcript = await waitFor(
      evidence,
      (text) => {
        const flat = squash(plain(text))
        return flat.includes(squash(BETA_TEXT)) && flat.includes(squash(BETA_TOOL_RESULT))
      },
      SCREEN_TIMEOUT_MS,
    )

    const captured = evidence.text()
    const captureBytes = Buffer.byteLength(captured, "utf8")
    fs.writeFileSync(path.join(context.out, "tui-history-reopen-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-history-reopen-pty.txt")

    const screen = reopened && transcript
      ? await screenText({
          qaRoot: context.qaRoot,
          out: context.out,
          bytes: new TextEncoder().encode(captured),
          cols: COLS,
          rows: ROWS,
        })
      : ""
    fs.writeFileSync(path.join(context.out, "tui-history-reopen-screen.txt"), screen, { mode: 0o600 })
    artifacts.push("tui-history-reopen-screen.txt")
    const flatScreen = squash(screen)
    const reopenedLine = /Reopened\s+qa-history-beta\s+as\s+sess_\d+/.exec(screen)?.[0]?.replace(/\s+/g, " ") ?? ""

    checks = [
      {
        name: "fixture-sessions-and-history-visible",
        expected: "both held sessions and their recorded history blocks appear before any key is pressed",
        observed: ready
          ? "alpha + beta sessions and recorded history visible"
          : "fixture not ready; tail: " + squash(plain(evidence.text())).slice(-200),
        pass: ready,
      },
      {
        name: "reopen-from-history-by-keys",
        expected: "down then enter reopens " + BETA_ID + " and the view reports the new handle",
        observed: reopened ? reopenedLine : "no reopen report on the stream",
        pass: reopened,
      },
      {
        name: "target-transcript-restored",
        expected: "the reopened session's assistant text and tool result are on the final screen",
        observed: transcript
          ? "beta assistant text and tool result rendered"
          : "target transcript missing; tail: " + squash(plain(evidence.text())).slice(-200),
        pass: transcript && flatScreen.includes(squash(BETA_TEXT)) && flatScreen.includes(squash(BETA_TOOL_RESULT)),
      },
      {
        name: "other-session-transcript-not-shown",
        expected: "the first session's assistant text and tool result are absent after the reopen",
        observed:
          "alpha text " +
          (flatScreen.includes(squash(ALPHA_TEXT)) ? "present" : "absent") +
          ", alpha tool result " +
          (flatScreen.includes(squash(ALPHA_TOOL_RESULT)) ? "present" : "absent"),
        pass: reopened && !flatScreen.includes(squash(ALPHA_TEXT)) && !flatScreen.includes(squash(ALPHA_TOOL_RESULT)),
      },
      {
        name: "history-stays-out-of-the-active-list",
        expected: "the recorded entries are shown as history while history seeded for an unheld id never becomes a row",
        observed:
          "recorded " +
          (flatScreen.includes(squash(ALPHA_RECORDED)) && flatScreen.includes(squash(BETA_RECORDED)) ? "both shown" : "missing") +
          ", ghost row " +
          (flatScreen.includes(squash(GHOST_ID)) ? "present" : "absent") +
          ", ghost entry " +
          (flatScreen.includes(squash(GHOST_ENTRY)) ? "present" : "absent"),
        pass:
          reopened &&
          flatScreen.includes(squash(ALPHA_RECORDED)) &&
          flatScreen.includes(squash(BETA_RECORDED)) &&
          !flatScreen.includes(squash(GHOST_ID)) &&
          !flatScreen.includes(squash(GHOST_ENTRY)),
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture under the evidence directory",
        observed: String(captureBytes) + " bytes",
        pass: captureBytes > 0,
      },
    ]
  } finally {
    for (const child of children) cleanupDetail.push(await stop(child))
    cleanupDetail.push("isolated fixture sessions only; no host socket or user session data was read")
  }

  const cleanupOk = cleanupDetail.every((entry) => !entry.includes("did not exit"))
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
