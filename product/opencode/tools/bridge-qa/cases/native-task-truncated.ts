import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

const READY_TIMEOUT_MS = 25_000
const STAGE_TIMEOUT_MS = 25_000
const EXIT_TIMEOUT_MS = 5_000
const COLS = 110
const ROWS = 40

const TRUNCATED_TOKEN = "3 task(s) are missing"
const TASK_REFUSAL_TOKEN = "Refused (PARENT_SESSION_REQUIRED)"
const APPROVAL_REFUSAL_TOKEN = "Refused (CROSS_SESSION_APPROVAL)"

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

/**
 * The driver writes what each refused action did — how many task actions and how many dialog answers
 * reached a write path — beside the screen, so "no wrong action" is a recorded count and not only an
 * absent pixel.
 */
function driverSource(root: string, out: string): string {
  return `import { appendFileSync, readFileSync, watch } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { ConfigProvider } from ${JSON.stringify(path.join(root, "packages/tui/src/config"))}
import { ThemeProvider } from ${JSON.stringify(path.join(root, "packages/tui/src/context/theme"))}
import { createTasksStore, Tasks } from ${JSON.stringify(path.join(root, "packages/tui/src/bridge/features/tasks/index.ts"))}
import { createTuiResolvedConfig } from ${JSON.stringify(path.join(root, "packages/tui/test/fixture/tui-runtime"))}

const OUT = ${JSON.stringify(out)}
const CONTROL = OUT + "/driver/control.txt"
const RECEIPT = OUT + "/driver/receipt.json"
const SESSION = "qa-thread-1"
const sent = []
const written = []
const store = createTasksStore({
  sessionID: SESSION,
  sendTaskAction: (action) => sent.push(action.taskId),
  respond: (requestId) => written.push(requestId),
})

const stages = {
  quit() {},
  truncated() {
    store.applyTaskSnapshot({
      parentSessionId: SESSION,
      tasks: [
        {
          id: "task-visible",
          parentSessionId: SESSION,
          status: "running",
          description: "Only the tail of the store reached this snapshot",
          descriptionTruncated: true,
          error: null,
          errorTruncated: false,
        },
      ],
      omitted: 3,
    })
  },
  cross() {
    store.applyTaskSnapshot({
      parentSessionId: SESSION,
      tasks: [
        {
          id: "task-other",
          parentSessionId: "session-parent-9",
          status: "running",
          description: "Owned by the parent session",
          descriptionTruncated: false,
          error: null,
          errorTruncated: false,
        },
      ],
      omitted: 0,
    })
    const task = store.actOnTask("task-other", "cancel")
    const frame = store.applyWireFrame({
      type: "extension_ui_request",
      id: "ui-perm-other",
      method: "select",
      title: "Permission required: bash\\n\\nCommand: rm -rf build",
      options: ["Allow once", "Deny"],
      sessionId: "session-parent-9",
    })
    const approval = store.answerApproval("ui-perm-other", "Allow once")
    appendFileSync(
      RECEIPT,
      JSON.stringify({
        sent: sent.length,
        written: written.length,
        frame: frame.kind,
        task: task.kind === "refused" ? task.code : task.kind,
        approval: approval.kind === "refused" ? approval.code : approval.kind,
      }) + "\\n",
    )
  },
}

const applied = new Set()
function applyPending() {
  let text = ""
  try {
    text = readFileSync(CONTROL, "utf8")
  } catch {
    return
  }
  for (const line of text.split("\\n")) {
    const stage = line.trim()
    if (stage.length === 0 || applied.has(stage)) continue
    const run = stages[stage]
    if (run === undefined) continue
    applied.add(stage)
    run()
  }
}

const renderer = await createCliRenderer({
  externalOutputMode: "passthrough",
  targetFps: 60,
  gatherStats: false,
  exitOnCtrlC: false,
  useKittyKeyboard: {},
  autoFocus: false,
  openConsoleOnError: false,
  useMouse: false,
})
await render(
  () => (
    <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
      <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
        <Tasks store={store} />
      </ThemeProvider>
    </ConfigProvider>
  ),
  renderer,
)
stages.quit = () => {
  renderer.destroy()
  process.exit(0)
}
watch(OUT + "/driver", () => applyPending())
applyPending()
`
}

function spawnDriver(root: string, out: string, target: Capture) {
  return Bun.spawn({
    cmd: [process.execPath, "--no-install", "--no-env-file", path.join(out, "driver", "driver.tsx")],
    cwd: path.join(root, "packages/cli"),
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

async function stop(
  proc: ReturnType<typeof spawnDriver>,
  control: (stage: string) => void,
): Promise<string> {
  control("quit")
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ])
  if (exited) return "driver exited"
  proc.kill("SIGKILL")
  const forced = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ])
  return forced ? "driver required SIGKILL after the quit line" : "driver did not exit"
}

async function snapshotScreen(context: CaseContext, evidence: Capture, name: string): Promise<string> {
  const text = await screenText({
    qaRoot: context.qaRoot,
    out: context.out,
    bytes: new TextEncoder().encode(evidence.text()),
    cols: COLS,
    rows: ROWS,
  })
  fs.writeFileSync(path.join(context.out, name + ".txt"), text, { mode: 0o600 })
  return text
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ")
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const root = path.join(context.qaRoot, "..", "..")
  const driverDirectory = path.join(context.out, "driver")
  fs.mkdirSync(driverDirectory, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(context.out, "home"), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(context.out, "tmp"), { recursive: true, mode: 0o700 })
  fs.symlinkSync(path.join(root, "packages", "tui", "node_modules"), path.join(driverDirectory, "node_modules"))
  fs.writeFileSync(path.join(driverDirectory, "driver.tsx"), driverSource(root, context.out), { mode: 0o600 })

  const evidence = capture()
  const children: ReturnType<typeof spawnDriver>[] = []
  const cleanupDetail: string[] = []
  const artifacts: string[] = ["driver/driver.tsx"]
  let checks: Check[] = []

  const control = (stage: string) => {
    const file = path.join(driverDirectory, "control.txt")
    const held = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    fs.writeFileSync(file, held + stage + "\n", { mode: 0o600 })
  }

  try {
    const driver = spawnDriver(root, context.out, evidence)
    children.push(driver)

    const ready = await waitFor(evidence, (text) => plain(text).includes("Tasks and subagents"), READY_TIMEOUT_MS)

    control("truncated")
    const truncatedShown = await waitFor(
      evidence,
      (text) => plain(text).includes(TRUNCATED_TOKEN),
      STAGE_TIMEOUT_MS,
    )
    const truncatedScreen = truncatedShown ? await snapshotScreen(context, evidence, "screen-truncated") : ""

    control("cross")
    const refusalShown = await waitFor(
      evidence,
      (text) => plain(text).includes(APPROVAL_REFUSAL_TOKEN),
      STAGE_TIMEOUT_MS,
    )
    const refusalScreen = refusalShown ? await snapshotScreen(context, evidence, "screen-refusal") : ""

    const receiptPath = path.join(driverDirectory, "receipt.json")
    const receiptText = fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath, "utf8").trim() : ""
    const receipt: Record<string, unknown> = receiptText.length === 0 ? {} : JSON.parse(receiptText)
    if (receiptText.length > 0) artifacts.push("driver/receipt.json")

    fs.writeFileSync(path.join(context.out, "native-task-truncated-pty.txt"), evidence.text(), { mode: 0o600 })
    artifacts.push("screen-truncated.txt", "screen-refusal.txt", "native-task-truncated-pty.txt")

    const flatTruncated = squash(truncatedScreen)
    const flatRefusal = squash(refusalScreen)

    checks = [
      {
        name: "truncation-visible",
        expected: "the truncated snapshot says how many rows the host left out and never reads as complete",
        observed: truncatedShown
          ? "omitted note " +
            (flatTruncated.includes(TRUNCATED_TOKEN) ? "shown" : "missing") +
            ", complete claim " +
            (flatTruncated.includes("reported this snapshot as complete") ? "present" : "absent")
          : "no truncated screen; tail: " + squash(plain(evidence.text())).slice(-200),
        pass:
          truncatedShown &&
          flatTruncated.includes(TRUNCATED_TOKEN) &&
          flatTruncated.includes("not complete") &&
          !flatTruncated.includes("reported this snapshot as complete"),
      },
      {
        name: "truncated-field-marked",
        expected: "a field the host cut is marked as truncated beside its row",
        observed: flatTruncated.includes("the host truncated this description") ? "marker shown" : "marker missing",
        pass: truncatedShown && flatTruncated.includes("the host truncated this description"),
      },
      {
        name: "cross-session-task-refused",
        expected: "a task held by another session is shown as foreign and its cancel is refused before any write",
        observed:
          "screen " +
          (flatRefusal.includes(TASK_REFUSAL_TOKEN) ? "refusal shown" : "refusal missing") +
          ", receipt task=" +
          String(receipt.task) +
          " sent=" +
          String(receipt.sent),
        pass:
          refusalShown &&
          flatRefusal.includes(TASK_REFUSAL_TOKEN) &&
          flatRefusal.includes("another session") &&
          receipt.task === "PARENT_SESSION_REQUIRED" &&
          receipt.sent === 0,
      },
      {
        name: "cross-session-approval-refused",
        expected: "an approval routed to another session is refused and no dialog answer is written",
        observed:
          "screen " +
          (flatRefusal.includes(APPROVAL_REFUSAL_TOKEN) ? "refusal shown" : "refusal missing") +
          ", receipt approval=" +
          String(receipt.approval) +
          " written=" +
          String(receipt.written),
        pass:
          refusalShown &&
          flatRefusal.includes(APPROVAL_REFUSAL_TOKEN) &&
          receipt.approval === "CROSS_SESSION_APPROVAL" &&
          receipt.written === 0,
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture and one screen per stage under the evidence directory",
        observed:
          String(Buffer.byteLength(evidence.text(), "utf8")) +
          " bytes, screens " +
          String(truncatedScreen.length) +
          "/" +
          String(refusalScreen.length),
        pass: Buffer.byteLength(evidence.text(), "utf8") > 0 && truncatedScreen.length > 0 && refusalScreen.length > 0,
      },
    ]
  } finally {
    for (const child of children) cleanupDetail.push(await stop(child, control))
    cleanupDetail.push(
      fs.existsSync(path.join(context.out, "home", ".opencode")) ? "driver wrote user state" : "no user state written",
    )
  }

  const cleanupOk = cleanupDetail.every((entry) => !entry.includes("did not exit") && !entry.includes("wrote user state"))
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
