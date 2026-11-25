import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts"

/**
 * The terminal state of a turn, read off the rendered screen.
 *
 * The stand-in host announces the session as running, then settles it with a live `session_status`
 * record: the composer's running indicator (`esc interrupt`) has to clear. Afterwards the host runs a
 * second turn that it ends with `turn_end` whose assistant message carries `stopReason: "aborted"`.
 * That record is the only place the turn's outcome travels, so the transcript has to say the turn was
 * interrupted instead of leaving the reader with a reply that looks like a normal one.
 *
 * Screens are read by replaying the PTY bytes into xterm and reading the visible grid back: the case
 * waits on a new paint rather than on the raw frame log, and the final grid is written out as the
 * artifact the checks were made against.
 */

const READY_TIMEOUT_MS = 20_000
const SCREEN_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 40

const DURABLE_ID = "terminal-session-1"
const ROUTING_ID = "rpc-terminal-1"
const CWD = "/workspace/bridge-terminal"
const SESSION_NAME = "Terminal state probe"
const PRIOR_TEXT = "Terminal state probe: the settled turn is on screen."
const ABORTED_TEXT = "Terminal state probe: this reply belongs to the aborted turn."

/** The composer's running indicator, as the footer draws it (`esc` + `interrupt`). */
const RUNNING_MARK = "escinterrupt"
/** The assistant footer's suffix for a turn the client knows ended interrupted. */
const INTERRUPTED_MARK = "interrupted"
/** The idle footer's fallback: the working directory of the session. */
const IDLE_MARK = "bridge-terminal"

const PRIOR_MESSAGES = [
  { role: "user", content: "Show the terminal state of a turn", timestamp: 1_700_200_000_000 },
  {
    role: "assistant",
    provider: "fixture",
    model: "fixture-model",
    timestamp: 1_700_200_001_000,
    content: [{ type: "text", text: PRIOR_TEXT }],
    stopReason: "stop",
  },
]

const ABORTED_MESSAGES = [
  ...PRIOR_MESSAGES,
  { role: "user", content: "Stop this turn", timestamp: 1_700_200_002_000 },
  {
    role: "assistant",
    provider: "fixture",
    model: "fixture-model",
    timestamp: 1_700_200_003_000,
    content: [{ type: "text", text: ABORTED_TEXT }],
    stopReason: "aborted",
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
function waitForCapture(target: Capture, predicate: (text: string) => boolean, timeoutMs: number): Promise<boolean> {
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
  return waitForCapture(target, (text) => text.length > before, timeoutMs)
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

/** Frame, scrollbar and logo glyphs land in the middle of a wrapped line, so they are chrome. */
function flatScreen(text: string): string {
  return squash(plain(text)).replace(/[\u2500-\u259F]/g, "")
}

/**
 * The composer footer row: the one the prompt's shortcut hints are drawn on. The running indicator and
 * the idle location label share it, so a check about the footer reads this line rather than the whole
 * grid, where the same words also appear in the tab strip and the sidebar.
 */
function footerRow(screen: string): string {
  return squash(screen.split("\n").find((line) => line.includes("shift+tab")) ?? "")
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

function proof(key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("hex")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  return !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === "string" ? value : undefined
}

type ClientSocket = { write(chunk: Uint8Array): unknown }

type PeerState = {
  readonly decoder: JsonlFrameDecoder
  clientNonce?: string
  serverNonce?: string
}

type Peer = {
  readonly socketPath: string
  readonly recordPath: string
  readonly launchId: string
  readonly server: ReturnType<typeof Bun.listen>
  readonly handshake: {
    infoReceived: boolean
    serverProofSent: boolean
    authenticateReceived: boolean
    clientProofVerified: boolean
  }
  /** The message list the host currently holds; a turn's end appends to it. */
  readonly setMessages: (messages: readonly unknown[]) => void
  /** Whether the host reports its current turn as streaming. */
  readonly setStreaming: (streaming: boolean) => void
  readonly count: (command: string) => number
  readonly send: (frame: Record<string, unknown>) => boolean
}

/** Publishes the key record the documented host publishes, then serves the server half of the exchange. */
function startPeer(directory: string, socketPath: string): Peer {
  const agentDir = path.join(directory, "agent")
  const rpcDir = path.join(agentDir, "rpc")
  const keysDir = path.join(rpcDir, "keys")
  const launchId = randomUUID()
  const record = path.join(keysDir, launchId)
  const key = randomBytes(32)
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(agentDir, 0o755)
  fs.chmodSync(rpcDir, 0o755)
  fs.chmodSync(keysDir, 0o700)
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

  const handshake = {
    infoReceived: false,
    serverProofSent: false,
    authenticateReceived: false,
    clientProofVerified: false,
  }
  let messages: readonly unknown[] = PRIOR_MESSAGES
  let streaming = true
  const pulls: string[] = []
  const connections = new WeakMap<object, PeerState>()
  let client: ClientSocket | undefined

  const answer = (socket: ClientSocket, frame: Record<string, unknown>) => {
    socket.write(encodeFrame(frame))
  }

  const model = { provider: "fixture", id: "fixture-model" }

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
          const id = readString(parsed, "id") ?? ""
          const type = readString(parsed, "type") ?? ""
          if (type === "get_protocol_info") {
            const auth = isRecord(parsed.auth) ? parsed.auth : undefined
            const clientNonce = auth !== undefined ? (readString(auth, "client_nonce") ?? "") : ""
            if (!/^[0-9a-f]{64}$/.test(clientNonce)) {
              answer(socket, { id, type: "response", command: type, success: false, error: "auth_required" })
              continue
            }
            handshake.infoReceived = true
            state.clientNonce = clientNonce
            state.serverNonce = hex(randomBytes(32))
            const serverProof = proof(key, ["senpi-rpc-server", launchId, clientNonce, state.serverNonce])
            handshake.serverProofSent = true
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: true,
              data: { auth: { launch_id: launchId, server_nonce: state.serverNonce, server_proof: serverProof } },
            })
            continue
          }
          if (type === "authenticate") {
            handshake.authenticateReceived = true
            const received = readString(parsed, "client_proof") ?? ""
            const expected = proof(key, [
              "senpi-rpc-client",
              launchId,
              state.serverNonce ?? "",
              state.clientNonce ?? "",
            ])
            const ok =
              /^[0-9a-f]{64}$/.test(received) &&
              timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
            if (ok) {
              handshake.clientProofVerified = true
              client = socket
            }
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: ok,
              ...(ok ? {} : { error: "auth_failed" }),
            })
            continue
          }
          pulls.push(type)
          const pull: Record<string, unknown> | undefined =
            type === "subscribe_sessions"
              ? {
                  subscriptionId: "sub-terminal",
                  seq: 0,
                  hostGeneration: "0",
                  hostInstanceId: "instance-terminal",
                  snapshot: [
                    {
                      type: "session_status",
                      subscriptionId: "sub-terminal",
                      seq: 0,
                      sessionId: ROUTING_ID,
                      durableSessionId: DURABLE_ID,
                      sessionPath: path.join(directory, "session.jsonl"),
                      kind: "interactive",
                      cwd: CWD,
                      status: "running",
                      attachments: 1,
                      model: model,
                      pendingQueue: { steering: 0, followUp: 0 },
                    },
                  ],
                }
              : type === "get_state"
                ? {
                    sessionId: DURABLE_ID,
                    sessionName: SESSION_NAME,
                    model: model,
                    thinkingLevel: "medium",
                    isStreaming: streaming,
                    messageCount: messages.length,
                  }
                : type === "get_messages"
                  ? { messages: messages }
                  : type === "get_pending_inputs"
                    ? { lifetimeId: "lifetime-terminal", throughCursor: 0, inputs: [] }
                    : type === "get_entries"
                      ? { entries: [], leafId: null }
                      : type === "get_available_models"
                        ? { models: [] }
                        : type === "get_session_stats"
                          ? { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
                          : undefined
          answer(
            socket,
            pull === undefined
              ? { id, type: "response", command: type, success: false, error: "unsupported_command" }
              : { id, type: "response", command: type, success: true, data: pull },
          )
          continue
        }
      },
      close() {},
      error() {},
    },
  })

  return {
    socketPath: socketPath,
    recordPath: record,
    launchId: launchId,
    server: server,
    handshake: handshake,
    setMessages(next) {
      messages = next
    },
    setStreaming(next) {
      streaming = next
    },
    count: (command: string) => pulls.filter((entry) => entry === command).length,
    send(frame: Record<string, unknown>) {
      const target = client
      if (target === undefined) return false
      try {
        target.write(encodeFrame(frame))
        return true
      } catch {
        return false
      }
    },
  }
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
      data(_terminal, chunk: Uint8Array) {
        target.push(chunk)
      },
    },
    env: {
      ...process.env,
      HOME: fixtureHome,
      XDG_DATA_HOME: path.join(fixtureHome, "data"),
      XDG_CACHE_HOME: path.join(fixtureHome, "cache"),
      XDG_CONFIG_HOME: path.join(fixtureHome, "config"),
      XDG_STATE_HOME: path.join(fixtureHome, "state"),
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ animations: false }),
      TERM: "xterm-256color",
      OPENCODE_ROUTE: JSON.stringify({ type: "session", sessionID: DURABLE_ID }),
    },
  })
}

type Launcher = ReturnType<typeof spawnLauncher>

async function stop(proc: Launcher): Promise<string> {
  proc.kill()
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ])
  return exited ? "launcher child exited" : "launcher child did not exit within " + EXIT_TIMEOUT_MS + "ms"
}

function locateXterm(qaRoot: string): { readonly script: string; readonly css: string } {
  const packageRoot = path.join(qaRoot, "node_modules", "@xterm", "xterm")
  const script = path.join(packageRoot, "lib", "xterm.js")
  const css = path.join(packageRoot, "css", "xterm.css")
  if (!fs.existsSync(script)) throw new Error("@xterm/xterm browser bundle is missing: " + script)
  if (!fs.existsSync(css)) throw new Error("@xterm/xterm stylesheet is missing: " + css)
  return { script: script, css: css }
}

/** Replays the captured PTY bytes into a terminal and reads the visible grid back. */
function screenPage(css: string, library: string, captured: string): string {
  const payload = JSON.stringify(captured).replace(/</g, "\\u003c")
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge terminal state screen</title>
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

async function probeScreen(context: CaseContext, css: string, library: string, captured: string): Promise<string> {
  const pagePath = path.join(context.out, "terminal-state-probe.html")
  fs.writeFileSync(pagePath, screenPage(css, library, captured), { mode: 0o600 })
  const view = new Bun.WebView({ width: 1400, height: 900 })
  try {
    await view.navigate("file://" + pagePath)
    await view.evaluate("window.renderScreen()")
    return String(await view.evaluate("window.screenText()"))
  } finally {
    await view.close()
  }
}

/**
 * Reads the grid again after each new paint until the predicate holds. The wait is on the renderer
 * writing bytes, not on a clock: a paint that has not happened cannot satisfy a check about the
 * screen, and once it has, the next read sees it.
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

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock")
  const peer = startPeer(context.out, socketPath)
  const evidence = capture()
  const children: Launcher[] = []
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  const checks: Check[] = []
  const { script, css } = locateXterm(context.qaRoot)
  const library = fs.readFileSync(script, "utf8")
  const stylesheet = fs.readFileSync(css, "utf8")
  const probe = (captured: string) => probeScreen(context, stylesheet, library, captured)

  const statusFrame = (status: string) => ({
    type: "session_status",
    sessionId: ROUTING_ID,
    durableSessionId: DURABLE_ID,
    cwd: CWD,
    status: status,
    model: { provider: "fixture", id: "fixture-model" },
  })

  const turnEndFrame = (stopReason: string, text: string, messageId: string) => ({
    type: "turn_end",
    sessionId: ROUTING_ID,
    messageId: messageId,
    message: {
      role: "assistant",
      sessionId: ROUTING_ID,
      provider: "fixture",
      model: "fixture-model",
      timestamp: Date.now(),
      content: [{ type: "text", text: text }],
      stopReason: stopReason,
    },
    toolResults: [],
  })

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.recordPath, path.join(context.out, "fixture"), evidence)
    children.push(launcher)
    await waitForCapture(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const launchState = (plain(evidence.text()).match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const ready = launchState === "ready"

    /* The transcript is the readiness signal for the route: the pulled assistant text is on screen
       once the session view renders, and the running indicator is drawn in the same composer footer. */
    const mounted = ready
      ? await waitForScreen(evidence, probe, (screen) => flatScreen(screen).includes(squash(PRIOR_TEXT)), SCREEN_TIMEOUT_MS)
      : { ok: false, screen: "", reads: 0 }

    const running = mounted.ok
      ? await waitForScreen(evidence, probe, (screen) => footerRow(screen).includes(RUNNING_MARK), SCREEN_TIMEOUT_MS)
      : { ok: false, screen: "", reads: 0 }

    /* The settle record is sent with the host reporting a quiet state, so the read it triggers reads
       the finished turn instead of a turn still in flight. */
    if (running.ok) peer.setStreaming(false)
    const settledDelivered = running.ok && peer.send(statusFrame("idle"))
    const settled = settledDelivered
      ? await waitForScreen(
          evidence,
          probe,
          (screen) => {
            const footer = footerRow(screen)
            return !footer.includes(RUNNING_MARK) && footer.includes(IDLE_MARK)
          },
          SCREEN_TIMEOUT_MS,
        )
      : { ok: false, screen: "", reads: 0 }

    /* The aborted turn: the host reports it running, ends it with an aborted stop reason, then settles
       the status. The finished message only exists in the host's list after the turn ended, which is
       what the launcher's re-read at the boundary fetches. */
    const secondTurnDelivered = settled.ok && peer.send(statusFrame("running"))
    if (secondTurnDelivered) peer.setStreaming(true)
    const secondRunning = secondTurnDelivered
      ? await waitForScreen(evidence, probe, (screen) => footerRow(screen).includes(RUNNING_MARK), SCREEN_TIMEOUT_MS)
      : { ok: false, screen: "", reads: 0 }

    /* The host appends the finished message at the turn boundary, so the list is updated before the
       status record that settles the row: the re-read that record triggers is the one that fetches it. */
    if (secondRunning.ok) {
      peer.setMessages(ABORTED_MESSAGES)
      peer.setStreaming(false)
    }
    const abortedFrameSent = secondRunning.ok && peer.send(turnEndFrame("aborted", ABORTED_TEXT, "host-assistant-2"))
    const abortedSettled = abortedFrameSent && peer.send(statusFrame("idle"))
    const aborted = abortedSettled
      ? await waitForScreen(
          evidence,
          probe,
          (screen) => {
            const flat = flatScreen(screen)
            return flat.includes(squash(ABORTED_TEXT)) && flat.includes(INTERRUPTED_MARK) && !footerRow(screen).includes(RUNNING_MARK)
          },
          SCREEN_TIMEOUT_MS,
        )
      : { ok: false, screen: "", reads: 0 }

    const captured = evidence.text()
    const captureBytes = Buffer.byteLength(captured, "utf8")
    fs.writeFileSync(path.join(context.out, "tui-terminal-state-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-terminal-state-pty.txt")
    for (const phase of [
      ["running", running],
      ["idle", settled],
      ["aborted", aborted],
    ] as const) {
      if (phase[1].screen.length === 0) continue
      fs.writeFileSync(path.join(context.out, phase[0] + "-screen.txt"), phase[1].screen, { mode: 0o600 })
      artifacts.push(phase[0] + "-screen.txt")
    }

    const pagePath = path.join(context.out, "terminal-state-screen.html")
    fs.writeFileSync(pagePath, screenPage(stylesheet, library, captured), { mode: 0o600 })
    artifacts.push("terminal-state-screen.html")
    const view = new Bun.WebView({ width: 1400, height: 900 })
    let screen = ""
    try {
      await view.navigate("file://" + pagePath)
      await view.evaluate("window.renderScreen()")
      screen = String(await view.evaluate("window.screenText()"))
      fs.writeFileSync(path.join(context.out, "terminal-state-screen.txt"), screen, { mode: 0o600 })
      artifacts.push("terminal-state-screen.txt")
      await Bun.write(path.join(context.out, "terminal-state-screen.png"), await view.screenshot())
      artifacts.push("terminal-state-screen.png")
    } finally {
      await view.close()
    }
    const finalFlat = flatScreen(screen)

    checks.push(
      {
        name: "handshake-verified",
        expected: "the peer answers get_protocol_info with data.auth and the client returns a valid client_proof",
        observed:
          "info=" +
          String(peer.handshake.infoReceived) +
          " serverProof=" +
          String(peer.handshake.serverProofSent) +
          " authenticate=" +
          String(peer.handshake.authenticateReceived) +
          " clientProof=" +
          String(peer.handshake.clientProofVerified),
        pass:
          peer.handshake.infoReceived &&
          peer.handshake.serverProofSent &&
          peer.handshake.authenticateReceived &&
          peer.handshake.clientProofVerified,
      },
      {
        name: "launcher-reports-ready",
        expected: "BRIDGE_STATE=ready after the handshake",
        observed: "BRIDGE_STATE=" + launchState,
        pass: ready,
      },
      {
        name: "transcript-settled-turn-on-screen",
        expected: "the pulled assistant text of the settled turn is drawn on the session route",
        observed: mounted.ok ? "prior turn text on screen" : "not on screen; tail: " + flatScreen(evidence.text()).slice(-160),
        pass: mounted.ok,
      },
      {
        name: "running-indicator-visible",
        expected: "while the host reports the turn running, the composer footer draws its running indicator (" + RUNNING_MARK + ")",
        observed: running.ok
          ? "indicator drawn after " + String(running.reads) + " screen read(s)"
          : "indicator missing; screen tail: " + flatScreen(running.screen).slice(-200),
        pass: running.ok,
      },
      {
        name: "running-indicator-clears-on-idle",
        expected: "after the host settles the turn, the rendered footer no longer shows the running indicator and draws the idle location label",
        observed: settled.ok
          ? "indicator gone, idle label present after " + String(settled.reads) + " screen read(s)"
          : "footer row: " + footerRow(settled.screen).slice(-120),
        pass: settled.ok,
      },
      {
        name: "aborted-turn-says-so",
        expected:
          "the turn ended with an aborted stop reason reads on the rendered screen as an interrupted turn, and the footer is not left running",
        observed: aborted.ok
          ? "aborted reply and interrupted marker on screen after " + String(aborted.reads) + " screen read(s)"
          : "aborted reply " +
            String(finalFlat.includes(squash(ABORTED_TEXT))) +
            ", interrupted marker " +
            String(finalFlat.includes(INTERRUPTED_MARK)) +
            ", footer row " +
            JSON.stringify(footerRow(screen).slice(-120)) +
            ", second running showed " +
            String(secondRunning.ok) +
            ", turn end sent " +
            String(abortedFrameSent) +
            ", get_messages reads " +
            String(peer.count("get_messages")) +
            "; final screen tail: " +
            finalFlat.slice(-220),
        pass: aborted.ok,
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture under the evidence directory",
        observed: String(captureBytes) + " bytes",
        pass: captureBytes > 0,
      },
    )
  } finally {
    for (const child of children) cleanupDetail.push(await stop(child))
    peer.server.stop(true)
    cleanupDetail.push("peer listener stopped")
    for (const target of [socketPath, peer.recordPath]) {
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
    const fixtureHome = path.join(context.out, "fixture")
    try {
      fs.rmSync(fixtureHome, { recursive: true, force: true })
    } catch {
      cleanupDetail.push("fixture home could not be removed")
    }
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.recordPath) ? "key record still present" : "key record removed",
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
