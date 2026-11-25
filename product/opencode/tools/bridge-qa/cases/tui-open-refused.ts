import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

/**
 * A refused history entry over real keystrokes: the same production Sessions and Transcript views
 * run in a PTY with two held sessions, but only the first is known to the session registry. Enter
 * reopens the first session and shows its transcript; moving to the second and pressing enter is
 * refused, the view shows the refusal code, and the transcript of the open session stays as it was.
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

const DOWN = "\u001b[B"
const ENTER = "\r"
const REFUSAL = "Reopen refused (UNKNOWN_PERSISTENT_ID) for " + BETA_ID

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
 * The driver mounts the production Sessions view and the production Transcript view in a real PTY.
 * Both sessions are held by the bridge, but only the first is registered, so reopening the second
 * is the refusal path the registry defines for an identity it never recorded.
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
import { Sessions } from ${JSON.stringify(path.join(root, "packages/tui/src/bridge/features/sessions/index.ts"))}
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

const sessions = new SessionRegistry()
const alpha = sessions.open({ persistentId: ALPHA_ID, history: [${JSON.stringify(ALPHA_RECORDED)}] })
if (alpha.kind !== "ok") throw new Error("alpha fixture refused the open")
sessions.park(alpha.value)

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
          flat.includes(squash(BETA_TITLE))
        )
      },
      READY_TIMEOUT_MS,
    )

    const terminal = driver.terminal
    // First key phase: reopen the registered session so an existing session and its transcript exist.
    if (ready && terminal !== undefined) terminal.write(ENTER)
    const baselineOpened = await waitFor(
      evidence,
      (text) => /Reopened\s+qa-history-alpha\s+as\s+sess_\d+/.test(plain(text)),
      SCREEN_TIMEOUT_MS,
    )
    const baselineTranscript = await waitFor(
      evidence,
      (text) => squash(plain(text)).includes(squash(ALPHA_TEXT)),
      SCREEN_TIMEOUT_MS,
    )

    // Second key phase: move to the session the registry never recorded and try to reopen it.
    if (baselineTranscript && terminal !== undefined) {
      terminal.write(DOWN)
      terminal.write(ENTER)
    }
    const refused = await waitFor(evidence, (text) => squash(plain(text)).includes(squash(REFUSAL)), SCREEN_TIMEOUT_MS)

    const captured = evidence.text()
    const captureBytes = Buffer.byteLength(captured, "utf8")
    fs.writeFileSync(path.join(context.out, "tui-open-refused-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-open-refused-pty.txt")

    const screen = refused
      ? await screenText({
          qaRoot: context.qaRoot,
          out: context.out,
          bytes: new TextEncoder().encode(captured),
          cols: COLS,
          rows: ROWS,
        })
      : ""
    fs.writeFileSync(path.join(context.out, "tui-open-refused-screen.txt"), screen, { mode: 0o600 })
    artifacts.push("tui-open-refused-screen.txt")
    const flatScreen = squash(screen)

    checks = [
      {
        name: "fixture-sessions-visible",
        expected: "both held sessions appear before any key is pressed",
        observed: ready ? "alpha + beta sessions visible" : "fixture not ready; tail: " + squash(plain(evidence.text())).slice(-200),
        pass: ready,
      },
      {
        name: "existing-session-opened-first",
        expected: "enter opens " + ALPHA_ID + " and its transcript is on screen",
        observed: baselineTranscript ? "alpha transcript rendered" : "alpha transcript missing",
        pass: baselineOpened && baselineTranscript,
      },
      {
        name: "refused-reopen-shows-error",
        expected: "the view reports " + REFUSAL,
        observed: refused ? "refusal line on the stream" : "no refusal line; tail: " + squash(plain(evidence.text())).slice(-200),
        pass: refused && flatScreen.includes(squash(REFUSAL)),
      },
      {
        name: "existing-session-unchanged",
        expected: "the open session's assistant text and tool result stay on screen after the refusal",
        observed:
          "alpha text " +
          (flatScreen.includes(squash(ALPHA_TEXT)) ? "kept" : "lost") +
          ", alpha tool result " +
          (flatScreen.includes(squash(ALPHA_TOOL_RESULT)) ? "kept" : "lost"),
        pass: flatScreen.includes(squash(ALPHA_TEXT)) && flatScreen.includes(squash(ALPHA_TOOL_RESULT)),
      },
      {
        name: "refused-session-transcript-not-opened",
        expected: "the refused session's assistant text and tool result never reach the screen",
        observed:
          "beta text " +
          (flatScreen.includes(squash(BETA_TEXT)) ? "present" : "absent") +
          ", beta tool result " +
          (flatScreen.includes(squash(BETA_TOOL_RESULT)) ? "present" : "absent"),
        pass: !flatScreen.includes(squash(BETA_TEXT)) && !flatScreen.includes(squash(BETA_TOOL_RESULT)),
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
