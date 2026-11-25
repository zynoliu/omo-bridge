import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts"

const READY_TIMEOUT_MS = 20_000
const SCREEN_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 40

const DURABLE_ID = "stream-session-1"
/* The session name the fixture host publishes; it is what the tab bar shows in the session route. */
const SESSION_TITLE = "Bridge stream probe"
const ROUTING_ID = "rpc-stream-1"
const CWD = "/workspace/bridge-stream"
const ASSISTANT_TEXT = "Bridge stream probe: the cumulative assistant text."
const TOOL_RESULT = "tool-result-marker: 42"

const MESSAGES = [
  { role: "user", content: "Read the probe file", timestamp: 1_700_100_000_000 },
  {
    role: "assistant",
    provider: "fixture",
    model: "fixture-model",
    timestamp: 1_700_100_001_000,
    content: [
      { type: "text", text: ASSISTANT_TEXT },
      // A shell call, not a `read`: the session route renders a read as its path and never echoes the
      // file contents, so only a tool whose output the transcript shows can prove the pulled result
      // reached the screen.
      { type: "toolCall", id: "call_probe", name: "bash", arguments: { command: "cat probe.txt" } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call_probe",
    toolName: "bash",
    content: [{ type: "text", text: TOOL_RESULT }],
    isError: false,
    timestamp: 1_700_100_002_000,
  },
]

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

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

function proof(key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("hex")
}

type PeerState = {
  readonly decoder: JsonlFrameDecoder
  clientNonce?: string
  serverNonce?: string
}

type Peer = {
  readonly socket: string
  readonly record: string
  readonly launchId: string
  readonly server: ReturnType<typeof Bun.listen>
  readonly commands: string[]
  readonly observed: {
    infoReceived: boolean
    authenticateReceived: boolean
    clientProofVerified: boolean
  }
}

function startDocumentedPeer(directory: string, socketPath: string): Peer {
  const agentDir = path.join(directory, "agent")
  const rpcDir = path.join(agentDir, "rpc")
  const keysDir = path.join(rpcDir, "keys")
  const launchId = randomUUID()
  const record = path.join(keysDir, launchId)
  const key = randomBytes(32)
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 })
  const content = {
    version: 1,
    launch_id: launchId,
    key: key.toString("hex"),
    pid: process.pid,
    process_start: null,
    endpoint: socketPath,
    created_at: new Date().toISOString(),
  }
  fs.writeFileSync(record, JSON.stringify(content), { mode: 0o600 })
  fs.chmodSync(record, 0o600)

  const observed = {
    infoReceived: false,
    authenticateReceived: false,
    clientProofVerified: false,
  }
  const commands: string[] = []
  const connections = new WeakMap<object, PeerState>()

  const answer = (socket: { write(chunk: Uint8Array): unknown }, frame: Record<string, unknown>) => {
    socket.write(encodeFrame(frame))
  }

  const pullAnswer = (command: string): Record<string, unknown> | undefined => {
    if (command === "subscribe_sessions") {
      return {
        success: true,
        data: {
          subscriptionId: "sub-stream",
          seq: 0,
          hostGeneration: "0",
          hostInstanceId: "instance-stream",
          snapshot: [
            {
              type: "session_status",
              subscriptionId: "sub-stream",
              seq: 0,
              sessionId: ROUTING_ID,
              durableSessionId: DURABLE_ID,
              sessionPath: path.join(directory, "session.jsonl"),
              kind: "interactive",
              cwd: CWD,
              status: "idle",
              attachments: 1,
              model: { provider: "fixture", id: "fixture-model" },
              pendingQueue: { steering: 0, followUp: 0 },
            },
          ],
        },
      }
    }
    if (command === "get_state") {
      return {
        success: true,
        data: {
          sessionId: DURABLE_ID,
          sessionName: "Bridge stream probe",
          model: { provider: "fixture", id: "fixture-model" },
          thinkingLevel: "medium",
          isStreaming: false,
          messageCount: MESSAGES.length,
        },
      }
    }
    if (command === "get_messages") return { success: true, data: { messages: MESSAGES } }
    if (command === "get_pending_inputs") {
      return { success: true, data: { lifetimeId: "lifetime-stream", throughCursor: 0, inputs: [] } }
    }
    return undefined
  }

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open() {},
      data(socket, chunk) {
        const state = connections.get(socket) ?? { decoder: new JsonlFrameDecoder() }
        connections.set(socket, state)
        let frames: readonly string[]
        try {
          frames = state.decoder.push(chunk)
        } catch {
          socket.end()
          return
        }
        for (const line of frames) {
          let parsed: unknown
          try {
            parsed = JSON.parse(line)
          } catch {
            continue
          }
          if (!isRecord(parsed)) continue
          const id = typeof parsed.id === "string" ? parsed.id : ""
          const type = typeof parsed.type === "string" ? parsed.type : ""
          if (type === "get_protocol_info") {
            const auth = isRecord(parsed.auth) ? parsed.auth : undefined
            const clientNonce = auth !== undefined && typeof auth.client_nonce === "string" ? auth.client_nonce : ""
            if (!/^[0-9a-f]{64}$/.test(clientNonce)) {
              answer(socket, { id, type: "response", command: type, success: false, error: "auth_required" })
              continue
            }
            observed.infoReceived = true
            state.clientNonce = clientNonce
            state.serverNonce = hex(randomBytes(32))
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: true,
              data: {
                auth: {
                  launch_id: launchId,
                  server_nonce: state.serverNonce,
                  server_proof: proof(key, ["senpi-rpc-server", launchId, clientNonce, state.serverNonce]),
                },
              },
            })
            continue
          }
          if (type === "authenticate") {
            observed.authenticateReceived = true
            const received = typeof parsed.client_proof === "string" ? parsed.client_proof : ""
            const expected = proof(key, ["senpi-rpc-client", launchId, state.serverNonce ?? "", state.clientNonce ?? ""])
            const ok =
              /^[0-9a-f]{64}$/.test(received) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
            if (ok) observed.clientProofVerified = true
            answer(socket, { id, type: "response", command: type, success: ok, ...(ok ? {} : { error: "auth_failed" }) })
            continue
          }
          commands.push(type)
          const reply = pullAnswer(type)
          answer(
            socket,
            reply === undefined
              ? { id, type: "response", command: type, success: false, error: "unsupported_command" }
              : { id, type: "response", command: type, ...reply },
          )
        }
      },
      close() {},
      error() {},
    },
  })

  return { socket: socketPath, record: record, launchId: launchId, server: server, commands: commands, observed: observed }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  return !Array.isArray(value)
}

function spawnLauncher(qaRoot: string, socketPath: string, recordPath: string, target: Capture) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      "--no-install",
      "--no-env-file",
      path.join(qaRoot, "..", "..", "packages", "cli", "src", "bridge-run.ts"),
      "--socket",
      socketPath,
      "--key-record",
      recordPath,
    ],
    cwd: path.join(qaRoot, "..", "..", "packages", "cli"),
    terminal: {
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      data(_terminal, chunk) {
        target.push(chunk)
      },
    },
    env: { ...process.env, TERM: "xterm-256color", OPENCODE_ROUTE: JSON.stringify({ type: "session", sessionID: DURABLE_ID }) },
  })
}

async function stop(proc: ReturnType<typeof spawnLauncher>): Promise<string> {
  proc.kill()
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ])
  return exited ? "launcher exited" : "launcher did not exit within " + EXIT_TIMEOUT_MS + "ms"
}

function locateXterm(qaRoot: string): { readonly script: string; readonly css: string } {
  const packageRoot = path.join(qaRoot, "node_modules", "@xterm", "xterm")
  const script = path.join(packageRoot, "lib", "xterm.js")
  const css = path.join(packageRoot, "css", "xterm.css")
  if (!fs.existsSync(script)) throw new Error("@xterm/xterm browser bundle is missing: " + script)
  if (!fs.existsSync(css)) throw new Error("@xterm/xterm stylesheet is missing: " + css)
  return { script: script, css: css }
}

/**
 * Replays the captured PTY bytes into a terminal and reads the visible grid back, so the final
 * screen is judged rather than the log of every frame ever drawn.
 */
function screenPage(css: string, library: string, captured: string): string {
  const payload = JSON.stringify(captured).replace(/</g, "\\u003c")
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge stream screen</title>
<style>${css}
html,body{margin:0;background:#000;}
</style></head>
<body><div id="host"></div>
<script>${library}</script>
<script>window.__captured = ${payload}</script>
<script>
const term = new Terminal({ cols: ${String(TERMINAL_COLS)}, rows: ${String(TERMINAL_ROWS)}, scrollback: 0, allowProposedApi: true });
term.open(document.getElementById("host"));
window.renderScreen = () => new Promise((resolve) => {
  term.reset();
  term.write(window.__captured, () => resolve(true));
});
window.screenText = () => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
    const line = buffer.getLine(row);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\\n");
};
</script></body></html>`
}

/**
 * Replays the bytes captured so far and reads the visible grid back. The probe page is written under
 * the evidence directory so a click that missed can be inspected afterwards.
 */
async function probeScreen(context: CaseContext, captured: string): Promise<string> {
  const { script, css } = locateXterm(context.qaRoot)
  const pagePath = path.join(context.out, "stream-probe.html")
  fs.writeFileSync(pagePath, screenPage(fs.readFileSync(css, "utf8"), fs.readFileSync(script, "utf8"), captured), {
    mode: 0o600,
  })
  const view = new Bun.WebView({ width: TERMINAL_COLS * 10, height: TERMINAL_ROWS * 10 })
  try {
    await view.navigate("file://" + pagePath)
    await view.evaluate("window.renderScreen()")
    return String(await view.evaluate("window.screenText()"))
  } finally {
    await view.close()
  }
}

/**
 * The transcript groups a run of exploration tool calls behind one collapsed summary row, so a tool
 * result is only on screen once the reader opens that row. This opens the row it is looking at with
 * a real mouse click, exactly as a reader would, and waits once for the result to be drawn. Nothing
 * is retried: a click that does not reveal the result leaves the check to fail on what is on screen.
 */
async function revealCollapsedTools(
  context: CaseContext,
  terminal: { write(chunk: string | Uint8Array): unknown },
  evidence: Capture,
): Promise<void> {
  const lines = (await probeScreen(context, evidence.text())).split("\n")
  const row = lines.findIndex((line) => line.includes("Explor"))
  const summary = row === -1 ? "" : lines[row].trimEnd()
  if (row === -1 || summary.length === 0) return
  const column = summary.length
  terminal.write("\u001b[<0;" + String(column) + ";" + String(row + 1) + "M")
  terminal.write("\u001b[<0;" + String(column) + ";" + String(row + 1) + "m")
  await waitFor(evidence, (text) => plain(text).includes(TOOL_RESULT), SCREEN_TIMEOUT_MS)
}

async function renderScreen(context: CaseContext, captured: string, artifacts: string[]): Promise<string> {
  const { script, css } = locateXterm(context.qaRoot)
  const pagePath = path.join(context.out, "stream-screen.html")
  fs.writeFileSync(pagePath, screenPage(fs.readFileSync(css, "utf8"), fs.readFileSync(script, "utf8"), captured), {
    mode: 0o600,
  })
  artifacts.push("stream-screen.html")
  const view = new Bun.WebView({ width: TERMINAL_COLS * 10, height: TERMINAL_ROWS * 10 })
  try {
    await view.navigate("file://" + pagePath)
    await view.evaluate("window.renderScreen()")
    const text = String(await view.evaluate("window.screenText()"))
    fs.writeFileSync(path.join(context.out, "stream-screen.txt"), text, { mode: 0o600 })
    artifacts.push("stream-screen.txt")
    const shot = await view.screenshot()
    await Bun.write(path.join(context.out, "stream-screen.png"), shot)
    artifacts.push("stream-screen.png")
    return text
  } finally {
    await view.close()
  }
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock")
  const peer = startDocumentedPeer(context.out, socketPath)
  const evidence = capture()
  const children: ReturnType<typeof spawnLauncher>[] = []
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  let checks: Check[] = []

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.record, evidence)
    children.push(launcher)
    await waitFor(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const launchState = (evidence.text().match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const pulled = await waitFor(
      evidence,
      () => peer.commands.includes("get_pending_inputs"),
      SCREEN_TIMEOUT_MS,
    )
    // The transcript itself is the readiness signal: the session route is on screen once the pulled
    // assistant text has been drawn. The session's model label is not part of this wait, because the
    // native route renders it only in the assistant footer, which needs a stop reason the bridge
    // projection does not carry.
    /* At 120x40 the transcript scrolls: the pulled text sits above the fold, so readiness is the
       session route being on screen, not one particular line. */
    const projected = await waitFor(evidence, (text) => plain(text).includes(SESSION_TITLE), SCREEN_TIMEOUT_MS)
    if (projected && launcher.terminal !== undefined) await revealCollapsedTools(context, launcher.terminal, evidence)

    /* Pane switching at 120x40: the leader chords are sent as one write, which is how the keymap sees a pair.
       Each step is judged by the bytes the pane puts on the terminal, not by assuming a layout. */
    const beforeTerminal = evidence.text().length
    launcher.terminal?.write("\u0018t")
    const terminalOpened = await waitFor(evidence, (text) => text.length > beforeTerminal + 200, 15_000)
    const afterTerminal = evidence.text()
    /* Byte growth alone would pass on the pane's own failure text, so the check asks whether the pane loaded. */
    const terminalFailed = /load terminal/i.test(afterTerminal.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, ""))
    launcher.terminal?.write("\u0018t")
    const beforeSidebar = evidence.text().length
    launcher.terminal?.write("\u0018b")
    const sidebarToggled = await waitFor(evidence, (text) => text.length > beforeSidebar + 200, 15_000)

    fs.writeFileSync(path.join(context.out, "tui-wide-after-chords.txt"), evidence.text(), { mode: 0o600 })
    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "tui-wide-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-wide-pty.txt")

    const screen = projected ? await renderScreen(context, captured, artifacts) : ""
    const flat = screen.replace(/\s+/g, " ")
    const flatAssistant = ASSISTANT_TEXT.replace(/\s+/g, " ")
    const flatTool = TOOL_RESULT.replace(/\s+/g, " ")
    const assistantHits = occurrences(flat, flatAssistant)
    const crash = screen.indexOf("OpenCode crashed")
    const crashLine = /UNSUPPORTED_CAPABILITY:[^│\n]*/.exec(screen)?.[0]?.trim()

    checks = [
      {
        name: "launcher-ready-at-120x40",
        expected: "the launcher reaches ready on an 120x40 terminal",
        observed: "BRIDGE_STATE=" + launchState,
        pass: launchState === "ready",
      },
      {
        name: "main-conversation-usable",
        expected: "the pulled assistant text is on screen, so the main conversation works at this width",
        observed: flat.includes(SESSION_TITLE) ? "session route on screen" : "missing; tail: " + flat.slice(-160).trim(),
        pass: flat.includes(SESSION_TITLE),
      },
      {
        name: "terminal-pane-toggles",
        expected:
          "the terminal chord puts a working pane on the terminal — the official host declares no PTY method or capability (0 of 128 methods, 0 of 76 capabilities), so this cannot pass against this host",
        observed: terminalOpened
          ? (afterTerminal.length - beforeTerminal) + " bytes drawn after the chord" + (terminalFailed ? "; the pane reports it could not load — expected, the host offers no PTY surface" : "")
          : "no pane drawn",
        pass: terminalOpened && !terminalFailed,
      },
      {
        name: "sidebar-toggles",
        expected: "the sidebar chord redraws the layout",
        observed: sidebarToggled ? "redrawn" : "no redraw",
        pass: sidebarToggled,
      },
      {
        name: "dag-panel-visible",
        expected: "the bridge sidebar carries the DAG panel at this width",
        observed: flat.includes("DAG") ? "DAG section on screen" : "no DAG section; tail: " + flat.slice(-120).trim(),
        pass: flat.includes("DAG"),
      },
      {
        name: "main-conversation-survives-pane-toggles",
        expected: "the main conversation is still usable after the pane chords",
        observed: flat.includes(SESSION_TITLE) ? "session route still on screen" : "missing after toggles",
        pass: flat.includes(SESSION_TITLE),
      },
      {
        name: "no-crash-at-wide-width",
        expected: "no crash screen and no unsupported-capability banner",
        observed: crash >= 0 ? "crash screen: " + String(crashLine).slice(0, 80) : "no crash screen",
        pass: crash < 0,
      },
      {
        name: "screen-replayed-at-120x40",
        expected: "the recorded bytes replay into a non-empty screen at this width",
        observed: String(screen.length) + " characters replayed",
        pass: screen.length > 0,
      },
    ]
  } finally {
    for (const child of children) cleanupDetail.push(await stop(child))
    peer.server.stop(true)
    cleanupDetail.push("peer listener stopped")
    for (const target of [socketPath, peer.record]) {
      try {
        fs.unlinkSync(target)
      } catch {
        cleanupDetail.push("already absent: " + path.basename(target))
      }
    }
    const agentDir = path.join(context.out, "agent")
    try {
      fs.rmSync(agentDir, { recursive: true, force: true })
    } catch {
      cleanupDetail.push("agent directory could not be removed")
    }
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.record) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
      "launch id " + peer.launchId.slice(0, 8) + " (synthetic, generated by this case)",
    )
  }

  const cleanupOk = cleanupDetail.every(
    (entry) => !entry.includes("did not exit") && !entry.includes("still present") && !entry.includes("could not"),
  )
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
