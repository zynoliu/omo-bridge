/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from "@opentui/core"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { BridgeData } from "../../../bridge-core/src/data.ts"
import { Other, connectBridgeOther, createOtherStore } from "../../src/bridge/features/other/index.ts"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import type { ThemeSource } from "../../src/context/theme"
import { createTuiResolvedConfig } from "./tui-runtime.ts"

const themeSource: ThemeSource = { discover: () => Promise.resolve({}) }
const data = new BridgeData()
const store = createOtherStore()
connectBridgeOther(store, data)

const mode = process.env.OTHER_PTY_MODE ?? "known"
if (mode === "known") {
  setTimeout(() => {
    data.publishEvent({
      type: "extension_event",
      name: "wake_source_state",
      data: { source: "senpi-codemode", activeCount: 1, items: [{ id: "cell_1", description: "Read the input files", startedAtMs: 1720000000000 }] },
    })
    data.publishEvent({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "boulder", statusText: "boulder: 3/8" })
  }, 300)
} else {
  setTimeout(() => {
    data.publishEvent({ type: "extension_event", name: "wake_source_state", data: { activeCount: 2 } })
    data.publishEvent({ type: "extension_event", name: "unknown_surface", data: { whatever: true } })
  }, 300)
}

function App() {
  const renderer = useRenderer()
  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy()
  })
  return (
    <box flexDirection="column">
      <text>OTHER_PTY_READY</text>
      <Other store={store} />
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

await renderer.closed.catch(() => {})
process.exit(0)
