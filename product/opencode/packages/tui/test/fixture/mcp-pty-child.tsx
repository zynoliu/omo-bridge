/** @jsxImportSource @opentui/solid */
import { createCliRenderer } from "@opentui/core"
import { createSignal } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { createExtensionRequester } from "../../../bridge-core/src/extension-request.ts"
import { BridgeData } from "../../../bridge-core/src/data.ts"
import { connectBridgeMcp } from "../../src/bridge/mcp-client.ts"
import { ConfigProvider } from "../../src/config"
import { ThemeProvider } from "../../src/context/theme"
import type { ThemeSource } from "../../src/context/theme"
import { createTuiResolvedConfig } from "./tui-runtime.ts"

const themeSource: ThemeSource = { discover: () => Promise.resolve({}) }
const COMMAND = "echo bridge-mcp-ok"

const data = new BridgeData()
const written: unknown[] = []
const requester = createExtensionRequester({ write: (frame) => written.push(frame) })
data.setExtensionRequester(requester)

type Screen =
  | { readonly kind: "idle" }
  | { readonly kind: "awaiting"; readonly requestId: string; readonly content: string }
  | { readonly kind: "ran"; readonly output: string }
  | { readonly kind: "refused" }

const [screen, setScreen] = createSignal<Screen>({ kind: "idle" })
const [runs, setRuns] = createSignal(0)
let runCount = 0
let pending: { readonly requestId: string; readonly content: string } | undefined = undefined

const client = connectBridgeMcp(data, {
  execute: async (request) => {
    if (request.tool !== "terminal.write") return { error: "unknown tool" }
    const raw = request.input
    const content = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["content"] : undefined
    if (typeof content !== "string") return { error: "no content" }
    pending = { requestId: request.requestId, content: content }
    setScreen({ kind: "awaiting", requestId: request.requestId, content: content })
    return { result: { awaiting: true } }
  },
  onError: () => undefined,
})

/* One read per render: the union has to be narrowed on the value that was actually read. */
const approvalLine = () => {
  const current = screen()
  return current.kind === "awaiting" ? "approval: " + current.content : "approval: none"
}
const outputLine = () => {
  const current = screen()
  return current.kind === "ran" ? "command output: " + current.output : "command output: none"
}

function App() {
  const renderer = useRenderer()
  useKeyboard(async (key) => {
    if (key.name === "q") return renderer.destroy()
    const p = pending
    if (p === undefined) return
    if (key.name === "d") {
      pending = undefined
      setScreen({ kind: "refused" })
      return
    }
    if (key.name === "return" || key.name === "enter") {
      if (screen().kind !== "awaiting") return
      pending = undefined
      runCount += 1
      setRuns(runCount)
      const proc = Bun.spawn({ cmd: ["bash", "-c", p.content], stdout: "pipe" })
      const text = await new Response(proc.stdout).text()
      await proc.exited
      setScreen({ kind: "ran", output: text.trim() })
    }
  })
  return (
    <box flexDirection="column">
      <text>MCP_PTY_READY</text>
      <text>{approvalLine()}</text>
      <text>{outputLine()}</text>
      <text>{"runs=" + String(runs())}</text>
      <text>{screen().kind === "refused" ? "MCP_REFUSED" : ""}</text>
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

/* The controlled extension asks for one terminal write as soon as the screen is up. */
setTimeout(() => {
  data.publishEvent({
    type: "extension_event",
    name: "tui.pack.mcp.request",
    data: { requestId: "mcp-qa-1", sessionId: "mcp-pty", server: "bridge-tools", tool: "terminal.write", input: { content: COMMAND } },
  })
}, 300)

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
client.stop()
process.exit(0)
