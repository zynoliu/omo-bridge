import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { decodeHostFrame } from "../../../packages/bridge-core/src/host-frames.ts"
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts"

/**
 * A permission prompt end to end: the stand-in host completes the published socket handshake,
 * writes one `extension_ui_request` select frame, and the real bridge TUI is driven in a PTY with
 * the `1` key. The case holds when the host receives exactly one `extension_ui_response` naming
 * that request with the chosen label, and the panel stops offering the prompt for answering.
 */

const READY_TIMEOUT_MS = 20_000
const SCREEN_TIMEOUT_MS = 20_000
const RESPONSE_TIMEOUT_MS = 10_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 60

const REQUEST_ID = "ui-permission-once-1"
const TITLE = "Permission required: read /workspace/bridge-t17.txt"
const OPTIONS = ["Allow once", "Allow always", "Deny"]

/** The option list is drawn as `1. Allow once`, so only the digit is the binding. */
const KEY = "1"
const CHOSEN = "Allow once"

/** Panel strings compared with every whitespace run removed, so wrapping cannot hide them. */
const TITLE_FLAT = squash(TITLE)
const CHOSEN_FLAT = squash(CHOSEN)
const OPEN_AFFORDANCE_FLAT = squash("Cancel (sends cancelled: true)")
const SETTLED_FLAT = squash("Answered: " + CHOSEN + " (sent once; this prompt is not submitted again)")

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

/** Same contract for the host side: it fires when the peer records a frame, not on a poll. */
function waitForPeer(peer: Peer, predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer)
      unsubscribe()
      resolve(value)
    }
    const listener = () => {
      if (predicate()) finish(true)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const unsubscribe = peer.subscribe(listener)
    listener()
  })
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

function flatScreen(text: string): string {
  return squash(plain(text))
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

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name + ": " + error.message
  return String(error)
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
  /** Every `extension_ui_response` the client wrote, in arrival order, as received. */
  readonly responses: () => readonly Record<string, unknown>[]
  readonly otherFrames: () => readonly Record<string, unknown>[]
  readonly subscribe: (listener: () => void) => () => void
  /** Writes one frame to the authenticated client; false when no client is connected. */
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
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o755 })
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
  const responses: Record<string, unknown>[] = []
  const otherFrames: Record<string, unknown>[] = []
  const listeners = new Set<() => void>()
  const connections = new WeakMap<object, PeerState>()
  let client: ClientSocket | undefined

  const notify = () => {
    for (const listener of [...listeners]) listener()
  }

  const answer = (socket: ClientSocket, frame: Record<string, unknown>) => {
    socket.write(encodeFrame(frame))
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
          /* The launcher pulls host state before it can report ready; answering these is what lets the case
             reach the approval path it is meant to test. They are still recorded for the assertions below. */
          const pull: Record<string, unknown> | undefined =
            type === "subscribe_sessions"
              ? {
                  subscriptionId: "sub-permission",
                  snapshot: [{ type: "session_status", sessionId: "rpc-1", durableSessionId: "rpc-1", cwd: "/work", status: "idle" }],
                }
              : type === "get_state"
                ? { sessionId: "rpc-1", sessionName: "Permission probe", isStreaming: false }
                : type === "get_messages"
                  ? { messages: [] }
                  : type === "get_pending_inputs"
                    ? { inputs: [] }
                    : type === "get_entries"
                      ? { entries: [], leafId: null }
                      : type === "get_available_models"
                        ? { models: [] }
                        : undefined
          if (pull !== undefined) {
            otherFrames.push(parsed)
            answer(socket, { id, type: "response", command: type, success: true, data: pull })
            notify()
            continue
          }
          if (type === "extension_ui_response") responses.push(parsed)
          else otherFrames.push(parsed)
          notify()
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
    responses: () => responses,
    otherFrames: () => otherFrames,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
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
    // The TUI's JSX runtime resolves through the CLI package's tsconfig, as in `bun run dev`.
    cwd: path.join(qaRoot, "..", "..", "packages", "cli"),
    terminal: {
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      data(_terminal, chunk) {
        target.push(chunk)
      },
    },
    env: { ...process.env, TERM: "xterm-256color" },
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

/** After `stop(true)` nothing may answer on that path; the failure itself is the proof. */
async function listenerStopped(socketPath: string): Promise<string> {
  try {
    const connection = await Bun.connect({
      unix: socketPath,
      socket: {
        open() {},
        data() {},
        close() {},
        error() {},
      },
    })
    connection.end()
    return "peer listener still accepting connections"
  } catch (error) {
    return "peer listener stopped (later connect failed: " + describeError(error) + ")"
  }
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
 * Replays the captured PTY bytes into a terminal and reads the visible grid back, so the panel can
 * be judged as it ended up rather than as a log of every frame it ever drew.
 */
function screenPage(css: string, library: string, captured: string): string {
  const payload = JSON.stringify(captured).replace(/</g, "\\u003c")
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge dialog screen</title>
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
</script></body></html>`;
}

async function renderScreen(context: CaseContext, captured: string, artifacts: string[]): Promise<string> {
  const { script, css } = locateXterm(context.qaRoot)
  const pagePath = path.join(context.out, "dialog-screen.html")
  fs.writeFileSync(pagePath, screenPage(fs.readFileSync(css, "utf8"), fs.readFileSync(script, "utf8"), captured), {
    mode: 0o600,
  })
  artifacts.push("dialog-screen.html")
  const view = new Bun.WebView({ width: 1200, height: 1100 })
  try {
    await view.navigate("file://" + pagePath)
    await view.evaluate("window.renderScreen()")
    const text = String(await view.evaluate("window.screenText()"))
    fs.writeFileSync(path.join(context.out, "dialog-screen.txt"), text, { mode: 0o600 })
    artifacts.push("dialog-screen.txt")
    const shot = await view.screenshot()
    await Bun.write(path.join(context.out, "dialog-screen.png"), shot)
    artifacts.push("dialog-screen.png")
    return text
  } finally {
    await view.close()
  }
}

/** The decoded value of an `extension_ui_response`, or undefined when the frame is not one. */
function answeredValue(frame: Record<string, unknown>): string | undefined {
  const decoded = decodeHostFrame(frame)
  if (!decoded.ok) return undefined
  if (decoded.frame.type !== "extension_ui_response") return undefined
  if (!("value" in decoded.frame)) return undefined
  return decoded.frame.value
}

function decodeNote(frame: Record<string, unknown>): string {
  const decoded = decodeHostFrame(frame)
  return decoded.ok ? "decoded" : "rejected: " + decoded.reason
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock")
  const peer = startPeer(context.out, socketPath)
  const evidence = capture()
  const children: Launcher[] = []
  const checks: Check[] = []
  const cleanupDetail: string[] = []
  const artifacts: string[] = []

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.recordPath, evidence)
    children.push(launcher)
    const reported = await waitForCapture(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const launchState = (plain(evidence.text()).match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const ready = reported && launchState === "ready"

    /* Sent only after the launcher reported ready: the TUI subscribes to host frames after the
       handshake, so a frame written earlier would be published before anything listens for it. */
    const requestDelivered =
      ready &&
      peer.send({
        type: "extension_ui_request",
        id: REQUEST_ID,
        method: "select",
        title: TITLE,
        options: OPTIONS,
        toolCallId: "call-t17-permission",
      })

    const promptVisible = (text: string) => {
      const flat = flatScreen(text)
      return flat.includes(TITLE_FLAT) && flat.includes(CHOSEN_FLAT) && flat.includes(OPEN_AFFORDANCE_FLAT)
    }
    const promptOnScreen = requestDelivered && (await waitForCapture(evidence, promptVisible, SCREEN_TIMEOUT_MS))

    const answersFor = () => peer.responses().filter((frame) => readString(frame, "uiRequestId") === REQUEST_ID)
    const terminal = launcher.terminal
    const keySent = promptOnScreen && terminal !== undefined
    if (keySent && terminal !== undefined) terminal.write(KEY)

    const answered = await waitForPeer(peer, () => answersFor().length > 0, RESPONSE_TIMEOUT_MS)
    /* The settled line replaces the prompt's affordances only after the answer was written, so
       waiting for it is the state change, not a pause after the key press. */
    const settledOnScreen =
      answered && (await waitForCapture(evidence, (text) => flatScreen(text).includes(SETTLED_FLAT), SCREEN_TIMEOUT_MS))

    const captured = evidence.text()
    const captureBytes = Buffer.byteLength(captured, "utf8")
    fs.writeFileSync(path.join(context.out, "tui-permission-once-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-permission-once-pty.txt")

    const screen = await renderScreen(context, captured, artifacts)
    const screenFlat = squash(screen)
    const finalPromptGone = screenFlat.includes(SETTLED_FLAT) && !screenFlat.includes(OPEN_AFFORDANCE_FLAT)

    const answers = answersFor()
    const values = answers.map((frame) => answeredValue(frame) ?? "(no value)")
    const oneAnswerWithLabel = answers.length === 1 && values[0] === CHOSEN
    const answerIds = answers.map((frame) => readString(frame, "id") ?? "(no id)")

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
        name: "permission-request-written",
        expected: "one select frame for " + REQUEST_ID + " reached the authenticated client",
        observed: requestDelivered ? "frame written to the client socket" : "not written (no authenticated client)",
        pass: requestDelivered,
      },
      {
        name: "prompt-visible-before-answering",
        expected: "the panel shows the permission title, its options and the open-prompt affordance",
        observed: promptOnScreen
          ? "title, '" + CHOSEN + "' and '" + squash("Cancel (sends cancelled: true)") + "' on the screen stream"
          : "not seen; screen tail: " + flatScreen(evidence.text()).slice(-160),
        pass: promptOnScreen,
      },
      {
        name: "single-answer-for-the-request",
        expected: "exactly one extension_ui_response with uiRequestId " + REQUEST_ID + " and value '" + CHOSEN + "'",
        observed:
          String(answers.length) +
          " response(s) for that request: value=" +
          JSON.stringify(values) +
          " id=" +
          JSON.stringify(answerIds) +
          " decode=" +
          JSON.stringify(answers.map(decodeNote)) +
          " (other client frames: " +
          String(peer.otherFrames().length) +
          ")",
        pass: keySent && answered && oneAnswerWithLabel,
      },
      {
        name: "panel-settled-not-open",
        expected: "the rendered panel shows the settled line and no longer offers to cancel or answer the prompt",
        observed: settledOnScreen
          ? "settled line on screen; open affordance " +
            (screenFlat.includes(OPEN_AFFORDANCE_FLAT) ? "still present" : "absent")
          : "the settled line never reached the screen; tail: " + flatScreen(evidence.text()).slice(-160),
        pass: settledOnScreen && finalPromptGone,
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
    cleanupDetail.push(await listenerStopped(socketPath))
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
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.recordPath) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
      "launch id " + peer.launchId.slice(0, 8) + " (synthetic, generated by this case)",
    )
  }

  const cleanupOk = cleanupDetail.every(
    (entry) =>
      !entry.includes("did not exit") &&
      !entry.includes("still present") &&
      !entry.includes("could not") &&
      !entry.includes("still accepting"),
  )
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
