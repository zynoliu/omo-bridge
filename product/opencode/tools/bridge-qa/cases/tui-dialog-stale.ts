import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { decodeHostFrame } from "../../../packages/bridge-core/src/host-frames.ts"
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts"

/**
 * A settled dialog cannot be answered twice. The stand-in host writes one select frame, the bridge
 * TUI is driven in a PTY until the answer is written back, then the host replays the same request id
 * and presses the key again. A live prompt with a new id is opened afterwards so the second press
 * has somewhere to land, which is what proves the press reached the panel. A throwaway question then
 * proves the escape key cancels a live question, and the host closes a second `question` with
 * `question_resolved`, the one host-close frame the verified vocabulary declares.
 *
 * The final panel is read with the frame and scrollbar glyphs removed: those land in the middle of a
 * wrapped line and are chrome, not text. A settled row also leaves stale glyphs behind in this
 * renderer, so "nothing is answerable" is asserted through the key path (escape writes no response)
 * rather than by the absence of the words on the grid.
 */

const READY_TIMEOUT_MS = 20_000
const SCREEN_TIMEOUT_MS = 20_000
const RESPONSE_TIMEOUT_MS = 10_000
/** An answer that must not happen is waited for this long before the absence can be reported. */
const SILENCE_TIMEOUT_MS = 2_000
const EXIT_TIMEOUT_MS = 5_000
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 60

const REQUEST_ID = "ui-permission-stale-1"
const TITLE = "Permission required: write /workspace/bridge-t17-stale.txt"
const OPTIONS = ["Allow once", "Allow always", "Deny"]
const CHOSEN = "Allow once"

const FRESH_ID = "ui-permission-stale-2"
const FRESH_TITLE = "Permission required: network"
/** The first option differs, so the second press reveals which dialog it answered. */
const FRESH_OPTIONS = ["Deny", "Allow once", "Allow always"]
const FRESH_CHOSEN = "Deny"

const QUESTION_ID = "ui-question-stale-1"
const QUESTION_REQUEST = "ask-t17-stale"
const QUESTION_TOOL_CALL = "call-t17-stale-question"
/* A second question whose only job is to prove the escape key cancels a live question in this
   harness; without that control, "escape wrote nothing" after the close could just mean the key
   never reached the panel. */
const LIVE_QUESTION_ID = "ui-question-live-1"
const LIVE_QUESTION_REQUEST = "ask-t17-live"
const LIVE_QUESTION_TOOL_CALL = "call-t17-live-question"
const LIVE_QUESTION_HEADER = "Escape probe"

const KEY = "1"

/** Panel strings compared with every whitespace run removed, so wrapping cannot hide them. */
const TITLE_FLAT = squash(TITLE)
const CHOSEN_FLAT = squash(CHOSEN)
const FRESH_TITLE_FLAT = squash(FRESH_TITLE)
const QUESTION_HEADER_FLAT = squash("Question")
const OPEN_AFFORDANCE_FLAT = squash("Cancel (sends cancelled: true)")
const QUESTION_SUBMIT_FLAT = squash("Send answers")
const SETTLED_FLAT = squash("Answered: " + CHOSEN + " (sent once; this prompt is not submitted again)")
const FRESH_SETTLED_FLAT = squash("Answered: " + FRESH_CHOSEN + " (sent once; this prompt is not submitted again)")
const HOST_CLOSED_FLAT = squash(
  "Dismissed by the host (cancelled or timed out). It can no longer be answered.",
)

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
  /* The frame, scrollbar and logo are drawn with block and box-drawing glyphs. A user reads the text
     inside them, and those glyphs land in the middle of a wrapped line, so they are chrome, not content. */
  return squash(plain(text)).replace(/[\u2500-\u259F]/g, "")
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
  readonly responses: () => readonly Record<string, unknown>[]
  readonly otherFrames: () => readonly Record<string, unknown>[]
  readonly subscribe: (listener: () => void) => () => void
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
                        : type === "get_session_stats"
                          ? { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
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

  const selectFrame = (id: string, title: string, options: readonly string[], toolCallId: string) => ({
    type: "extension_ui_request",
    id: id,
    method: "select",
    title: title,
    options: options,
    toolCallId: toolCallId,
  })

  const questionFrame = (id: string, requestId: string, toolCallId: string, header: string) => {
    const askedAtMs = Date.now()
    return {
      type: "extension_ui_request",
      id: id,
      method: "question",
      requestId: requestId,
      toolCallId: toolCallId,
      waitForAnswer: true,
      questions: [
        {
          id: "q1",
          header: header,
          question: "Which target should the host use?",
          options: [{ label: "Staging" }, { label: "Production" }],
          multiSelect: false,
        },
      ],
      timeout: 1_800_000,
      askedAtMs: askedAtMs,
      deadlineAtMs: askedAtMs + 1_800_000,
      remainingMs: 1_800_000,
    }
  }

  const resolvedFrame = (requestId: string, toolCallId: string) => ({
    type: "question_resolved",
    id: "resolve-" + requestId,
    requestId: requestId,
    toolCallId: toolCallId,
    outcome: "cancelled",
    answers: {},
    unanswered: ["q1"],
  })

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.recordPath, evidence)
    children.push(launcher)
    const reported = await waitForCapture(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const launchState = (plain(evidence.text()).match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const ready = reported && launchState === "ready"
    const terminal = launcher.terminal

    /* Sent only after the launcher reported ready: the TUI subscribes to host frames after the
       handshake, so a frame written earlier would be published before anything listens for it. */
    const firstDelivered =
      ready && peer.send(selectFrame(REQUEST_ID, TITLE, OPTIONS, "call-t17-stale-permission"))

    const promptVisible = (text: string) => {
      const flat = flatScreen(text)
      return flat.includes(TITLE_FLAT) && flat.includes(CHOSEN_FLAT) && flat.includes(OPEN_AFFORDANCE_FLAT)
    }
    const promptOnScreen = firstDelivered && (await waitForCapture(evidence, promptVisible, SCREEN_TIMEOUT_MS))

    const answersFor = (id: string) =>
      peer.responses().filter((frame) => readString(frame, "uiRequestId") === id)

    if (promptOnScreen && terminal !== undefined) terminal.write(KEY)
    const firstAnswered = await waitForPeer(peer, () => answersFor(REQUEST_ID).length > 0, RESPONSE_TIMEOUT_MS)

    /* The stale replay and the fresh prompt go out in one order on one socket: the fresh prompt
       appearing is what proves the stale frame was delivered and ignored rather than never read. */
    const staleDelivered = firstAnswered && peer.send(selectFrame(REQUEST_ID, TITLE, OPTIONS, "call-t17-stale-permission"))
    const freshDelivered =
      staleDelivered && peer.send(selectFrame(FRESH_ID, FRESH_TITLE, FRESH_OPTIONS, "call-t17-stale-fresh"))
    const freshOnScreen =
      freshDelivered && (await waitForCapture(evidence, (text) => flatScreen(text).includes(FRESH_TITLE_FLAT), SCREEN_TIMEOUT_MS))

    if (freshOnScreen && terminal !== undefined) terminal.write(KEY)
    const freshAnswered = await waitForPeer(peer, () => answersFor(FRESH_ID).length > 0, RESPONSE_TIMEOUT_MS)

    /* The escape control question: it proves the key path the host-close assertion depends on. */
    const liveQuestionDelivered =
      freshAnswered &&
      peer.send(questionFrame(LIVE_QUESTION_ID, LIVE_QUESTION_REQUEST, LIVE_QUESTION_TOOL_CALL, LIVE_QUESTION_HEADER))
    const liveQuestionOnScreen =
      liveQuestionDelivered &&
      (await waitForCapture(
        evidence,
        (text) => flatScreen(text).includes(squash(LIVE_QUESTION_HEADER)),
        SCREEN_TIMEOUT_MS,
      ))
    const liveAnswers = () =>
      peer.responses().filter((frame) => readString(frame, "uiRequestId") === LIVE_QUESTION_ID)
    if (liveQuestionOnScreen && terminal !== undefined) terminal.write("\u001b")
    const liveQuestionCancelled = await waitForPeer(peer, () => liveAnswers().length > 0, RESPONSE_TIMEOUT_MS)

    const questionDelivered =
      liveQuestionCancelled &&
      peer.send(questionFrame(QUESTION_ID, QUESTION_REQUEST, QUESTION_TOOL_CALL, "Deploy target"))
    const questionOnScreen =
      questionDelivered &&
      (await waitForCapture(
        evidence,
        (text) => {
          const flat = flatScreen(text)
          return flat.includes(QUESTION_HEADER_FLAT) && flat.includes(squash("Deploy target"))
        },
        SCREEN_TIMEOUT_MS,
      ))

    const resolvedDelivered =
      questionOnScreen && peer.send(resolvedFrame(QUESTION_REQUEST, QUESTION_TOOL_CALL))
    const hostClosedOnScreen =
      resolvedDelivered &&
      (await waitForCapture(evidence, (text) => flatScreen(text).includes(HOST_CLOSED_FLAT), SCREEN_TIMEOUT_MS))

    const captured = evidence.text()
    /*
     * Nothing may be answerable once both selects settled and the host closed its question. Escape is
     * the key the panel sends `cancelled: true` with for the first live dialog, so a prompt that is
     * still live writes one response. The key path is the proof, not the presence of text: this
     * renderer keeps the glyphs of a control it removed until some other area repaints over them, so
     * "Cancel (sends cancelled: true)" and "Send answers" can survive on the grid after the dialog
     * stopped being answerable.
     */
    const responsesBeforeEscape = peer.responses().length
    if (hostClosedOnScreen && terminal !== undefined) terminal.write("\u001b")
    const escapeAnswered =
      hostClosedOnScreen &&
      (await waitForPeer(peer, () => peer.responses().length > responsesBeforeEscape, SILENCE_TIMEOUT_MS))
    const captureBytes = Buffer.byteLength(captured, "utf8")
    fs.writeFileSync(path.join(context.out, "tui-dialog-stale-pty.txt"), captured, { mode: 0o600 })
    artifacts.push("tui-dialog-stale-pty.txt")

    const screen = await renderScreen(context, captured, artifacts)
    const screenFlat = flatScreen(screen)

    const staleAnswers = answersFor(REQUEST_ID)
    const staleValues = staleAnswers.map((frame) => answeredValue(frame) ?? "(no value)")
    const freshAnswers = answersFor(FRESH_ID)
    const freshValues = freshAnswers.map((frame) => answeredValue(frame) ?? "(no value)")
    const questionAnswers = answersFor(QUESTION_ID)
    const liveQuestionAnswers = liveAnswers()

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
        name: "prompt-answered-once-before-the-replay",
        expected: "exactly one extension_ui_response naming " + REQUEST_ID + " with value '" + CHOSEN + "'",
        observed:
          String(staleAnswers.length) +
          " response(s) before the replay: value=" +
          JSON.stringify(staleValues) +
          "; prompt on screen=" +
          String(promptOnScreen) +
          "; decode=" +
          JSON.stringify(staleAnswers.map(decodeNote)),
        pass: promptOnScreen && firstAnswered && staleAnswers.length === 1 && staleValues[0] === CHOSEN,
      },
      {
        name: "stale-replay-answers-nothing",
        expected:
          "after the same request id is replayed, a second press answers only the live " +
          FRESH_ID +
          " and " +
          REQUEST_ID +
          " keeps its single response",
        observed:
          "stale responses " +
          String(staleAnswers.length) +
          " (values " +
          JSON.stringify(staleValues) +
          "); fresh responses " +
          String(freshAnswers.length) +
          " (values " +
          JSON.stringify(freshValues) +
          "); fresh prompt on screen=" +
          String(freshOnScreen) +
          "; key path proven live=" +
          String(freshAnswered),
        pass:
          firstAnswered &&
          staleDelivered &&
          freshDelivered &&
          freshOnScreen &&
          freshAnswered &&
          staleAnswers.length === 1 &&
          staleValues[0] === CHOSEN &&
          freshAnswers.length === 1 &&
          freshValues[0] === FRESH_CHOSEN,
      },
      {
        name: "escape-cancels-a-live-question",
        expected:
          "the keyboard cancels a live question, so the silence after the host close is a real absence and not a key that never arrives",
        observed:
          "live question on screen " +
          String(liveQuestionOnScreen) +
          ", " +
          String(liveQuestionAnswers.length) +
          " response(s), cancelled: true " +
          String(liveQuestionAnswers.some((frame) => frame["cancelled"] === true)),
        pass:
          liveQuestionOnScreen &&
          liveQuestionAnswers.length === 1 &&
          liveQuestionAnswers[0]?.["cancelled"] === true,
      },
      {
        name: "panel-shows-settled-states",
        expected:
          "both dialogs read as answered on the rendered panel, and neither can be answered from the panel any more",
        observed:
          "stale settled " +
          String(screenFlat.includes(SETTLED_FLAT)) +
          ", fresh settled " +
          String(screenFlat.includes(FRESH_SETTLED_FLAT)) +
          ", escape after both settled wrote " +
          (escapeAnswered ? "a response" : "nothing") +
          ", leftover affordance glyphs on the rendered grid " +
          String(screenFlat.includes(OPEN_AFFORDANCE_FLAT)),
        pass:
          screenFlat.includes(SETTLED_FLAT) &&
          screenFlat.includes(FRESH_SETTLED_FLAT) &&
          hostClosedOnScreen &&
          !escapeAnswered,
      },
      {
        name: "host-close-dismisses-question",
        expected:
          "question_resolved closes the question, the panel reports the host close, and the panel's key path can no longer answer or cancel it",
        observed: hostClosedOnScreen
          ? "host-close line on screen; " +
            String(questionAnswers.length) +
            " response(s) for " +
            QUESTION_ID +
            "; escape after the close wrote " +
            (escapeAnswered ? "a response" : "nothing") +
            "; leftover submit glyphs on the rendered grid " +
            String(screenFlat.includes(QUESTION_SUBMIT_FLAT))
          : "question shown=" +
            String(questionOnScreen) +
            ", resolved sent=" +
            String(resolvedDelivered) +
            "; screen tail: " +
            flatScreen(captured).slice(-160),
        pass:
          questionOnScreen &&
          hostClosedOnScreen &&
          questionAnswers.length === 0 &&
          screenFlat.includes(HOST_CLOSED_FLAT) &&
          !escapeAnswered,
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
