import { Service, type Endpoint } from "@opencode/client/effect/service"
import { ClientError, OpenCode, type OpenCodeClient } from "@opencode/client/promise"
import type { MiniFrontendInput } from "@opencode/tui/mini"
import { noTimeoutFetch } from "@opencode/util/no-timeout-fetch"
import { setTimeout } from "node:timers/promises"
import { readStdin } from "./util/io"
import { createMiniHost, INTERACTIVE_INPUT_ERROR, usingInteractiveStdin, type InteractiveStdin } from "./mini-host"
import { parseSessionTargetModel, resolveSessionTarget, type SessionTargetPreparation } from "./session-target"
import { Env } from "./env"
import { BridgeData } from "../../bridge-core/src/data.ts"
import { DialogRegistry } from "../../bridge-core/src/dialogs.ts"
import { InteractionController } from "../../bridge-core/src/interaction.ts"
import { SessionRegistry } from "../../bridge-core/src/sessions.ts"
import { createMiniBridgeClient, resolveMiniBridgeTarget } from "../../tui/src/mini/bridge"
import type { BridgeConnectionState } from "./bridge-entry"

/**
 * The transport the launcher hands Mini: already dialled and authenticated, writing frames on the
 * caller's socket. `bridge-run`'s `openBridgeTransport` is the current implementation; keeping it
 * injected is what stops the Mini evaluation graph from pulling in the main TUI.
 */
/**
 * What Mini needs from the bridge: an already-authenticated transport and the store its frames land in.
 */
export type MiniBridgeInput = {
  readonly data?: BridgeData
  readonly connect: (onFrame: (frame: unknown) => void) => Promise<MiniBridgeTransport>
}

export type MiniBridgeTransport = {
  readonly report: {
    readonly state: "authenticated" | "unproven" | "failed"
    readonly code: string
    readonly detail: string
  }
  readonly send: (frame: unknown) => void
  readonly close: () => void
}



export type MiniCommandInput = {
  /** Absent in bridge mode: the in-process adapter replaces the HTTP client. */
  server?: {
    endpoint: Endpoint
    reconnect?: (signal: AbortSignal) => Promise<Endpoint>
  }
  /** When present, Mini runs against the authenticated host socket instead of a service endpoint. */
  bridge?: MiniBridgeInput
  continue?: boolean
  session?: string
  fork?: boolean
  model?: string
  agent?: string
  prompt?: string
  replay?: boolean
  replayLimit?: number
  demo?: boolean
  tuiConfig?: MiniFrontendInput["tuiConfig"]
  config?: MiniFrontendInput["config"]
  paths: { home: string; state: string; log: string }
}

type Model = MiniFrontendInput["model"]

class MiniInputError extends Error {}

export async function runMini(input: MiniCommandInput) {
  try {
    validate(input)
    await usingInteractiveStdin(async (terminal) => {
      const initialInput = mergeInput(process.stdin.isTTY ? undefined : await readStdin(), input.prompt)
      const directory = localDirectory()
      if (input.bridge !== undefined) {
        return runMiniBridge({
          input: input,
          bridge: input.bridge,
          terminal: terminal,
          directory: directory,
          initialInput: initialInput,
        })
      }
      const server = input.server
      if (server === undefined) throw new MiniInputError("opencode mini requires a server endpoint or a bridge connection")
      const frontendTask = import("@opencode/tui/mini")
      const connection = createMiniConnection(server)
      const sdk = connection.sdk
      const environment = server.reconnect ? Env.session() : undefined
      const requested = parseModel(input.model)
      const model = requested ? { providerID: requested.providerID, modelID: requested.id } : undefined
      const prepare = prepareTarget(input.agent)
      const resolveTarget = async (initial: OpenCodeClient, signal: AbortSignal) => {
        const resolved = await resolveMiniTarget({
          sdk: initial,
          reconnect: connection.reconnect,
          signal,
          resolve: (client) =>
            resolveSessionTarget({
              client,
              location: { directory },
              continue: input.continue,
              session: input.session,
              fork: input.fork,
              model: requested,
              agent: input.agent,
              environment,
              prepare,
              signal,
            }).catch((error) => {
              if (error instanceof Error && error.message === "Session not found")
                throw new MiniInputError(error.message)
              throw error
            }),
        })
        const target = resolved.value
        return {
          sdk: resolved.sdk,
          sessionID: target.session.id,
          sessionTitle: target.session.title,
          location: target.location,
          model: target.model ? { providerID: target.model.providerID, modelID: target.model.id } : undefined,
          variant: target.model?.variant,
          agent: target.agent,
          resume: target.resume,
        }
      }
      const create = (
        client: OpenCodeClient,
        next: {
          location: { directory: string }
          agent: string | undefined
          model: Model
          variant: string | undefined
        },
        signal?: AbortSignal,
      ) =>
        resolveSessionTarget({
          client,
          location: { directory: next.location.directory },
          agent: next.agent,
          environment,
          model: next.model
            ? { providerID: next.model.providerID, id: next.model.modelID, variant: next.variant }
            : undefined,
          prepare,
          signal,
        }).then((target) => ({
          sessionID: target.session.id,
          sessionTitle: target.session.title,
          location: target.location,
          model: target.model ? { providerID: target.model.providerID, modelID: target.model.id } : undefined,
          variant: target.model?.variant,
          agent: target.agent,
          resume: false,
        }))
      const frontend = await frontendTask
      return frontend.runMiniFrontend({
        host: createMiniHost({ terminal, directory, paths: input.paths }),
        sdk,
        directory,
        target: resolveTarget,
        reconnect: connection.reconnect,
        createSession: create,
        agent: input.agent,
        model,
        variant: requested?.variant,
        files: [],
        initialInput,
        replay: input.replay ?? true,
        replayLimit: input.replayLimit,
        demo: input.demo,
        tuiConfig: input.tuiConfig,
        config: input.config,
      })
    })
  } catch (error) {
    if (error instanceof MiniInputError || (error instanceof Error && error.message === INTERACTIVE_INPUT_ERROR))
      fail(error.message)
    throw error
  }
}

async function runMiniBridge(context: {
  input: MiniCommandInput
  bridge: MiniBridgeInput
  terminal: InteractiveStdin
  directory: string
  initialInput: string | undefined
}) {
  const data = context.bridge.data ?? new BridgeData()
  const transport = await context.bridge.connect((frame) => data.publishEvent(frame))
  if (transport.report.state !== "authenticated") {
    transport.close()
    throw new MiniInputError(bridgeFailure(transport.report))
  }
  const requested = parseModel(context.input.model)
  let connection: BridgeConnectionState = "ready"
  const seam = createMiniBridgeClient({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: context.directory },
    connection: () => connection,
    reconnect: async (signal) => {
      connection = "connecting"
      const next = await context.bridge.connect((frame) => data.publishEvent(frame))
      if (next.report.state !== "authenticated") {
        next.close()
        connection = "failed"
        throw new MiniInputError(bridgeFailure(next.report))
      }
      seam.adapter.tuiData.hostDialogs.useSender(next.send)
      connection = "ready"
      return connection
    },
  })
  seam.adapter.tuiData.hostDialogs.useSender(transport.send)

  const frontend = await import("@opencode/tui/mini")
  return frontend.runMiniFrontend({
    host: createMiniHost({ terminal: context.terminal, directory: context.directory, paths: context.input.paths }),
    sdk: seam.sdk,
    directory: context.directory,
    target: async () =>
      resolveMiniBridgeTarget({
        data: data,
        sessionID: context.input.session,
        agent: context.input.agent,
        model:
          requested === undefined
            ? undefined
            : { providerID: requested.providerID, modelID: requested.id, variant: requested.variant },
      }),
    reconnect: async (signal: AbortSignal) => {
      await seam.reconnect(signal)
      return seam.sdk
    },
    agent: context.input.agent,
    model: requested === undefined ? undefined : { providerID: requested.providerID, modelID: requested.id },
    variant: requested?.variant,
    files: [],
    initialInput: context.initialInput,
    replay: context.input.replay ?? true,
    replayLimit: context.input.replayLimit,
    tuiConfig: context.input.tuiConfig,
    config: context.input.config,
  })
}

function bridgeFailure(report: MiniBridgeTransport["report"]): string {
  return "bridge " + report.state + ": " + report.code + (report.detail.length === 0 ? "" : ": " + report.detail)
}

/** @internal Exported for CLI boundary tests. */
export function createMiniConnection(input: NonNullable<MiniCommandInput["server"]>) {
  const make = (endpoint: Endpoint) =>
    OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
      // Session waits can remain idle until background work finishes.
      fetch: noTimeoutFetch,
    })
  const reconnect = input.reconnect
  return {
    sdk: make(input.endpoint),
    reconnect: reconnect
      ? async (signal: AbortSignal) => {
          const endpoint = await reconnect(signal)
          return make(endpoint)
        }
      : undefined,
  }
}

/** @internal Exported for reconnect lifecycle tests. */
export async function resolveMiniTarget<A>(input: {
  sdk: OpenCodeClient
  reconnect?: (signal: AbortSignal) => Promise<OpenCodeClient>
  signal: AbortSignal
  resolve: (sdk: OpenCodeClient) => Promise<A>
}) {
  let sdk = input.sdk
  while (true) {
    try {
      return { sdk, value: await input.resolve(sdk) }
    } catch (error) {
      if (!input.reconnect || !(error instanceof ClientError) || error.reason !== "Transport") throw error
      while (true) {
        try {
          sdk = await input.reconnect(input.signal)
          break
        } catch (resolveError) {
          if (input.signal.aborted) throw resolveError
          await setTimeout(250, undefined, { signal: input.signal })
        }
      }
    }
  }
}

export function validateMiniTerminal() {
  if (!process.stdout.isTTY) fail("opencode mini requires a TTY stdout")
}

/** @internal Exported for testing. */
export function mergeInput(piped: string | undefined, prompt: string | undefined) {
  if (!prompt) return piped || undefined
  if (!piped) return prompt
  return piped + "\n" + prompt
}

function validate(input: MiniCommandInput) {
  validateMiniTerminal()
  if (input.replayLimit !== undefined && (!Number.isInteger(input.replayLimit) || input.replayLimit <= 0)) {
    fail("--replay-limit must be a positive integer")
  }
  if (input.fork && !input.continue && !input.session) fail("--fork requires --continue or --session")
}

function localDirectory(): string {
  const root = process.env.PWD ?? process.cwd()
  try {
    process.chdir(root)
    return process.cwd()
  } catch {
    throw new MiniInputError(`Failed to change directory to ${root}`)
  }
}

function parseModel(value?: string) {
  try {
    return parseSessionTargetModel(value)
  } catch {
    throw new MiniInputError("--model must use the format provider/model[#variant]")
  }
}

function prepareTarget(requestedAgent?: string): SessionTargetPreparation {
  return async (input) => ({ model: input.model, agent: requestedAgent ?? input.agent })
}

function fail(message: string): never {
  process.stderr.write(`\x1b[91m\x1b[1mError: \x1b[0m${message}\n`)
  process.exit(1)
}
