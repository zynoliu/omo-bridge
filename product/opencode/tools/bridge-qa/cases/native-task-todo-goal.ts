import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { screenText } from "../lib/terminal-screen.ts"

const READY_TIMEOUT_MS = 25_000
const REGION_TIMEOUT_MS = 25_000
const EXIT_TIMEOUT_MS = 5_000
const COLS = 110
const ROWS = 40

const SECTION_TITLES = ["Tasks and subagents", "Todo (current branch)", "Goal", "Approvals"]
const TASK_TOKEN = "task-alpha"
const TODO_TOKEN = "todo-branch-row"
const ABANDONED_TOKEN = "abandoned-todo-row"
const GOAL_TOKEN = "goal-objective-ship"

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

/**
 * The driver mounts the real production component in a real PTY through the same renderer the TUI
 * uses, and applies one store event per control line, so each region's update is observed on its own
 * instead of all four arriving before the first frame.
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
const RECEIPT = OUT + "/driver/receipt.txt"
const SESSION = "qa-thread-1"
const store = createTasksStore({ sessionID: SESSION })

const stages = {
  quit() {},
  task() {
    store.applyTaskSnapshot({
      parentSessionId: SESSION,
      tasks: [
        {
          id: ${JSON.stringify(TASK_TOKEN)},
          parentSessionId: SESSION,
          status: "running",
          description: "Project the task surface",
          descriptionTruncated: false,
          error: null,
          errorTruncated: false,
        },
      ],
      omitted: 0,
    })
  },
  todo() {
    store.applyBranchSnapshot({
      leafId: "entry-leaf",
      entries: [
        {
          id: "entry-root",
          parentId: null,
          customType: "senpi.todo-state",
          data: [{ content: ${JSON.stringify(TODO_TOKEN)}, status: "in_progress" }],
        },
        { id: "entry-root-child", parentId: "entry-root", customType: null, data: null },
        {
          id: "entry-abandoned",
          parentId: "entry-root-child",
          customType: "senpi.todo-state",
          data: [{ content: ${JSON.stringify(ABANDONED_TOKEN)}, status: "pending" }],
        },
        { id: "entry-leaf", parentId: "entry-root-child", customType: null, data: null },
      ],
    })
  },
  goal() {
    store.applyGoal({
      source: "goal-plugin",
      state: {
        id: "goal-qa",
        objective: ${JSON.stringify(GOAL_TOKEN)},
        status: "active",
        rounds: 2,
        maxRounds: 8,
        boot: "boot-qa",
        updatedAt: 1700400000000,
      },
    })
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
    appendFileSync(RECEIPT, stage + "\\n")
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

    const initial = await waitFor(
      evidence,
      (text) => SECTION_TITLES.every((title) => plain(text).includes(title)),
      READY_TIMEOUT_MS,
    )
    const initialScreen = initial ? await snapshotScreen(context, evidence, "screen-initial") : ""

    control("task")
    const taskShown = await waitFor(evidence, (text) => plain(text).includes(TASK_TOKEN), REGION_TIMEOUT_MS)
    const taskScreen = taskShown ? await snapshotScreen(context, evidence, "screen-task") : ""

    control("todo")
    const todoShown = await waitFor(evidence, (text) => plain(text).includes(TODO_TOKEN), REGION_TIMEOUT_MS)
    const todoScreen = todoShown ? await snapshotScreen(context, evidence, "screen-todo") : ""

    control("goal")
    const goalShown = await waitFor(evidence, (text) => plain(text).includes(GOAL_TOKEN), REGION_TIMEOUT_MS)
    const goalScreen = goalShown ? await snapshotScreen(context, evidence, "screen-goal") : ""

    fs.writeFileSync(path.join(context.out, "native-task-todo-goal-pty.txt"), evidence.text(), { mode: 0o600 })
    artifacts.push(
      "screen-initial.txt",
      "screen-task.txt",
      "screen-todo.txt",
      "screen-goal.txt",
      "native-task-todo-goal-pty.txt",
    )

    const flatInitial = squash(initialScreen)
    const flatTask = squash(taskScreen)
    const flatTodo = squash(todoScreen)
    const flatGoal = squash(goalScreen)

    checks = [
      {
        name: "four-regions-mounted",
        expected: "the initial screen shows all four section titles",
        observed: initial
          ? SECTION_TITLES.filter((title) => flatInitial.includes(squash(title))).join(", ") || "none"
          : "no initial screen; tail: " + squash(plain(evidence.text())).slice(-200),
        pass: initial && SECTION_TITLES.every((title) => flatInitial.includes(squash(title))),
      },
      {
        name: "task-event-updates-task-region",
        expected: "after the task event the task row is on screen and the todo and goal regions stay unreported",
        observed: taskShown
          ? "task " +
            (flatTask.includes(TASK_TOKEN) ? "shown" : "missing") +
            ", todo " +
            (flatTask.includes(TODO_TOKEN) ? "shown" : "absent") +
            ", goal " +
            (flatTask.includes(GOAL_TOKEN) ? "shown" : "absent")
          : "no task screen; tail: " + squash(plain(evidence.text())).slice(-200),
        pass: taskShown && flatTask.includes(TASK_TOKEN) && !flatTask.includes(TODO_TOKEN) && !flatTask.includes(GOAL_TOKEN),
      },
      {
        name: "todo-event-updates-todo-region-only",
        expected: "the current branch's todo row appears, the abandoned branch's row does not, and the task row stays",
        observed: todoShown
          ? "todo " +
            (flatTodo.includes(TODO_TOKEN) ? "shown" : "missing") +
            ", abandoned " +
            (flatTodo.includes(ABANDONED_TOKEN) ? "shown" : "absent") +
            ", task " +
            (flatTodo.includes(TASK_TOKEN) ? "kept" : "lost") +
            ", goal " +
            (flatTodo.includes(GOAL_TOKEN) ? "shown" : "absent")
          : "no todo screen; tail: " + squash(plain(evidence.text())).slice(-200),
        pass:
          todoShown &&
          flatTodo.includes(TODO_TOKEN) &&
          !flatTodo.includes(ABANDONED_TOKEN) &&
          flatTodo.includes(TASK_TOKEN) &&
          !flatTodo.includes(GOAL_TOKEN),
      },
      {
        name: "goal-event-updates-goal-region-only",
        expected: "the goal plugin's objective and round count appear while the task and todo rows stay",
        observed: goalShown
          ? "goal " +
            (flatGoal.includes(GOAL_TOKEN) ? "shown" : "missing") +
            ", rounds " +
            (flatGoal.includes("round 2 of 8") ? "shown" : "missing") +
            ", task " +
            (flatGoal.includes(TASK_TOKEN) ? "kept" : "lost") +
            ", todo " +
            (flatGoal.includes(TODO_TOKEN) ? "kept" : "lost")
          : "no goal screen; tail: " + squash(plain(evidence.text())).slice(-200),
        pass:
          goalShown &&
          flatGoal.includes(GOAL_TOKEN) &&
          flatGoal.includes("round 2 of 8") &&
          flatGoal.includes(TASK_TOKEN) &&
          flatGoal.includes(TODO_TOKEN),
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture and one screen per stage under the evidence directory",
        observed: String(Buffer.byteLength(evidence.text(), "utf8")) + " bytes, final screen " + String(goalScreen.length) + " chars",
        pass: Buffer.byteLength(evidence.text(), "utf8") > 0 && goalScreen.length > 0,
      },
    ]
  } finally {
    for (const child of children) cleanupDetail.push(await stop(child, control))
    const receipt = path.join(driverDirectory, "receipt.txt")
    cleanupDetail.push(fs.existsSync(receipt) ? "driver receipt present" : "driver receipt missing")
    cleanupDetail.push(fs.existsSync(path.join(context.out, "home", ".opencode")) ? "driver wrote user state" : "no user state written")
  }

  const cleanupOk = cleanupDetail.every(
    (entry) => !entry.includes("did not exit") && !entry.includes("missing") && !entry.includes("wrote user state"),
  )
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
