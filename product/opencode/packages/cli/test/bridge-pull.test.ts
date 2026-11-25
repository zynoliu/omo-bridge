import { afterEach, describe, expect, test } from "bun:test"
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { BridgeData } from "../../bridge-core/src/data.ts"
import { SessionRegistry } from "../../bridge-core/src/sessions.ts"
import { JsonlFrameDecoder, encodeFrame } from "../../bridge-core/src/transport.ts"
import {
  BridgeTransportFailure,
  createBridgePromptSender,
  openBridgeTransport,
  pullHostState,
  sendBridgePrompt,
} from "../src/bridge-run.ts"

const DURABLE_ID = "durable-session-1"
const ROUTING_ID = "rpc-1"
const CWD = "/workspace/bridge"
const MODEL = { provider: "anthropic", id: "claude-test" }

const MESSAGES = [
  { role: "user", content: "what is in this file?", timestamp: 1_700_000_000_000 },
  {
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    timestamp: 1_700_000_001_000,
    content: [
      { type: "text", text: "Reading the file now." },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/index.ts" } },
    ],
  },
  {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content: [{ type: "text", text: "export const value = 1" }],
    isError: false,
    timestamp: 1_700_000_002_000,
  },
]

type Frame = Record<string, unknown>

type PeerReply = { readonly success: boolean; readonly data?: unknown; readonly error?: string; readonly errorCode?: string }

type PeerOptions = {
  readonly reply?: (command: string, frame: Frame) => PeerReply | undefined
  readonly messages?: readonly unknown[]
}

type Peer = {
  readonly socket: string
  readonly record: string
  readonly commands: { readonly type: string; readonly frame: Frame }[]
  /** Writes one frame to every live connection, so a test can push what the host would send unprompted. */
  readonly push: (frame: unknown) => number
  readonly stop: () => void
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex")
}

function proof(key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("hex")
}

function startDocumentedPeer(directory: string, options: PeerOptions = {}): Peer {
  const socketPath = path.join(directory, "host.sock")
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

  const commands: { type: string; frame: Frame }[] = []
  const sockets = new Set<{ write: (data: Uint8Array) => unknown }>()
  const connections = new WeakMap<object, { readonly decoder: JsonlFrameDecoder; clientNonce?: string; serverNonce?: string }>()

  const defaults = (command: string): PeerReply | undefined => {
    if (command === "subscribe_sessions") {
      return {
        success: true,
        data: {
          subscriptionId: "sub-1",
          seq: 0,
          hostGeneration: "0",
          hostInstanceId: "instance-1",
          snapshot: [
            {
              type: "session_status",
              subscriptionId: "sub-1",
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
          sessionName: "pulled session",
          model: MODEL,
          thinkingLevel: "medium",
          isStreaming: false,
          messageCount: MESSAGES.length,
        },
      }
    }
    if (command === "get_messages") return { success: true, data: { messages: options.messages ?? MESSAGES } }
    if (command === "get_session_stats")
      return { success: true, data: { tokens: { input: 11, output: 22, cacheRead: 3, cacheWrite: 4 }, cost: 0.5 } }
    if (command === "get_pending_inputs") {
      return {
        success: true,
        data: {
          lifetimeId: "lifetime-1",
          throughCursor: 0,
          inputs: [{ clientMessageId: "c-7", state: "queued", text: "also run the tests", requestedMode: "followUp" }],
        },
      }
    }
    if (command === "prompt") return { success: true }
    return undefined
  }

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        sockets.add(socket)
      },
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
            state.clientNonce = clientNonce
            state.serverNonce = hex(randomBytes(32))
            socket.write(
              encodeFrame({
                id: id,
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
              }),
            )
            continue
          }
          if (type === "authenticate") {
            const received = typeof parsed.client_proof === "string" ? parsed.client_proof : ""
            const expected = proof(key, ["senpi-rpc-client", launchId, state.serverNonce ?? "", state.clientNonce ?? ""])
            const ok =
              /^[0-9a-f]{64}$/.test(received) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"))
            socket.write(encodeFrame({ id: id, type: "response", command: type, success: ok }))
            continue
          }
          commands.push({ type: type, frame: parsed })
          const reply = options.reply?.(type, parsed) ?? defaults(type)
          socket.write(
            encodeFrame(
              reply === undefined
                ? { id: id, type: "response", command: type, success: false, error: "unsupported_command" }
                : { id: id, type: "response", command: type, ...reply },
            ),
          )
        }
      },
      close() {},
      error() {},
    },
  })

  return {
    socket: socketPath,
    record: record,
    commands: commands,
    push: (frame) => {
      let sent = 0
      for (const socket of sockets) {
        socket.write(encodeFrame(frame))
        sent += 1
      }
      return sent
    },
    stop: () => {
      server.stop(true)
    },
  }
}

function isRecord(value: unknown): value is Frame {
  if (typeof value !== "object" || value === null) return false
  return !Array.isArray(value)
}

const directories: string[] = []
const peers: Peer[] = []

afterEach(() => {
  for (const peer of peers.splice(0)) peer.stop()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function layout(messages?: readonly unknown[]): { readonly directory: string; readonly peer: Peer } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pull-"))
  directories.push(directory)
  const peer = startDocumentedPeer(directory, messages === undefined ? {} : { messages: messages })
  peers.push(peer)
  return { directory: directory, peer: peer }
}

function options(directory: string, peer: Peer) {
  return {
    socket: peer.socket,
    keyRecord: peer.record,
    cwd: CWD,
    mini: false,
    handshakeTimeoutMs: 5_000,
  }
}

describe("bridge host pull path", () => {
  test("a response no transport request asked for is forwarded instead of dropped", async () => {
    const fixture = layout()
    const frames: unknown[] = []
    const transport = await openBridgeTransport(options(fixture.directory, fixture.peer), (frame) => frames.push(frame))
    try {
      /* The extension correlator writes its own ids; the host answers those with the same response shape,
         and a transport that only resolves its own ids left every extension request timing out. */
      const sent = fixture.peer.push({ id: "mcp-reply-1", type: "response", success: false, error: "unknown request" })
      expect(sent).toBe(1)
      const deadline = Date.now() + 5_000
      while (frames.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(frames).toEqual([{ id: "mcp-reply-1", type: "response", success: false, error: "unknown request" }])
    } finally {
      transport.close()
    }
  })

  test("after authentication the pull lands the session, its transcript and its pending inputs in BridgeData", async () => {
    const fixture = layout()
    const transport = await openBridgeTransport(options(fixture.directory, fixture.peer))
    try {
      expect(transport.report.state).toBe("authenticated")
      const data = new BridgeData()
      const outcome = await pullHostState(transport, data)
      expect(outcome.subscriptionId).toBe("sub-1")
      expect(outcome.sessionIds).toEqual([DURABLE_ID])
      /* The snapshot is the only place a quiet host announces a session, so its routing handle has to
         leave the pull with it; `session.prompt` addresses the host by that handle. */
      expect(outcome.statuses.map((status) => status.routingId)).toEqual([ROUTING_ID])
      expect(outcome.messages).toBe(2)

      const sessions = data.hostSessionList()
      expect(sessions.map((session) => session.id)).toEqual([DURABLE_ID])
      const session = sessions[0]
      expect(session?.title).toBe("pulled session")
      expect(session?.location.directory).toBe(CWD)
      expect(session?.model).toEqual({ providerID: "anthropic", id: "claude-test", variant: "medium" })
      /* The composer reads effort from the session's model variant, which is the host's own level. */
      expect(data.hostThinkingFor(DURABLE_ID)?.level).toBe("medium")
      /* The session row carries the host's accounting rather than zeros that look unmeasured. */
      expect(session?.tokens.input).toBe(11)
      expect(session?.tokens.output).toBe(22)
      expect(session?.tokens.cache.read).toBe(3)
      expect(session?.tokens.cache.write).toBe(4)
      expect(session?.cost).toBe(0.5)
      expect(session?.time.created).toBe(1_700_000_000_000)
      expect(session?.time.updated).toBe(1_700_000_002_000)

      const messages = data.hostMessagesFor(DURABLE_ID)
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
      const user = messages[0]
      expect(user?.type === "user" ? user.text : undefined).toBe("what is in this file?")
      const assistant = messages[1]
      if (assistant === undefined || assistant.type !== "assistant") throw new Error("the assistant message was not projected")
      expect(assistant.model).toEqual({ providerID: "anthropic", id: "claude-test" })
      const text = assistant.content.find((part) => part.type === "text")
      expect(text?.type === "text" ? text.text : undefined).toBe("Reading the file now.")
      const tool = assistant.content.find((part) => part.type === "tool")
      if (tool === undefined || tool.type !== "tool") throw new Error("the tool call was not projected")
      expect(tool.name).toBe("read")
      expect(tool.state.status).toBe("completed")
      expect(tool.state.status === "completed" ? tool.state.content[0] : undefined).toEqual({
        type: "text",
        text: "export const value = 1",
      })

      expect(data.pendingInputsFor(DURABLE_ID)).toEqual([
        { clientMessageId: "c-7", state: "queued", text: "also run the tests", requestedMode: "followUp" },
      ])

      const pulled = fixture.peer.commands.map((command) => command.type)
      /* the session tree pull follows the transcript; this peer refuses it, which stays non-fatal */
      /* The catalogue is requested after the transcript: without it the model picker has nothing to show. */
      expect(pulled).toEqual([
        "subscribe_sessions",
        "get_state",
        "get_available_thinking_levels",
        "get_model_thinking_level",
        "get_messages",
        "get_pending_inputs",
        "get_session_stats",
        "get_entries",
        "get_available_models",
      ])
      expect(fixture.peer.commands.every((command) => command.frame.sessionId === ROUTING_ID || command.type === "subscribe_sessions")).toBe(true)
    } finally {
      transport.close()
    }
  })

  test("a failed tool result is projected as an error state rather than a completed one", async () => {
    const fixture = layout([
      { role: "user", content: "delete the missing file", timestamp: 1_700_000_000_000 },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-test",
        timestamp: 1_700_000_001_000,
        content: [{ type: "toolCall", id: "call_fail", name: "bash", arguments: { command: "rm missing.txt" } }],
      },
      {
        role: "toolResult",
        toolCallId: "call_fail",
        toolName: "bash",
        content: [{ type: "text", text: "rm: missing.txt: No such file or directory" }],
        isError: true,
        timestamp: 1_700_000_002_000,
      },
    ])
    const transport = await openBridgeTransport(options(fixture.directory, fixture.peer))
    try {
      const data = new BridgeData()
      await pullHostState(transport, data)
      const assistant = data.hostMessagesFor(DURABLE_ID).find((message) => message.type === "assistant")
      if (assistant === undefined || assistant.type !== "assistant") throw new Error("the assistant message was not projected")
      const tool = assistant.content.find((part) => part.type === "tool")
      if (tool === undefined || tool.type !== "tool") throw new Error("the tool call was not projected")
      expect(tool.state.status).toBe("error")
      expect(tool.state.status === "error" ? tool.state.error.message : undefined).toBe(
        "rm: missing.txt: No such file or directory",
      )
      expect(tool.state.status === "error" ? tool.state.content?.[0] : undefined).toEqual({
        type: "text",
        text: "rm: missing.txt: No such file or directory",
      })
    } finally {
      transport.close()
    }
  })

  test("a refused response surfaces as pull_failed naming the command instead of silence", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pull-"))
    directories.push(directory)
    const peer = startDocumentedPeer(directory, {
      reply: (command) =>
        command === "get_messages"
          ? { success: false, error: "session_not_attached", errorCode: "session_not_attached" }
          : undefined,
    })
    peers.push(peer)
    const transport = await openBridgeTransport(options(directory, peer))
    try {
      const failure = await pullHostState(transport, new BridgeData()).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(BridgeTransportFailure)
      if (!(failure instanceof BridgeTransportFailure)) throw new Error("the pull did not fail with a bridge failure")
      expect(failure.code).toBe("pull_failed")
      expect(failure.message).toContain("get_messages")
      expect(failure.message).toContain("session_not_attached")
    } finally {
      transport.close()
    }
  })

  test("a submitted prompt is written as the documented prompt frame", async () => {
    const fixture = layout()
    const transport = await openBridgeTransport(options(fixture.directory, fixture.peer))
    try {
      await sendBridgePrompt(transport, { sessionId: ROUTING_ID, message: "Hello, world!" })
      const prompts = fixture.peer.commands.filter((command) => command.type === "prompt")
      expect(prompts).toHaveLength(1)
      const frame = prompts[0]?.frame
      expect(frame?.type).toBe("prompt")
      expect(frame?.sessionId).toBe(ROUTING_ID)
      expect(frame?.message).toBe("Hello, world!")
      expect(typeof frame?.id).toBe("string")
      expect(Object.keys(frame ?? {}).sort()).toEqual(["id", "message", "sessionId", "type"])
      await sendBridgePrompt(transport, {
        sessionId: ROUTING_ID,
        message: "What is in this image?",
        images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      })
      const withImage = fixture.peer.commands.filter((command) => command.type === "prompt")[1]?.frame
      expect(withImage?.images).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }])
    } finally {
      transport.close()
    }
  })

  test("the injected sender writes the documented frame and refreshes through the pull path", async () => {
    const fixture = layout()
    const transport = await openBridgeTransport(options(fixture.directory, fixture.peer))
    try {
      const data = new BridgeData()
      const send = createBridgePromptSender({
        transport: () => transport,
        data: data,
        sessions: new SessionRegistry(),
        routingId: (durableId) => (durableId === DURABLE_ID ? ROUTING_ID : undefined),
        status: (durableId) =>
          durableId === DURABLE_ID
            ? {
                routingId: ROUTING_ID,
                durableId: DURABLE_ID,
                directory: CWD,
                status: "idle",
                model: { providerID: "anthropic", id: "claude-test" },
              }
            : undefined,
      })
      const before = fixture.peer.commands.length
      await send({ sessionID: DURABLE_ID, text: "Hello, world!", clientMessageId: "client-message-1", delivery: "steer" })
      const written = fixture.peer.commands.slice(before)
      expect(written[0]?.type).toBe("prompt")
      expect(Object.keys(written[0]?.frame ?? {}).sort()).toEqual([
        "clientMessageId",
        "id",
        "message",
        "sessionId",
        "streamingBehavior",
        "type",
      ])
      expect(written[0]?.frame.message).toBe("Hello, world!")
      /* The acknowledgement is followed by the same per-session pull the launcher ran at startup. */
      expect(written.map((command) => command.type)).toEqual([
        "prompt",
        "get_state",
        "get_available_thinking_levels",
        "get_model_thinking_level",
        "get_messages",
        "get_pending_inputs",
        "get_session_stats",
        "get_entries",
      ])
      expect(data.hostMessagesFor(DURABLE_ID).map((message) => message.type)).toEqual(["user", "assistant"])
    } finally {
      transport.close()
    }
  })

  test("a refused prompt rejects with prompt_failed and refreshes nothing", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-pull-"))
    directories.push(directory)
    const peer = startDocumentedPeer(directory, {
      reply: (command) =>
        command === "prompt"
          ? { success: false, error: "the model is unavailable", errorCode: "provider_unavailable" }
          : undefined,
    })
    peers.push(peer)
    const transport = await openBridgeTransport(options(directory, peer))
    try {
      const data = new BridgeData()
      const failure = await createBridgePromptSender({
        transport: () => transport,
        data: data,
        sessions: new SessionRegistry(),
        routingId: () => ROUTING_ID,
        status: () => undefined,
      })({ sessionID: DURABLE_ID, text: "Hello", clientMessageId: "client-message-2", delivery: "queue" }).catch(
        (error: unknown) => error,
      )
      expect(failure).toBeInstanceOf(BridgeTransportFailure)
      if (!(failure instanceof BridgeTransportFailure)) throw new Error("the prompt did not fail with a bridge failure")
      expect(failure.code).toBe("prompt_failed")
      expect(failure.message).toContain("provider_unavailable")
      expect(peer.commands.map((command) => command.type)).toEqual(["prompt"])
      expect(data.hostMessagesFor(DURABLE_ID)).toEqual([])
    } finally {
      transport.close()
    }
  })

  test("the sender refuses before writing when the transport is closed or the session was never announced", async () => {
    const data = new BridgeData()
    const closed = await createBridgePromptSender({
      transport: () => undefined,
      data: data,
      sessions: new SessionRegistry(),
      routingId: () => ROUTING_ID,
      status: () => undefined,
    })({ sessionID: DURABLE_ID, text: "Hello", clientMessageId: "client-message-3", delivery: "queue" }).catch(
      (error: unknown) => error,
    )
    expect(closed).toBeInstanceOf(BridgeTransportFailure)
    if (!(closed instanceof BridgeTransportFailure)) throw new Error("the closed transport did not refuse")
    expect(closed.code).toBe("stream_closed")

    const fixture = layout()
    const transport = await openBridgeTransport(options(fixture.directory, fixture.peer))
    try {
      const unknown = await createBridgePromptSender({
        transport: () => transport,
        data: data,
        sessions: new SessionRegistry(),
        routingId: () => undefined,
        status: () => undefined,
      })({ sessionID: "never-announced", text: "Hello", clientMessageId: "client-message-4", delivery: "queue" }).catch(
        (error: unknown) => error,
      )
      expect(unknown).toBeInstanceOf(BridgeTransportFailure)
      if (!(unknown instanceof BridgeTransportFailure)) throw new Error("the unknown session did not refuse")
      expect(unknown.code).toBe("pull_failed")
      expect(unknown.message).toContain("never-announced")
      expect(fixture.peer.commands).toEqual([])
    } finally {
      transport.close()
    }
  })
})
