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
const ROUTING_ID = "rpc-stream-1"
const CWD = "/workspace/bridge-stream"
const ASSISTANT_TEXT = "Bridge stream probe: the cumulative assistant text."
const TOOL_RESULT = "tool-result-marker: 42"

/** The levels the stand-in host reports for the fixture model. */
const THINKING_LEVELS = ["off", "low", "medium", "high"]

/**
 * The pull the launcher performs, in the order it performs it: one `subscribe_sessions`, then per
 * session `get_state`, the two thinking reads the state answer leads to (`get_available_thinking_levels`
 * for the active model, `get_model_thinking_level` for an explicit provider and model id),
 * `get_messages`, `get_pending_inputs`, the host's own token accounting (`get_session_stats`) and the
 * session tree (`get_entries`), then the model catalogue.
 *
 * Asserted as an exact prefix, so a command that is dropped or moved fails the case rather than being
 * tolerated for merely being present.
 */
const DOCUMENTED_PULL = [
  "subscribe_sessions",
  "get_state",
  "get_available_thinking_levels",
  "get_model_thinking_level",
  "get_messages",
  "get_pending_inputs",
  "get_session_stats",
  "get_entries",
  "get_available_models",
]

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

/** Resolves once the renderer writes more bytes, which is what a repaint looks like on the PTY. */
function nextPaint(target: Capture, timeoutMs: number): Promise<boolean> {
  const before = target.text().length
  return waitFor(target, (text) => text.length > before, timeoutMs)
}

/**
 * Reads the rendered grid again after each new paint until the predicate holds. The wait is on the
 * renderer writing bytes, not on a clock: a paint that has not happened cannot satisfy a check about
 * the screen, and once it has, the next read sees it.
 */
async function waitForScreen(
  target: Capture,
  probe: (captured: string) => Promise<string>,
  predicate: (screen: string) => boolean,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly screen: string; readonly reads: number }> {
  const deadline = Date.now() + timeoutMs
  let reads = 0
  let screen = ""
  while (Date.now() < deadline) {
    screen = await probe(target.text())
    reads += 1
    if (predicate(screen)) return { ok: true, screen: screen, reads: reads }
    const painted = await nextPaint(target, Math.max(1, deadline - Date.now()))
    if (!painted) break
  }
  return { ok: predicate(screen), screen: screen, reads: reads }
}

function plain(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b[PX^_][^\u001b]*\u001b\\/g, "")
}

/** Grid text with its layout whitespace squashed, so a phrase the renderer wrapped still reads once. */
function squashed(text: string): string {
  return text.replace(/\s+/g, " ")
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
    /*
     * The four reads the session view adds on top of the transcript: the level list the composer's
     * variant picker needs, the per-model level `get_state` alone cannot settle, the host's token
     * accounting, and the session tree the todo surface walks. A documented command answered
     * `unsupported_command` is a fixture gap, not a product signal, so they answer as the host does.
     * `get_available_models` is deliberately left refused: the catalogue is documented as optional
     * enrichment, and leaving it refused keeps the case proving that an error answer does not take
     * the route down.
     */
    if (command === "get_available_thinking_levels") {
      return { success: true, data: { levels: THINKING_LEVELS } }
    }
    if (command === "get_model_thinking_level") {
      return {
        success: true,
        data: { level: "medium", availableLevels: THINKING_LEVELS, source: "default" },
      }
    }
    if (command === "get_session_stats") {
      return {
        success: true,
        data: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
      }
    }
    if (command === "get_entries") return { success: true, data: { entries: [], leafId: null } }
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

function spawnLauncher(qaRoot: string, socketPath: string, recordPath: string, fixtureHome: string, target: Capture) {
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
    /*
     * The TUI writes tabs, prompt history and its own state under HOME; pointing every state root at
     * the case's evidence directory keeps a QA run out of the person's real state. Animations are off
     * because a replay of the byte log that ends inside a spinner frame draws a grid the checks cannot
     * read. The vertical tab layout is the one whose rail draws each tab's detail row, and that row is
     * the render path a bridge surface reached with `project.get`; without it the strip is drawn
     * without ever reading the surface, so a throw there would go unnoticed.
     */
    env: {
      ...process.env,
      HOME: fixtureHome,
      XDG_DATA_HOME: path.join(fixtureHome, "data"),
      XDG_CACHE_HOME: path.join(fixtureHome, "cache"),
      XDG_CONFIG_HOME: path.join(fixtureHome, "config"),
      XDG_STATE_HOME: path.join(fixtureHome, "state"),
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ animations: false, tabs: { layout: "vertical" } }),
      TERM: "xterm-256color",
      OPENCODE_ROUTE: JSON.stringify({ type: "session", sessionID: DURABLE_ID }),
    },
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

type ScreenAssets = { readonly css: string; readonly library: string }

/**
 * Replays the bytes captured so far and reads the visible grid back. The probe page is written under
 * the evidence directory so a click that missed can be inspected afterwards.
 */
async function probeScreen(context: CaseContext, assets: ScreenAssets, captured: string): Promise<string> {
  const pagePath = path.join(context.out, "stream-probe.html")
  fs.writeFileSync(pagePath, screenPage(assets.css, assets.library, captured), { mode: 0o600 })
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
 * a real mouse click, exactly as a reader would, and waits once for the grid to show the result.
 * Nothing is retried: a click that does not reveal the result leaves the check to fail on what is on
 * screen. A transcript that already drew the result needs no click.
 */
async function revealToolResult(
  terminal: { write(chunk: string | Uint8Array): unknown },
  probe: (captured: string) => Promise<string>,
  evidence: Capture,
): Promise<boolean> {
  const first = await probe(evidence.text())
  if (squashed(first).includes(squashed(TOOL_RESULT))) return true
  const lines = first.split("\n")
  const row = lines.findIndex((line) => line.includes("Explor"))
  const summary = row === -1 ? "" : lines[row].trimEnd()
  if (row === -1 || summary.length === 0) return false
  const column = summary.length
  terminal.write("\u001b[<0;" + String(column) + ";" + String(row + 1) + "M")
  terminal.write("\u001b[<0;" + String(column) + ";" + String(row + 1) + "m")
  const revealed = await waitForScreen(
    evidence,
    probe,
    (grid) => squashed(grid).includes(squashed(TOOL_RESULT)),
    SCREEN_TIMEOUT_MS,
  )
  return revealed.ok
}

async function renderScreen(context: CaseContext, captured: string, assets: ScreenAssets, artifacts: string[]): Promise<string> {
  const pagePath = path.join(context.out, "stream-screen.html")
  fs.writeFileSync(pagePath, screenPage(assets.css, assets.library, captured), { mode: 0o600 })
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
  const fixtureHome = path.join(context.out, "fixture")
  const { script, css } = locateXterm(context.qaRoot)
  const assets = { css: fs.readFileSync(css, "utf8"), library: fs.readFileSync(script, "utf8") }
  const probe = (captured: string) => probeScreen(context, assets, captured)
  let checks: Check[] = []

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.record, fixtureHome, evidence)
    children.push(launcher)
    await waitFor(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const launchState = (plain(evidence.text()).match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const pulled = await waitFor(
      evidence,
      () => DOCUMENTED_PULL.every((command) => peer.commands.includes(command)),
      SCREEN_TIMEOUT_MS,
    )
    /*
     * The transcript itself is the readiness signal, read off the rendered grid: the session route is
     * on screen once the pulled assistant text has been drawn. The raw byte log cannot answer this --
     * the renderer positions each wrapped line, so the phrase is never contiguous in the stream.
     */
    const mounted = await waitForScreen(
      evidence,
      probe,
      (grid) => squashed(grid).includes(squashed(ASSISTANT_TEXT)),
      SCREEN_TIMEOUT_MS,
    )
    if (mounted.ok && launcher.terminal !== undefined) await revealToolResult(launcher.terminal, probe, evidence)

    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "tui-stream-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-stream-pty.txt")

    /* The final grid is read whatever the mount wait saw: a route that crashed still has a screen, and
       that screen is the evidence the crash checks are made against. */
    const screen = await renderScreen(context, captured, assets, artifacts)
    if (!mounted.ok) {
      fs.writeFileSync(path.join(context.out, "mount-screen.txt"), mounted.screen, { mode: 0o600 })
      artifacts.push("mount-screen.txt")
    }
    const flat = squashed(screen)
    const flatAssistant = squashed(ASSISTANT_TEXT)
    const flatTool = squashed(TOOL_RESULT)
    const assistantHits = occurrences(flat, flatAssistant)
    const crash = screen.indexOf("OpenCode crashed")
    const crashLine = /UNSUPPORTED_CAPABILITY:[^│\n]*/.exec(screen)?.[0]?.trim()

    checks = [
      {
        name: "host-proof-exchange",
        expected: "the peer answers get_protocol_info with data.auth and the client returns a valid client_proof",
        observed:
          "info=" +
          String(peer.observed.infoReceived) +
          " authenticate=" +
          String(peer.observed.authenticateReceived) +
          " clientProof=" +
          String(peer.observed.clientProofVerified),
        pass: peer.observed.infoReceived && peer.observed.authenticateReceived && peer.observed.clientProofVerified,
      },
      {
        name: "launcher-reports-ready",
        expected: "BRIDGE_STATE=ready after the handshake and the pull",
        observed: "BRIDGE_STATE=" + launchState,
        pass: launchState === "ready",
      },
      {
        name: "documented-pull-order",
        expected: "the documented pull, in order: " + DOCUMENTED_PULL.join(", "),
        observed: peer.commands.join(", ") || "no commands",
        pass:
          pulled &&
          peer.commands.length >= DOCUMENTED_PULL.length &&
          DOCUMENTED_PULL.every((command, index) => peer.commands[index] === command),
      },
      {
        name: "session-route-mounted",
        expected: "the TUI session route renders the pulled session instead of crashing",
        observed:
          crash >= 0
            ? (crashLine ?? "OpenCode crashed without a capability name")
            : mounted.ok
              ? "route rendered"
              : "the pulled transcript never reached the grid; tail: " + squashed(mounted.screen).slice(-200).trim(),
        pass: mounted.ok && crash < 0,
      },
      {
        name: "assistant-text-once",
        expected: "the pulled assistant text appears exactly once on the final screen",
        observed:
          assistantHits > 0
            ? String(assistantHits) + " occurrence(s)"
            : crashLine !== undefined
              ? "crash: " + crashLine
              : crash >= 0
                ? "crash screen: " + screen.slice(crash, crash + 220).replace(/\s+/g, " ").trim()
              : "not on screen; tail: " + (mounted.ok ? flat : squashed(mounted.screen)).slice(-220).trim(),
        pass: assistantHits === 1,
      },
      {
        name: "tool-result-retained",
        expected: "the tool result pulled with the transcript is still on the final screen",
        observed: flat.includes(flatTool) ? "tool result visible" : "tool result missing",
        pass: flat.includes(flatTool),
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture under the evidence directory",
        observed: String(Buffer.byteLength(captured, "utf8")) + " bytes",
        pass: Buffer.byteLength(captured, "utf8") > 0,
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
    try {
      fs.rmSync(fixtureHome, { recursive: true, force: true })
    } catch {
      cleanupDetail.push("fixture home could not be removed")
    }
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.record) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
      fs.existsSync(fixtureHome) ? "fixture home still present" : "fixture home removed",
      "launch id " + peer.launchId.slice(0, 8) + " (synthetic, generated by this case)",
    )
  }

  const cleanupOk = cleanupDetail.every(
    (entry) => !entry.includes("did not exit") && !entry.includes("still present") && !entry.includes("could not"),
  )
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
