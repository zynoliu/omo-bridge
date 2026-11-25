// The Mini (direct interactive mode) seam over the shared bridge adapter.
//
// Mini builds its own OpenCode promise client in `packages/cli/src/mini.ts`
// (`OpenCode.make({ baseUrl })`). That client talks HTTP to a local service; the
// bridge has no HTTP endpoint at all. This module supplies the promise-shaped
// client Mini expects on top of the same in-process adapter the main TUI uses
// (`packages/tui/src/context/bridge.ts`): one BridgeData, one SessionRegistry,
// one DialogRegistry, one InteractionController, and the host dialogue store the
// launcher writes through.
//
// The split between what is answered and what refuses is deliberate:
//
// - catalog and history are answered from the payloads the host delivered, so an
//   entry the host never sent is `UnsupportedCapability`, never an empty list;
// - a permission answer is written with the one frame the host is verified to
//   accept (`extension_ui_response`), through the documented labels;
// - a prompt submission is recorded in the bridge's own turn/queue model and
//   handed to the launcher's writer. The seam itself never encodes a host
//   request frame, because the host's prompt request is not established in this
//   tree; without a writer the operation refuses rather than pretending;
// - the OpenCode V2 event stream, session creation, shell execution and form
//   replies have no verified host write path, so they refuse loudly instead of
//   inventing payloads that would render as real host state.
//
// Abort and reconnect act on the shared registries: abort ends the active turn,
// reconnect asks the launcher to redial and records the recovery decision. Neither
// replays a submission.
import type {
  LocationGetOutput,
  LocationRef,
  OpenCodeClient,
  PermissionReplyInput,
  SessionInfo,
  SessionInterruptInput,
  SessionInterruptResponse,
} from "@opencode/client/promise"

import { UnsupportedCapability } from "../../../bridge-core/src/client.ts"
import { applyFormEvent, applyPermissionEvent, decodeHostEvent } from "../../../bridge-core/src/host-event.ts"
import type { HostDialogRequestFrame } from "../../../bridge-core/src/dialogs-host.ts"
import type { SelectRequestFrame } from "../../../bridge-core/src/host-frames.ts"
import { assertNoSilentReplay, planRecovery } from "../../../bridge-core/src/recovery.ts"
import type { RecoveryDecision } from "../../../bridge-core/src/recovery.ts"
import type { BridgeData } from "../../../bridge-core/src/data.ts"
import type { DialogRegistry, InteractionController, QueuedInput, SessionRegistry } from "../../../bridge-core/src/index.ts"
import { createBridgeTuiContext } from "../context/bridge.ts"
import type { BridgeTuiContext } from "../context/bridge.ts"

/** The connection-state contract the shared adapter's factory already declares. */
type BridgeConnection = Parameters<typeof createBridgeTuiContext>[1]
type BridgeConnectionState = ReturnType<BridgeConnection>

/**
 * The labels the permission prompt offers, exactly as the host writes them
 * (`packages/bridge-core/spec/host-frame-vocabulary.md`, section (a)). A decision
 * is only answerable with a label the open dialog actually carries.
 */
const PERMISSION_DECISION_LABELS = {
  once: "Allow once",
  always: "Allow always",
  reject: "Deny",
} as const

/** One input the bridge accepted into its turn queue, on its way to the launcher. */
export type MiniBridgeSubmission = {
  readonly sessionID: string
  readonly turn: string
  readonly kind: "steer" | "follow_up"
  readonly text: string
}

/**
 * The launcher's prompt writer. The bridge owns the queue and the turn; the
 * launcher owns the socket and therefore the host's request shape.
 */
export type MiniBridgeWriter = (submission: MiniBridgeSubmission) => void

/** A submission the bridge's own turn model refused; the code is the bridge's failure code. */
export class MiniBridgeRefusal extends Error {
  readonly code: string

  constructor(code: string) {
    super("MINI_BRIDGE_REFUSED: " + code)
    this.name = "MiniBridgeRefusal"
    this.code = code
  }
}

export type MiniBridgeOptions = {
  readonly data: BridgeData
  readonly sessions: SessionRegistry
  readonly dialogs: DialogRegistry
  readonly interaction: InteractionController
  readonly defaultLocation: LocationRef
  readonly connection: BridgeConnection
  /** Absent when the launcher has no verified host prompt request to write. */
  readonly write?: MiniBridgeWriter
  /** Redials the host socket; absent when the launcher cannot redial. */
  readonly reconnect?: (signal: AbortSignal) => Promise<BridgeConnectionState>
}

export type MiniBridgeState = {
  readonly connection: BridgeConnectionState
  readonly turn: string | null
  readonly queue: readonly QueuedInput[]
  readonly aborted: readonly string[]
  readonly recovery: RecoveryDecision | null
}

export type MiniBridgeSeam = {
  /** The shared adapter the main TUI also consumes. */
  readonly adapter: BridgeTuiContext
  /** The promise-shaped client Mini is given instead of the HTTP client. */
  readonly sdk: OpenCodeClient
  /** Records one prompt in the bridge turn queue and hands it to the launcher. */
  readonly submitPrompt: (input: {
    readonly sessionID: string
    readonly text: string
    readonly kind?: "steer" | "follow_up"
  }) => MiniBridgeSubmission
  /** Ends the active turn; false when there is nothing to abort for this session. */
  readonly abort: (sessionID: string) => boolean
  /** Redials through the launcher and records the recovery decision; it never replays input. */
  readonly reconnect: (signal: AbortSignal) => Promise<MiniBridgeState>
  readonly state: () => MiniBridgeState
}

export function createMiniBridgeClient(options: MiniBridgeOptions): MiniBridgeSeam {
  const adapter = createBridgeTuiContext(
    {
      data: options.data,
      defaultLocation: options.defaultLocation,
      sessions: options.sessions,
      dialogs: options.dialogs,
      interaction: options.interaction,
    },
    options.connection,
  )
  let recovery: RecoveryDecision | null = null
  let turnSession: string | null = null

  /* the bridge's own stream vocabulary projects into the message view, so Mini's
     history and tool reads answer from the same state the main TUI renders */
  options.data.subscribeEvents((frame) => {
    const decoded = decodeHostEvent(frame)
    if (decoded.ok) {
      applyPermissionEvent(options.data, decoded.event)
      applyFormEvent(options.data, decoded.event)
      return
    }
    if (isStreamFrame(frame)) options.data.applyEvent(frame)
  })

  const catalog = <Value>(name: string, read: () => Value[] | undefined, directory: string | undefined) => {
    const entries = read()
    /* an undelivered catalogue is not an empty one */
    if (entries === undefined) throw new UnsupportedCapability("catalog." + name)
    return { location: { directory: directory ?? options.defaultLocation.directory }, data: [...entries] }
  }

  const answerPermission = (input: PermissionReplyInput): void => {
    /* "Deny with feedback" opens a second `input` dialog; the bridge does not drive it */
    if (input.message !== undefined) throw new UnsupportedCapability("permission.reply:feedback")
    const dialog = adapter.tuiData.hostDialogs
      .list()
      .filter(isSelectDialog)
      .find((candidate) => candidate.id === input.requestID || candidate.toolCallId === input.requestID)
    if (dialog === undefined) throw new UnsupportedCapability("permission.reply")
    const label = PERMISSION_DECISION_LABELS[input.decision]
    if (!dialog.options.includes(label)) throw new UnsupportedCapability("permission.reply:" + input.decision)
    adapter.tuiData.respondToHostDialog(dialog.id, { kind: "value", value: label })
  }

  const interruptSession = (input: SessionInterruptInput): SessionInterruptResponse => {
    const activeTurn = options.interaction.state().activeTurn
    if (activeTurn === null) return { interrupted: false }
    if (turnSession !== null && turnSession !== input.sessionID) return { interrupted: false }
    const outcome = options.interaction.abort(activeTurn)
    if (outcome.kind === "rejected") return { interrupted: false }
    turnSession = null
    return { interrupted: true }
  }

  const submitPrompt = (input: {
    readonly sessionID: string
    readonly text: string
    readonly kind?: "steer" | "follow_up"
  }): MiniBridgeSubmission => {
    const write = options.write
    if (write === undefined) throw new UnsupportedCapability("host.prompt")
    if (options.data.hostSession(input.sessionID) === undefined) {
      throw new UnsupportedCapability("session.prompt:" + input.sessionID)
    }
    const kind = input.kind ?? "steer"
    const turn = options.interaction.state().activeTurn ?? options.interaction.startTurn()
    const outcome = options.interaction.submit(turn, kind, input.text)
    if (outcome.kind === "rejected") throw new MiniBridgeRefusal(outcome.code)
    const submission: MiniBridgeSubmission = {
      sessionID: input.sessionID,
      turn: turn,
      kind: kind,
      text: input.text,
    }
    turnSession = input.sessionID
    write(submission)
    return submission
  }

  const state = (): MiniBridgeState => ({
    connection: options.connection(),
    turn: options.interaction.state().activeTurn,
    queue: options.interaction.pendingQueue(),
    aborted: options.interaction.state().abortedTurns,
    recovery: recovery,
  })

  const reconnect = async (signal: AbortSignal): Promise<MiniBridgeState> => {
    const redial = options.reconnect
    if (redial === undefined) throw new UnsupportedCapability("reconnect")
    const next = await redial(signal)
    recovery = planRecovery({
      cause: "client_disconnect",
      supportsReset: true,
      eventGap: true,
      replyLost: false,
      unconfirmedSideEffects: [],
      pendingDialogIds: adapter.tuiData.hostDialogs.list().map((dialog) => dialog.id),
      heartbeatCapabilities: null,
    })
    /* the recovery decision sets replaySideEffects false; assert it instead of trusting the comment */
    assertNoSilentReplay(recovery, [])
    return { ...state(), connection: next }
  }

  const sdk: OpenCodeClient = {
    ...adapter.api,
    agent: {
      ...adapter.api.agent,
      list: async (input) => catalog("agent", () => options.data.location().agent, input?.location?.directory),
    },
    command: {
      ...adapter.api.command,
      list: async (input) => catalog("command", () => options.data.location().command, input?.location?.directory),
    },
    model: {
      ...adapter.api.model,
      list: async (input) => catalog("model", () => options.data.location().model, input?.location?.directory),
    },
    provider: {
      ...adapter.api.provider,
      list: async (input) => catalog("provider", () => options.data.location().provider, input?.location?.directory),
    },
    reference: {
      ...adapter.api.reference,
      list: async (input) => catalog("reference", () => options.data.location().reference, input?.location?.directory),
    },
    message: {
      ...adapter.api.message,
      /* the client contract pages newest-first; the host's own payloads carry the order */
      list: async (input) => {
        const ordered = [...options.data.hostMessagesFor(input.sessionID)].sort(
          (left, right) => left.time.created - right.time.created,
        )
        const page = input.order === "desc" ? ordered.toReversed() : ordered
        return { data: input.limit === undefined ? page : page.slice(0, input.limit), cursor: {} }
      },
    },
    permission: {
      ...adapter.api.permission,
      list: async (input) => options.data.permissionsFor(input.sessionID),
      reply: async (input) => answerPermission(input),
    },
    session: {
      ...adapter.api.session,
      /* the prompt receipt is host state; the bridge has no admitted-message payload to return */
      prompt: (): never => {
        throw new UnsupportedCapability("session.prompt")
      },
      shell: (): never => {
        throw new UnsupportedCapability("session.shell")
      },
      interrupt: async (input) => interruptSession(input),
      message: { get: adapter.api.session.message.get },
      form: {
        ...adapter.api.session.form,
        list: async (input) => options.data.formsFor(input.sessionID),
        reply: (): never => {
          throw new UnsupportedCapability("session.form.reply")
        },
        cancel: (): never => {
          throw new UnsupportedCapability("session.form.cancel")
        },
      },
    },
    event: {
      /* the host stream is the bridge's own vocabulary, not the OpenCode V2 event union */
      subscribe: (): never => {
        throw new UnsupportedCapability("event.subscribe")
      },
    },
  }

  return {
    adapter: adapter,
    sdk: sdk,
    submitPrompt: submitPrompt,
    abort: (sessionID: string) => interruptSession({ sessionID: sessionID }).interrupted,
    reconnect: reconnect,
    state: state,
  }
}

export type MiniBridgeTarget = {
  readonly sessionID: string
  readonly sessionTitle: string
  readonly location: LocationGetOutput
  readonly model: { readonly providerID: string; readonly modelID: string } | undefined
  readonly variant: string | undefined
  readonly agent: string | undefined
  readonly resume: false
}

/**
 * What Mini's boot needs before the first frame: the session to attach to and the
 * location the host published. The bridge cannot create a session, so an unnamed
 * target refuses instead of picking one arbitrarily.
 */
export function resolveMiniBridgeTarget(input: {
  readonly data: BridgeData
  readonly sessionID?: string
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
}): MiniBridgeTarget {
  const session =
    input.sessionID === undefined ? soleHostSession(input.data) : input.data.hostSession(input.sessionID)
  if (session === undefined) throw new UnsupportedCapability("session.target:" + (input.sessionID ?? "new"))
  const info = input.data.location().info
  /* without the host's location payload the model catalog and project identity would be invented */
  if (info === undefined) throw new UnsupportedCapability("location.get")
  const hostModel = session.model
  const providerID = input.model?.providerID ?? hostModel?.providerID
  const modelID = input.model?.modelID ?? hostModel?.id
  const variant = input.model === undefined ? hostModel?.variant : input.model.variant
  return {
    sessionID: session.id,
    sessionTitle: session.title ?? session.id,
    location: info,
    model: providerID === undefined || modelID === undefined ? undefined : { providerID, modelID },
    variant: variant,
    agent: input.agent,
    resume: false,
  }
}

function soleHostSession(data: BridgeData): SessionInfo {
  const sessions = data.hostSessionList()
  if (sessions.length === 1) return sessions[0]
  /* creating a session needs the host request the bridge does not implement */
  if (sessions.length === 0) throw new UnsupportedCapability("session.create")
  throw new UnsupportedCapability("session.select")
}

function isSelectDialog(dialog: HostDialogRequestFrame): dialog is SelectRequestFrame {
  return dialog.method === "select"
}

function isStreamFrame(value: unknown): value is { readonly kind: string } {
  if (typeof value !== "object" || value === null) return false
  if (!("kind" in value)) return false
  return typeof value.kind === "string"
}
