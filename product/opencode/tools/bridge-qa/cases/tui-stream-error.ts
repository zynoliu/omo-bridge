import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts"

/**
 * Plan task 15 failure QA: "模型不可用时状态转为 error，界面仍能输入".
 *
 * The peer below is the host as it behaves for an unavailable model, not an invented shape:
 * `get_messages` answers with the assistant message a failed provider request leaves behind
 * (`stopReason: "error"` plus `errorMessage`), and the live frames repeated after it are the ones the
 * host publishes for the same failure (`agent_end` with `failure`, `auto_retry_start`/`auto_retry_end`).
 * Those shapes are taken from the captured unavailable-model run
 * `knowledge/source-captures/handoff-captures/captures/stream-go-minimax-unavailable-20261110/raw-log.jsonl`
 * and from `upstream/senpi/packages/coding-agent/docs/rpc.md` ("agent_end", "auto_retry_start /
 * auto_retry_end"). The failure string asserted below is the peer's own `errorMessage` value, so the
 * case carries no error text of its own.
 *
 * Status when written (2026-11-17): this case FAILS by design until the bridge projects the host's
 * failure. `packages/cli/src/bridge-run.ts:487-499` builds the TUI assistant message without an
 * `error` field and never reads `stopReason`/`errorMessage`, and `packages/tui/src/app.tsx:62,439`
 * mounts no bridge transcript, so the host's failure reaches neither the transcript nor the route.
 * It must not be counted as task-15 acceptance while that check fails; the failing check names the
 * gap on every run.
 */

const READY_TIMEOUT_MS = 20_000
const SCREEN_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 40

const DURABLE_ID = "stream-error-session-1"
const ROUTING_ID = "rpc-stream-error-1"
const CWD = "/workspace/bridge-stream-error"
const USER_TEXT = "Answer the probe even though the model is gone"
const INPUT_MARKER = "error-probe-input"

/** The provider refusal an unavailable model returns, as the captured run recorded it on the message. */
const MODEL_UNAVAILABLE = '400: {"type":"server_error","message":"Upstream request failed: Model is unavailable."}'

const MODEL = { provider: "fixture", id: "fixture-model" }

const MESSAGES = [
  { role: "user", content: USER_TEXT, timestamp: 1_700_200_000_000 },
  {
    role: "assistant",
    provider: MODEL.provider,
    model: MODEL.id,
    api: "openai-completions",
    content: [],
    stopReason: "error",
    errorMessage: MODEL_UNAVAILABLE,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1_700_200_001_000,
    timing: { requestedAt: 1_700_200_000_500, endedAt: 1_700_200_001_000 },
  },
]

/** The host's terminal notice for the run, documented for `agent_end` when the last message failed. */
const AGENT_END = {
  type: "agent_end",
  messages: [MESSAGES[1]],
  willRetry: false,
  failure: {
    category: "invalid_request",
    provider: MODEL.provider,
    model: MODEL.id,
    httpStatus: 400,
    reason: "the provider could not accept this request",
    action: "send the message again; if it repeats, choose another model or start a new session",
  },
  sessionId: ROUTING_ID,
}

/** The retry notice the same run published before it settled, and its terminal record. */
const AUTO_RETRY_START = {
  type: "auto_retry_start",
  attempt: 1,
  maxAttempts: 5,
  delayMs: 0,
  errorMessage: MODEL_UNAVAILABLE,
  sessionId: ROUTING_ID,
}

const AUTO_RETRY_END = {
  type: "auto_retry_end",
  success: false,
  attempt: 5,
  finalError: MODEL_UNAVAILABLE,
  sessionId: ROUTING_ID,
}

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

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

function proof(key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("hex")
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
  /** Writes one live host frame to every connection that authenticated, as the host does. */
  readonly broadcast: (frame: unknown) => void
}

type PeerConnection = {
  readonly decoder: JsonlFrameDecoder
  readonly socket: { write(chunk: Uint8Array): unknown; end(): unknown }
  authenticated: boolean
  clientNonce?: string
  serverNonce?: string
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
  const connections = new Map<object, PeerConnection>()

  const answer = (socket: { write(chunk: Uint8Array): unknown }, frame: Record<string, unknown>) => {
    socket.write(encodeFrame(frame))
  }

  const broadcast = (frame: unknown) => {
    for (const connection of connections.values()) {
      if (!connection.authenticated) continue
      connection.socket.write(encodeFrame(frame))
    }
  }

  const pullAnswer = (command: string): Record<string, unknown> | undefined => {
    if (command === "subscribe_sessions") {
      return {
        success: true,
        data: {
          subscriptionId: "sub-stream-error",
          seq: 0,
          hostGeneration: "0",
          hostInstanceId: "instance-stream-error",
          snapshot: [
            {
              type: "session_status",
              subscriptionId: "sub-stream-error",
              seq: 0,
              sessionId: ROUTING_ID,
              durableSessionId: DURABLE_ID,
              sessionPath: path.join(directory, "session.jsonl"),
              kind: "interactive",
              cwd: CWD,
              status: "idle",
              attachments: 1,
              model: MODEL,
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
          sessionName: "Bridge stream error probe",
          model: MODEL,
          thinkingLevel: "medium",
          isStreaming: false,
          messageCount: MESSAGES.length,
        },
      }
    }
    if (command === "get_messages") return { success: true, data: { messages: MESSAGES } }
    if (command === "get_pending_inputs") {
      return { success: true, data: { lifetimeId: "lifetime-stream-error", throughCursor: 0, inputs: [] } }
    }
    return undefined
  }

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open() {},
      data(socket, chunk) {
        const opened = connections.get(socket)
        const entry: PeerConnection = opened ?? { decoder: new JsonlFrameDecoder(), socket: socket, authenticated: false }
        connections.set(socket, entry)
        let frames: readonly string[]
        try {
          frames = entry.decoder.push(chunk)
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
            entry.clientNonce = clientNonce
            entry.serverNonce = hex(randomBytes(32))
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: true,
              data: {
                auth: {
                  launch_id: launchId,
                  server_nonce: entry.serverNonce,
                  server_proof: proof(key, ["senpi-rpc-server", launchId, clientNonce, entry.serverNonce]),
                },
              },
            })
            continue
          }
          if (type === "authenticate") {
            observed.authenticateReceived = true
            const received = typeof parsed.client_proof === "string" ? parsed.client_proof : ""
            const expected = proof(key, ["senpi-rpc-client", launchId, entry.serverNonce ?? "", entry.clientNonce ?? ""])
            const ok =
              /^[0-9a-f]{64}$/.test(received) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
            if (ok) observed.clientProofVerified = true
            entry.authenticated = ok
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
      close(socket) {
        connections.delete(socket)
      },
      error() {},
    },
  })

  return {
    socket: socketPath,
    record: record,
    launchId: launchId,
    server: server,
    commands: commands,
    observed: observed,
    broadcast: broadcast,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  return !Array.isArray(value)
}

function spawnLauncher(qaRoot: string, socketPath: string, recordPath: string, home: string, target: Capture) {
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
    env: {
      ...process.env,
      TERM: "xterm-256color",
      // The TUI persists session tabs under the XDG state root. Inherited tabs from another case
      // name sessions this host never publishes, and `data.session.get` refuses an unknown id, so
      // the case gives the launcher a home of its own instead of judging a screen another run left.
      HOME: home,
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
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
<html><head><meta charset="utf-8"><title>bridge stream error screen</title>
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

async function renderScreen(context: CaseContext, captured: string, artifacts: string[]): Promise<string> {
  const { script, css } = locateXterm(context.qaRoot)
  const pagePath = path.join(context.out, "stream-error-screen.html")
  fs.writeFileSync(pagePath, screenPage(fs.readFileSync(css, "utf8"), fs.readFileSync(script, "utf8"), captured), {
    mode: 0o600,
  })
  artifacts.push("stream-error-screen.html")
  const view = new Bun.WebView({ width: TERMINAL_COLS * 10, height: TERMINAL_ROWS * 10 })
  try {
    await view.navigate("file://" + pagePath)
    await view.evaluate("window.renderScreen()")
    const text = String(await view.evaluate("window.screenText()"))
    fs.writeFileSync(path.join(context.out, "stream-error-screen.txt"), text, { mode: 0o600 })
    artifacts.push("stream-error-screen.txt")
    const shot = await view.screenshot()
    await Bun.write(path.join(context.out, "stream-error-screen.png"), shot)
    artifacts.push("stream-error-screen.png")
    return text
  } finally {
    await view.close()
  }
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock")
  const home = path.join(context.out, "home")
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const peer = startDocumentedPeer(context.out, socketPath)
  const evidence = capture()
  const children: ReturnType<typeof spawnLauncher>[] = []
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  let checks: Check[] = []

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.record, home, evidence)
    children.push(launcher)
    await waitFor(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const launchState = (evidence.text().match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const pulled = await waitFor(evidence, () => peer.commands.includes("get_pending_inputs"), SCREEN_TIMEOUT_MS)
    // The pulled user turn is the readiness signal: the session route is on screen once it is drawn.
    const projected = await waitFor(evidence, (text) => plain(text).includes(USER_TEXT), SCREEN_TIMEOUT_MS)

    // The host publishes the run's terminal notice and retry records after the turn failed. Sending
    // them is part of the real failure window; whether the client renders anything for them is what
    // the checks below measure.
    peer.broadcast(AGENT_END)
    peer.broadcast(AUTO_RETRY_START)
    peer.broadcast(AUTO_RETRY_END)

    // Bounded wait for the failure to become visible. The peer delivered it inside `get_messages`;
    // a client that projects provider errors shows the peer's own `errorMessage` here.
    const failureShown = await waitFor(evidence, (text) => plain(text).includes(MODEL_UNAVAILABLE), SCREEN_TIMEOUT_MS)

    // Requirement 2: after the failure the interface still accepts input. Real keystrokes, then a
    // bounded wait on the visible echo; the replayed screen below is what the check judges.
    if (launcher.terminal !== undefined) launcher.terminal.write(INPUT_MARKER)
    const inputStreamed = await waitFor(evidence, (text) => plain(text).includes(INPUT_MARKER), SCREEN_TIMEOUT_MS)

    const captured = evidence.text()
    fs.writeFileSync(path.join(context.out, "tui-stream-error-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-stream-error-pty.txt")

    const screen = await renderScreen(context, captured, artifacts)
    const flat = screen.replace(/\s+/g, " ")
    const failureHits = flat.includes(MODEL_UNAVAILABLE) ? 1 : 0
    const inputHits = flat.includes(INPUT_MARKER) ? 1 : 0
    const rendered = screen.trim().length > 0
    const crash = screen.indexOf("OpenCode crashed")
    const crashLine = /UNSUPPORTED_CAPABILITY:[^│\n]*/.exec(screen)?.[0]?.trim()
    const tail = flat.slice(-220).trim()

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
        expected: "subscribe_sessions, then get_state, get_messages and get_pending_inputs per session",
        observed: peer.commands.join(", ") || "no commands",
        pass:
          pulled &&
          peer.commands[0] === "subscribe_sessions" &&
          peer.commands[1] === "get_state" &&
          peer.commands[2] === "get_messages" &&
          peer.commands[3] === "get_pending_inputs",
      },
      {
        name: "session-route-mounted",
        expected: "the TUI session route renders the pulled session (non-empty screen, no crash)",
        observed: rendered
          ? (crash < 0 ? "route rendered" : (crashLine ?? "OpenCode crashed without a capability name")) +
            "; pulled user turn " +
            (projected ? "seen in the PTY stream" : "absent from the PTY stream")
          : "the session route drew nothing",
        pass: rendered && crash < 0,
      },
      {
        name: "model-unavailable-error-visible",
        expected:
          "the transcript shows the peer's failure (stopReason=error, errorMessage=" +
          MODEL_UNAVAILABLE +
          ") instead of swallowing it",
        observed:
          failureHits > 0
            ? "host failure text on screen"
            : failureShown
              ? "text reached the PTY stream but not the final screen"
              : crashLine !== undefined
                ? "crash: " + crashLine
                : crash >= 0
                  ? "crash screen: " + screen.slice(crash, crash + 220).replace(/\s+/g, " ").trim()
                  : "not on screen; the pulled failure was projected without an error field; tail: " + tail,
        pass: failureHits > 0,
      },
      {
        name: "composer-accepts-input-after-error",
        expected: "the typed keystrokes " + INPUT_MARKER + " are echoed in the composer after the failure",
        observed:
          "screen echo=" +
          String(inputHits > 0) +
          " stream echo=" +
          String(inputStreamed) +
          (inputHits > 0 ? "" : "; tail: " + tail),
        pass: inputHits > 0,
      },
      {
        name: "no-crash-after-host-error",
        expected: "the host's agent_end and retry notices do not crash the TUI",
        observed: !rendered ? "no screen to judge" : crash < 0 ? "no crash screen" : (crashLine ?? "OpenCode crashed"),
        pass: rendered && crash < 0,
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
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.record) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
      fs.existsSync(home) ? "case home retained for inspection" : "case home removed",
      "launch id " + peer.launchId.slice(0, 8) + " (synthetic, generated by this case)",
    )
  }

  const cleanupOk = cleanupDetail.every(
    (entry) => !entry.includes("did not exit") && !entry.includes("still present") && !entry.includes("could not"),
  )
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
