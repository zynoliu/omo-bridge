import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

import type { CaseContext, CaseResult, Check } from "../run.ts"
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts"

const READY_TIMEOUT_MS = 20_000
const LAYOUT_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 5_000
const HOME_MARKERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"]

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
  readonly observed: {
    infoReceived: boolean
    serverProofSent: boolean
    authenticateReceived: boolean
    clientProofVerified: boolean
  }
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

  const observed = {
    infoReceived: false,
    serverProofSent: false,
    authenticateReceived: false,
    clientProofVerified: false,
  }
  const connections = new WeakMap<object, PeerState>()

  const answer = (socket: { write(chunk: Uint8Array): unknown }, frame: Record<string, unknown>) => {
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
            const serverProof = proof(key, ["senpi-rpc-server", launchId, clientNonce, state.serverNonce])
            observed.serverProofSent = true
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
            observed.authenticateReceived = true
            const received = typeof parsed.client_proof === "string" ? parsed.client_proof : ""
            const expected = proof(key, [
              "senpi-rpc-client",
              launchId,
              state.serverNonce ?? "",
              state.clientNonce ?? "",
            ])
            const ok =
              /^[0-9a-f]{64}$/.test(received) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
            if (ok) observed.clientProofVerified = true
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: ok,
              ...(ok ? {} : { error: "auth_failed" }),
            })
            continue
          }
          /* The pull a real launch performs: one session, no messages, no pending input, no branch, and a
             catalogue the host describes per session. Answering these is what makes the two launch checks
             below meaningful; refusing them only ever exercised the failure path. */
          if (type === "subscribe_sessions") {
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: true,
              data: {
                subscriptionId: "sub-bootstrap",
                snapshot: [{ type: "session_status", sessionId: "rpc-1", durableSessionId: "rpc-1", cwd: "/work", status: "idle" }],
              },
            })
            continue
          }
          if (type === "get_state") {
            answer(socket, { id, type: "response", command: type, success: true, data: { sessionId: "rpc-1", sessionName: "Bootstrap", isStreaming: false } })
            continue
          }
          if (type === "get_messages") {
            answer(socket, { id, type: "response", command: type, success: true, data: { messages: [] } })
            continue
          }
          if (type === "get_pending_inputs") {
            answer(socket, { id, type: "response", command: type, success: true, data: { inputs: [] } })
            continue
          }
          if (type === "get_entries") {
            answer(socket, { id, type: "response", command: type, success: true, data: { entries: [], leafId: null } })
            continue
          }
          if (type === "get_available_models") {
            answer(socket, { id, type: "response", command: type, success: true, data: { models: [] } })
            continue
          }
          answer(socket, { id, type: "response", command: type, success: false, error: "unsupported_command" })
        }
      },
      close() {},
      error() {},
    },
  })

  return { socket: socketPath, record: record, launchId: launchId, server: server, observed: observed }
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
    // The TUI's JSX runtime resolves through the CLI package's tsconfig, as in `bun run dev`.
    cwd: path.join(qaRoot, "..", "..", "packages", "cli"),
    terminal: {
      cols: 120,
      rows: 40,
      data(_terminal, chunk) {
        target.push(chunk)
      },
    },
    env: { ...process.env, TERM: "xterm-256color" },
  })
}

async function stop(proc: ReturnType<typeof spawnLauncher>): Promise<string> {
  proc.kill()
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ])
  return exited ? "child exited" : "child did not exit within " + EXIT_TIMEOUT_MS + "ms"
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock")
  const absentSocket = path.join(context.out, "absent.sock")
  const peer = startPeer(context.out, socketPath)
  const evidence = capture()
  const absentEvidence = capture()
  const children: ReturnType<typeof spawnLauncher>[] = []
  const cleanupDetail: string[] = []
  const artifacts: string[] = []
  let checks: Check[] = []

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.record, evidence)
    children.push(launcher)
    await waitFor(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const launchState = (evidence.text().match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const reportsReady = launchState === "ready"
    const layout =
      reportsReady &&
      (await waitFor(evidence, (text) => HOME_MARKERS.some((marker) => plain(text).includes(marker)), LAYOUT_TIMEOUT_MS))

    const absenceLauncher = spawnLauncher(context.qaRoot, absentSocket, peer.record, absentEvidence)
    children.push(absenceLauncher)
    const absenceAnswered = await waitFor(absentEvidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS)
    const absenceState = (absentEvidence.text().match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none"
    const absentFailed = absenceAnswered && absenceState === "failed" && !/BRIDGE_STATE=ready/.test(absentEvidence.text())

    const captured = evidence.text()
    const captureBytes = Buffer.byteLength(captured, "utf8")
    fs.writeFileSync(path.join(context.out, "tui-bootstrap-pty.txt"), captured, { mode: 0o600 })
    fs.writeFileSync(path.join(context.out, "tui-bootstrap-absent-pty.txt"), absentEvidence.text(), { mode: 0o600 })
    artifacts.push("tui-bootstrap-pty.txt", "tui-bootstrap-absent-pty.txt")

    const screen = plain(captured)
    const visible = HOME_MARKERS.filter((marker) => screen.includes(marker))
    const crash = screen.indexOf("OpenCode crashed")

    checks = [
      {
        name: "host-proof-exchange",
        expected: "the peer answers get_protocol_info with data.auth and the client returns a valid client_proof",
        observed:
          "info=" +
          String(peer.observed.infoReceived) +
          " serverProof=" +
          String(peer.observed.serverProofSent) +
          " authenticate=" +
          String(peer.observed.authenticateReceived) +
          " clientProof=" +
          String(peer.observed.clientProofVerified),
        pass:
          peer.observed.infoReceived &&
          peer.observed.serverProofSent &&
          peer.observed.authenticateReceived &&
          peer.observed.clientProofVerified,
      },
      {
        name: "launcher-reports-ready",
        expected: "BRIDGE_STATE=ready after the handshake, never failed",
        observed: "BRIDGE_STATE=" + launchState,
        pass: reportsReady,
      },
      {
        name: "main-layout-rendered",
        expected: "the home composer text appears in the PTY stream",
        observed: layout
          ? "layout marker(s): " + visible.join(", ")
          : crash >= 0
            ? "crash screen: " + screen.slice(crash, crash + 200).replace(/\s+/g, " ").trim()
            : "no layout marker; screen tail: " + screen.slice(-200).replace(/\s+/g, " ").trim(),
        pass: layout,
      },
      {
        name: "absent-socket-reports-failed",
        expected: "BRIDGE_STATE=failed and never ready when no socket is listening",
        observed: "BRIDGE_STATE=" + absenceState,
        pass: absentFailed,
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture under the evidence directory",
        observed: String(captureBytes) + " bytes",
        pass: captureBytes > 0,
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
    (entry) => !entry.includes("did not exit") && !entry.includes("still present") && !entry.includes("could not") ,
  )
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts }
}
