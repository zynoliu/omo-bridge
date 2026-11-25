/** @jsxImportSource @opentui/solid */
import { writeFileSync } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { BridgeData } from "../../../bridge-core/src/data.ts"
import { createExtensionRequester } from "../../../bridge-core/src/extension-request.ts"
import { DagPanel, connectBridgeDag, createDagLedger, createPanelState } from "../../src/bridge/features/dag/index.ts"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import type { ThemeSource } from "../../src/context/theme"
import { createTuiResolvedConfig } from "./tui-runtime.ts"

const RUN = "run-qa-1"
const themeSource: ThemeSource = { discover: () => Promise.resolve({}) }

const data = new BridgeData()
const ledger = createDagLedger()
const panel = createPanelState("dag")

/* The controlled host: it answers the history pull the overflow path issues, exactly as the protocol
 * says — bounded by throughSeq and returning the missing rows once. */
let acceptAnswer: ((id: string, answer: unknown) => string) | undefined = undefined
const requester = createExtensionRequester({
  write: (frame) => {
    if (typeof frame !== "object" || frame === null) return
    const id = (frame as Record<string, unknown>)["id"]
    const name = (frame as Record<string, unknown>)["name"]
    if (typeof id !== "string") return
    if (name === "omo.dag.list") {
      acceptAnswer?.(id, { id: id, success: true, data: { runs: [{ runId: RUN, status: "running" }], limit: 50 } })
      return
    }
    if (name !== "omo.dag.history") return
    const payload = (frame as Record<string, unknown>)["data"]
    const through =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>)["throughSeq"] : undefined
    if (typeof through !== "number") return
    const events: unknown[] = []
    for (let seq = 2; seq <= through; seq += 1) events.push({ runId: RUN, seq: seq })
    setTimeout(() => {
      acceptAnswer?.(id, { id: id, success: true, data: { events: events, highWaterSeq: through } })
    }, 5)
  },
})
acceptAnswer = (id, answer) => requester.accept(id, answer)
data.setExtensionRequester(requester)
connectBridgeDag(ledger, data, { onError: (message) => process.stderr.write("dag-qa: " + message + "\n") })

function emitEvent(seq: number) {
  data.publishEvent({ type: "extension_event", name: "omo.dag.event", data: { runId: RUN, seq: seq, kind: "node" } })
}

function App() {
  const renderer = useRenderer()
  let next = 1
  useKeyboard((key) => {
    if (key.name === "e") {
      emitEvent(next)
      next += 1
    }
    if (key.name === "o") {
      data.publishEvent({ type: "extension_event", name: "omo.dag.updated", data: { runs: [{ runId: RUN, status: "running" }] } })
      data.publishEvent({ type: "extension_event", name: "omo.dag.event", data: { runId: RUN, seq: next } })
      next += 1
      data.publishEvent({
        type: "extension_event",
        name: "dag.stream.overflow",
        data: { runId: RUN, seq: next + 2, recoverAfterSeq: next - 1, droppedCount: 3 },
      })
      next += 3
    }
    if (key.name === "q") renderer.destroy()
  })
  return (
    <box flexDirection="column">
      <text>DAG_PTY_READY panel={panel.current()}</text>
      <DagPanel ledger={ledger} available={90} />
    </box>
  )
}

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

process.on("SIGTERM", () => {
  if (!renderer.isDestroyed) renderer.destroy()
})

await render(
  () => (
    <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
      <ThemeProvider mode="dark" source={themeSource}>
        <App />
      </ThemeProvider>
    </ConfigProvider>
  ),
  renderer,
)

/* The case drives this child through deterministic advancement markers, not through keys: each
 * published event reports the head it produced, so the case waits on a state change it can see. */
/* The head is reported through a control file, never through stdout: writing into the renderer's
 * stream would corrupt the very screen the case is judging. */
const headFile = process.env.DAG_HEAD_FILE
const report = () => {
  if (headFile === undefined) return
  const gap = ledger.gap(RUN)
  writeFileSync(headFile, "head=" + String(ledger.head(RUN)) + " gap=" + (gap === undefined ? "none" : String(gap.after) + ".." + String(gap.through)))
}
if (process.env.DAG_OVERFLOW === "1") {
  /* Two applied events, then the queue overflows: history is the only way to close 3..5. */
  setTimeout(() => {
    emitEvent(1)
    emitEvent(2)
    report()
    data.publishEvent({ type: "extension_event", name: "dag.stream.overflow", data: { runId: RUN, seq: 5, recoverAfterSeq: 2, droppedCount: 2 } })
    report()
    /* keep reporting so the case sees the state after the history answer lands */
    let ticks = 0
    const timer = setInterval(() => {
      report()
      ticks += 1
      if (ticks >= 15) clearInterval(timer)
    }, 200)
  }, 300)
} else {
  for (const seq of [1, 2, 3]) {
    setTimeout(() => {
      emitEvent(seq)
      report()
    }, 300 * seq)
  }
}

await renderer.closed.catch(() => {})
process.exit(0)
