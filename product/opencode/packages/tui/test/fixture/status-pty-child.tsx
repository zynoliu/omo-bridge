/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from "@opentui/core"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { BridgeData } from "../../../bridge-core/src/data.ts"
import { connectBridgeStatus, createStatusStore, Status } from "../../src/bridge/features/status/index.ts"
import type { StatusStore } from "../../src/bridge/features/status/index.ts"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import type { ThemeSource } from "../../src/context/theme"
import { createTuiResolvedConfig } from "./tui-runtime.ts"

const SESSION = process.env.STATUS_PTY_SESSION ?? "status-pty-session"
const themeSource: ThemeSource = { discover: () => Promise.resolve({}) }

function memoryFrame() {
  return {
    type: "extension_event",
    name: "omo.memory.updated",
    sessionId: SESSION,
    data: {
      schemaVersion: 1,
      identity: "qa-bridge-agent",
      repo: {
        headSha: "1a2b3c4",
        headSubject: "journal: status pty",
        committedAtISO: "2026-11-17T07:00:00.000Z",
        dirty: false,
        dirtyPaths: 0,
        systemTokensEstimate: 900,
      },
      reflection: { backlogSteps: 0, pendingCompaction: false, consecutiveFailures: 0 },
      journal: { sessionId: SESSION, totalSteps: 5, reflectedSteps: 5 },
    },
  }
}

function teamFrame() {
  return {
    type: "custom_message",
    customType: "senpi-task.team-member-liveness",
    display: false,
    sessionId: SESSION,
    content: "Team member liveness: qa-scout exited abnormally; last known state: error.",
    details: {
      memberName: "qa-scout",
      lastKnownState: "error",
      reason: "qa transport closed",
      deliveryKey: "team-member-liveness:qa-1:1",
    },
  }
}

function emptyWidgetFrame() {
  return {
    type: "extension_ui_request",
    method: "setWidget",
    widgetKey: "qa-empty-widget",
    widgetLines: [],
    widgetPlacement: "belowEditor",
  }
}

function App(props: { readonly store: StatusStore; readonly data: BridgeData }) {
  const renderer = useRenderer()
  useKeyboard((key) => {
    if (key.name === "m") props.data.publishEvent(memoryFrame())
    if (key.name === "t") props.data.publishEvent(teamFrame())
    if (key.name === "w") props.data.publishEvent(emptyWidgetFrame())
    if (key.name === "q") renderer.destroy()
  })
  return (
    <box flexDirection="column">
      <text>STATUS_PTY_READY</text>
      <Status store={props.store} />
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

const data = new BridgeData()
const store = createStatusStore({ sessionID: SESSION })
connectBridgeStatus(store, data)

process.on("SIGTERM", () => {
  if (!renderer.isDestroyed) renderer.destroy()
})

await render(
  () => (
    <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
      <ThemeProvider mode="dark" source={themeSource}>
        <App store={store} data={data} />
      </ThemeProvider>
    </ConfigProvider>
  ),
  renderer,
)

await renderer.closed.catch(() => {})
process.exit(0)
