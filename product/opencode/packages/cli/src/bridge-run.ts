/**
 * Bridge-mode launcher: dials the host socket, completes the published POSIX socket
 * authentication exchange, and only then starts the real TUI against the in-process adapter.
 *
 * The exchange implemented here is the one documented for the target host
 * (`upstream/senpi/packages/coding-agent/docs/rpc.md`, "Authentication"):
 *
 *   1. send `get_protocol_info` with a top-level `auth.client_nonce`;
 *   2. the response carries `data.auth = { launch_id, server_nonce, server_proof }`;
 *   3. verify `server_proof` against the published key record, then send
 *      `{ id, type: "authenticate", client_proof }` and wait for its correlated success.
 *
 * `packages/bridge-core/src/transport.ts` owns framing and the host-side gate only; its
 * `AuthGate` is not this protocol and is deliberately not used as the client side.
 *
 * States the launcher can report:
 *   authenticated - dial, server-proof verification and the authenticate reply all succeeded;
 *   unproven      - the socket is connected but the host sent no challenge, so nothing was proved;
 *   failed        - the dial, the record, the server proof or the authenticate reply failed.
 * Only `authenticated` is reported as ready, and the TUI is only started in that state.
 *
 * Not covered by this launcher: it installs no plugin packages (that needs the CLI's Effect services).
 * The user's TUI document is read from the local config directory in `bridge-config.ts`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Effect, Layer, Option, Schema } from "effect";
import { Global } from "@opencode/util/global";
import { LayerNode } from "@opencode/util/effect/layer-node";
/* The TUI module graph is loaded only when a TUI is actually started: importing it here would pull
   the renderer (and its optional react peer) into every consumer of the transport, including tests
   and QA cases that never draw anything. */
import type {
  ModelRef,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client";
import type { BridgeBranchEntry, BridgeBranchSnapshot } from "../../bridge-core/src/data.ts";
import { BridgeData } from "../../bridge-core/src/data.ts";
import type { HostPendingInput } from "../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../bridge-core/src/dialogs.ts";
import {
  readLifecycle,
  readModelThinkingLevel,
  readNavigateOutcome,
  readPermission,
  readThinkingLevels,
  supportsThinkingLevel,
} from "../../bridge-core/src/host-capabilities.ts";
import type { HostThinking } from "../../bridge-core/src/host-capabilities.ts";
import { InteractionController } from "../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../bridge-core/src/sessions.ts";
import type { SessionState } from "../../bridge-core/src/sessions.ts";
import { sessionChangeEvents } from "../../bridge-core/src/session-diff.ts";
import { JsonlFrameDecoder, encodeFrame } from "../../bridge-core/src/transport.ts";
import { MessageChannelRefused } from "../../client/src/message-channel.ts";
import type {
  MessageChannelContinueInput,
  MessageChannelEditInput,
  MessageChannelEditOutcome,
  MessageChannelFailureCode,
} from "../../client/src/message-channel.ts";
import {
  loadPermissionRuleDocument,
  permissionRulesPath,
  SessionPermissionRules,
} from "../../bridge-core/src/permission-rules.ts";
import { createBridgeTuiContext } from "../../tui/src/context/bridge.ts";
import type { BridgePromptSubmission } from "../../tui/src/context/bridge-data.ts";
import { connectBridgeMcp } from "../../tui/src/bridge/mcp-client.ts";
import { stageCompanionExtensionProfile } from "./bridge-agent-profile";
import { createBridgeEntry } from "./bridge-entry";
import { createBridgeTuiConfig } from "./bridge-config";
import { createBridgeMcpExecutor } from "./bridge-mcp";
import { createExtensionRequester } from "../../bridge-core/src/extension-request.ts";
import { createBridgePty } from "./bridge-pty";
import { Env } from "./env";
import { OPENCODE_ARTIFACT, OPENCODE_CHANNEL, OPENCODE_HIGHLIGHTS, OPENCODE_VERSION } from "./version";

export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const HEX_64 = /^[0-9a-f]{64}$/;

export type BridgeLaunchOptions = {
  readonly socket: string;
  readonly keyRecord: string;
  readonly cwd: string;
  readonly mini: boolean;
  readonly handshakeTimeoutMs: number;
};

export type BridgeFailureCode =
  | "usage"
  | "dial_failed"
  | "stream_closed"
  | "handshake_timeout"
  | "protocol_failure"
  | "connection_unproven"
  | "key_record_missing"
  | "unsafe_key_record"
  | "host_identity_unproven"
  | "auth_failed"
  | "pull_failed"
  | "prompt_failed"
  | "entry_state_mismatch";

export type BridgeLaunchReport = {
  readonly state: "authenticated" | "unproven" | "failed";
  readonly code: BridgeFailureCode | "authenticated";
  readonly detail: string;
};

export class BridgeTransportFailure extends Error {
  readonly code: BridgeFailureCode;

  constructor(code: BridgeFailureCode, detail: string) {
    super(detail.length === 0 ? code : code + ": " + detail);
    this.name = "BridgeTransportFailure";
    this.code = code;
  }
}

export class BridgeLaunchUsageError extends Error {}

export function parseBridgeLaunchArgs(argv: readonly string[]): BridgeLaunchOptions {
  let socket: string | undefined;
  let keyRecord: string | undefined;
  let mini = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mini") {
      mini = true;
      continue;
    }
    if (arg === "--socket" || arg === "--key-record") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new BridgeLaunchUsageError(arg + " requires a path");
      index += 1;
      if (arg === "--socket") socket = value;
      else keyRecord = value;
      continue;
    }
    throw new BridgeLaunchUsageError("unknown argument " + String(arg));
  }
  if (socket === undefined || socket.length === 0) throw new BridgeLaunchUsageError("--socket requires a path");
  if (keyRecord === undefined || keyRecord.length === 0) throw new BridgeLaunchUsageError("--key-record requires a path");
  return {
    socket: socket,
    keyRecord: keyRecord,
    cwd: process.cwd(),
    mini: mini,
    handshakeTimeoutMs: DEFAULT_HANDSHAKE_TIMEOUT_MS,
  };
}

type TransportFrame = Record<string, unknown>;

type PendingFrame = {
  readonly resolve: (frame: TransportFrame) => void;
  readonly reject: (error: Error) => void;
};

type KeyRecord = {
  readonly launchId: string;
  readonly key: Uint8Array;
};

type LaunchAuth = {
  readonly launchId: string;
  readonly serverNonce: string;
  readonly serverProof: string;
};

export type BridgeTransport = {
  readonly report: BridgeLaunchReport;
  readonly close: () => void;
  /** Writes one already-encoded frame to the socket this transport owns. */
  readonly send: (frame: unknown) => void;
  /**
   * Sends one correlated command and resolves with its `response` frame. The payload carries the
   * command's own fields only; `id` and `type` are added here, as the protocol documents them.
   */
  readonly request: (type: string, payload: TransportFrame) => Promise<TransportFrame>;
};

/**
 * Dials the socket and runs the published exchange. Returns the state reached; the caller
 * decides what to do with a connection that never proved the host's identity. Every parsed frame
 * that is not a correlated reply is handed to `onFrame` as received.
 */
const BRANCH_PAGE_LIMIT = 20;

export async function openBridgeTransport(
  options: BridgeLaunchOptions,
  onFrame?: (frame: TransportFrame) => void,
): Promise<BridgeTransport> {
  const decoder = new JsonlFrameDecoder();
  const pending = new Map<string, PendingFrame>();
  let connection: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  let requestSequence = 0;

  const close = () => {
    if (connection === undefined) return;
    const opened = connection;
    connection = undefined;
    opened.end();
  };

  const send = (frame: unknown) => {
    if (connection === undefined) throw new BridgeTransportFailure("stream_closed", "the connection is not open");
    connection.write(encodeFrame(frame));
  };

  const failPending = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  const dispatch = (line: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (readString(parsed, "type") !== "response") {
      onFrame?.(parsed);
      return;
    }
    const id = readString(parsed, "id");
    if (id === undefined) return;
    const entry = pending.get(id);
    /*
     * A response nothing here asked for is not necessarily a stray: the extension correlator writes
     * `extension_request` frames with its own ids and the host answers those with the same `response`
     * shape. Dropping them left every extension request timing out, so they are forwarded instead.
     */
    if (entry === undefined) {
      onFrame?.(parsed);
      return;
    }
    pending.delete(id);
    entry.resolve(parsed);
  };

  const request = async (type: string, payload: TransportFrame): Promise<TransportFrame> => {
    // The documented frame is `{id, type, ...fields}`; callers pass only the command's own fields.
    if (connection === undefined) throw new BridgeTransportFailure("stream_closed", "the connection is not open");
    const opened = connection;
    const id = "bridge-" + String((requestSequence += 1));
    const received = new Promise<TransportFrame>((resolve, reject) => {
      pending.set(id, { resolve: resolve, reject: reject });
    });
    const frame: TransportFrame = { id: id, type: type, ...payload };
    opened.write(encodeFrame(frame));
    try {
      return await withDeadline(received, options.handshakeTimeoutMs, type);
    } finally {
      pending.delete(id);
    }
  };

  try {
    connection = await Bun.connect({
      unix: options.socket,
      socket: {
        open() {},
        data(_socket, chunk) {
          let frames: readonly string[];
          try {
            frames = decoder.push(chunk);
          } catch (error) {
            failPending(new BridgeTransportFailure("protocol_failure", describeError(error)));
            return;
          }
          for (const line of frames) dispatch(line);
        },
        close() {
          failPending(new BridgeTransportFailure("stream_closed", "the peer closed the connection"));
        },
        error(_socket, error) {
          failPending(new BridgeTransportFailure("dial_failed", describeError(error)));
        },
      },
    });
  } catch (error) {
    connection = undefined;
    return failed("dial_failed", describeError(error));
  }

  try {
    const clientNonce = randomBytes(32).toString("hex");
    const info = await request("get_protocol_info", { auth: { client_nonce: clientNonce } });
    if (info.success !== true) throw new BridgeTransportFailure("protocol_failure", responseError(info));
    const data = info.data;
    const authValue = isRecord(data) ? data.auth : undefined;
    if (authValue === undefined) {
      return {
        report: {
          state: "unproven",
          code: "connection_unproven",
          detail: "the host answered get_protocol_info without data.auth, so no proof was exchanged",
        },
        close: close,
        send: send,
        request: request,
      };
    }
    const auth = readAuth(authValue);
    if (auth === undefined) {
      throw new BridgeTransportFailure("protocol_failure", "data.auth is missing a launch id, nonce or proof");
    }
    requireRecordedProof(auth);
    const record = loadKeyRecord(options.keyRecord);
    if (record.launchId !== auth.launchId) {
      throw new BridgeTransportFailure("host_identity_unproven", "the server launch id does not match the key record");
    }
    const expected = proof(record.key, ["senpi-rpc-server", auth.launchId, clientNonce, auth.serverNonce]);
    if (!sameBytes(expected, Buffer.from(auth.serverProof, "hex"))) {
      throw new BridgeTransportFailure("host_identity_unproven", "the server proof does not match the key record");
    }
    const clientProof = proof(record.key, ["senpi-rpc-client", auth.launchId, auth.serverNonce, clientNonce]).toString(
      "hex",
    );
    const confirmation = await request("authenticate", { client_proof: clientProof });
    if (confirmation.success !== true) throw new BridgeTransportFailure("auth_failed", responseError(confirmation));
    return {
      report: { state: "authenticated", code: "authenticated", detail: "launch " + auth.launchId },
      close: close,
      send: send,
      request: request,
    };
  } catch (error) {
    return { report: reportOf(error), close: close, send: send, request: request };
  }
}

export type HostPullOutcome = {
  /** How many catalogue models the host described, so an empty picker can be traced to the host. */
  readonly models?: number;
  readonly subscriptionId: string;
  readonly sessionIds: readonly string[];
  /** The routing handle and context each pulled session was addressed with, so a later prompt can address it too. */
  readonly statuses: readonly HostSessionStatus[];
  readonly messages: number;
};

export type HostSessionStatus = {
  readonly routingId: string;
  readonly durableId: string;
  readonly directory: string;
  readonly status: string | undefined;
  readonly model: ModelRef | undefined;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type ToolPartPosition = {
  readonly message: number;
  readonly part: number;
  readonly input: { [key: string]: JsonValue };
};

export type BridgePromptImage = {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
};

export type BridgePromptRequest = {
  /** The routing handle `subscribe_sessions` published for the session. */
  readonly sessionId: string;
  readonly message: string;
  readonly images?: readonly BridgePromptImage[];
  /** The caller's id; a host with the `effect_ledger` capability adopts it as the input's effect id. */
  readonly clientMessageId?: string;
  /** The documented way to join the turn already streaming; an idle session takes the prompt as it is. */
  readonly streamingBehavior?: "steer";
};
/**
 * Pulls the host state the TUI reads: one `subscribe_sessions` for the session list and routing
 * handles, then `get_state`, `get_messages` and `get_pending_inputs` per session. Every command is
 * the one documented for it, addressed with the `sessionId` multi-session mode requires; the
 * responses go into `BridgeData` through its setters. Nothing here invents a field: a response
 * that lacks one of the documented fields fails with `pull_failed` instead of being guessed.
 */
export async function pullHostState(
  transport: BridgeTransport,
  data: BridgeData,
  sessions?: SessionRegistry,
): Promise<HostPullOutcome> {
  // The docs order recovery by subscription first ("subscribe first, apply the snapshot"), and the
  // subscription snapshot is the documented source of the routing handle each pull is addressed to.
  const subscribed = await transport.request("subscribe_sessions", {
    sessions: "all",
    include_workers: false,
    include_context: false,
    mirror: "none",
    effects: false,
  });
  requireSuccess(subscribed, "subscribe_sessions");
  const payload = requireRecord(subscribed.data, "subscribe_sessions.data");
  const subscriptionId = requireText(payload, "subscriptionId", "subscribe_sessions.data");
  const snapshot = requireArray(payload, "snapshot", "subscribe_sessions.data");
  const sessionIds: string[] = [];
  const statuses: HostSessionStatus[] = [];
  let messages = 0;
  for (let index = 0; index < snapshot.length; index += 1) {
    const status = readSessionStatus(snapshot[index], "subscribe_sessions.data.snapshot[" + String(index) + "]");
    if (status === undefined) continue;
    /* The snapshot records are the session's own status frames; publishing them lets the event
       projection announce sessions that existed before this connection subscribed. */
    data.publishEvent(snapshot[index]);
    messages += await pullHostSession(transport, data, sessions, status);
    sessionIds.push(status.durableId);
    statuses.push(status);
  }
  /* The catalogue is optional enrichment: a host that refuses it must not fail the whole pull, but an
     empty catalogue is why the model picker would stay blank, so the outcome reports how many arrived. */
  const models = await pullHostModels(transport, data, snapshot.length > 0 ? readSessionStatus(snapshot[0], "subscribe_sessions.data.snapshot[0]")?.routingId : undefined);
  /* The catalogue lands after the sessions, so the level list the pull already read is attached to
     the model rows here; without it the composer's variant picker stays empty on the first render. */
  for (const status of statuses) {
    const thinking = data.hostThinkingFor(status.durableId);
    if (thinking !== undefined && status.model !== undefined) applyThinkingVariants(data, status.model, thinking.availableLevels);
  }
  return { subscriptionId: subscriptionId, sessionIds: sessionIds, statuses: statuses, messages: messages, models: models };
}

/**
 * Writes the documented `prompt` command for submitted input. A refusal carries `success: false`
 * and an `errorCode`; it is reported as `prompt_failed` rather than left as silence.
 */
export async function sendBridgePrompt(transport: BridgeTransport, request: BridgePromptRequest): Promise<void> {
  if (request.message.length === 0) throw new BridgeTransportFailure("prompt_failed", "the prompt message is empty");
  const payload: TransportFrame = { sessionId: request.sessionId, message: request.message };
  if (request.images !== undefined && request.images.length > 0) {
    payload.images = request.images.map((image) => ({ ...image }));
  }
  if (request.clientMessageId !== undefined) payload.clientMessageId = request.clientMessageId;
  if (request.streamingBehavior !== undefined) payload.streamingBehavior = request.streamingBehavior;
  const response = await transport.request("prompt", payload);
  if (response.success !== true) {
    throw new BridgeTransportFailure("prompt_failed", "prompt was refused: " + responseError(response));
  }
}

/**
 * Builds the sender the TUI data layer is injected with for `session.prompt`. It writes the
 * documented prompt frame, then re-reads the session through the same pull the launcher used at
 * startup, so the transcript shows the turn the host admitted instead of a row this process made up.
 * A refresh that fails is reported and never turns an accepted prompt into a rejection, because that
 * would tell the composer to send the same text again.
 */
export function createBridgePromptSender(deps: {
  readonly transport: () => BridgeTransport | undefined;
  readonly data: BridgeData;
  readonly sessions: SessionRegistry;
  readonly routingId: (durableId: string) => string | undefined;
  readonly status: (durableId: string) => HostSessionStatus | undefined;
}): (input: BridgePromptSubmission) => Promise<void> {
  return async (input) => {
    const transport = deps.transport();
    if (transport === undefined) throw new BridgeTransportFailure("stream_closed", "the bridge transport is not open");
    const sessionId = deps.routingId(input.sessionID);
    if (sessionId === undefined) {
      throw new BridgeTransportFailure("pull_failed", "the host never announced session " + input.sessionID);
    }
    await sendBridgePrompt(transport, {
      sessionId: sessionId,
      message: input.text,
      clientMessageId: input.clientMessageId,
      streamingBehavior: input.delivery === "steer" ? "steer" : undefined,
    });
    /*
     * The `agent` selection travels in the prompt text because the host prompt command has no agent
     * field. The host's session context is the one metadata surface it does have, so the request is
     * recorded there too; `set_session_context` is best effort, and a refusal is reported rather than
     * turning an accepted prompt into a rejection.
     */
    const agentRequest = input.agentRequest;
    if (agentRequest !== undefined && agentRequest.requested.length > 0) {
      const recordContext = (hostContext: "applied" | "refused") => {
        const held = deps.data.promptAgentRecordFor(input.sessionID);
        if (held !== undefined) deps.data.setPromptAgentRecord(input.sessionID, { ...held, hostContext: hostContext });
      };
      try {
        const recorded = await transport.request("set_session_context", {
          sessionId: sessionId,
          patch: { bridge_requested_agent: agentRequest.requested.join(", ") },
        });
        if (recorded.success === true) {
          recordContext("applied");
        } else {
          recordContext("refused");
          process.stderr.write(
            "bridge-log: the host refused the agent-request session context: " + responseError(recorded) + "\n",
          );
        }
      } catch (error) {
        recordContext("refused");
        process.stderr.write("bridge-log: agent-request session context failed: " + describeError(error) + "\n");
      }
    }
    const status = deps.status(input.sessionID);
    if (status === undefined) return;
    try {
      await pullHostSession(transport, deps.data, deps.sessions, status);
    } catch (error) {
      process.stderr.write(
        "bridge-log: refresh after prompt failed for " + status.routingId + ": " + describeError(error) + "\n",
      );
    }
  };
}

/**
 * Reads the model catalogue the host offers. The command is documented at docs/rpc.md:3481; a refusal is
 * reported and leaves the location untouched rather than blanking whatever it already held.
 */
async function pullHostModels(transport: BridgeTransport, data: BridgeData, sessionId: string | undefined): Promise<number> {
  /* The command is answered per session: without one the host answers missing_session_id. */
  if (sessionId === undefined) return 0;
  let answer: TransportFrame;
  try {
    answer = await transport.request("get_available_models", { sessionId: sessionId });
  } catch (error) {
    process.stderr.write("bridge-log: host model catalogue unavailable: " + describeError(error) + "\n");
    return 0;
  }
  if (answer.success !== true) {
    process.stderr.write("bridge-log: host refused get_available_models: " + responseError(answer) + "\n");
    return 0;
  }
  const payload = requireRecord(answer.data, "get_available_models.data");
  const raw = Array.isArray(payload.models) ? payload.models : [];
  const mapped = raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const provider = readString(entry, "provider") ?? readString(entry, "providerID");
    const id = readString(entry, "id") ?? readString(entry, "modelId");
    if (provider === undefined || id === undefined) return [];
    const name = readString(entry, "name") ?? id;
    return [{ id: id, providerID: provider, name: name, ...entry }];
  });
  if (mapped.length === 0) return 0;
  data.mergeLocation({ model: mapped } as never);
  return mapped.length;
}

async function pullHostSession(
  transport: BridgeTransport,
  data: BridgeData,
  sessions: SessionRegistry | undefined,
  status: HostSessionStatus,
): Promise<number> {
  const stateResponse = await transport.request("get_state", { sessionId: status.routingId });
  requireSuccess(stateResponse, "get_state");
  const state = requireRecord(stateResponse.data, "get_state.data");
  const durableId = requireText(state, "sessionId", "get_state.data");
  if (durableId !== status.durableId) {
    throw new BridgeTransportFailure(
      "pull_failed",
      "get_state.data.sessionId " + durableId + " does not match durableSessionId " + status.durableId,
    );
  }
  const title = readString(state, "sessionName");
  /* `get_state.cwd` is the directory the host holds the session in; the status frame that announced the
     session carries the same value, and only the status frame is re-published on a move. */
  const directory = readString(state, "cwd") ?? status.directory;
  /* The effective approval preset is the host's answer, not ours. When it is full access there is no
     approval boundary to speak of, and a user reading the log should know that rather than assume one. */
  const permission = readPermission(state);
  if (permission !== undefined) {
    data.setHostPermission(durableId, permission);
    if (permission.effective === "full-access") {
      process.stderr.write("bridge-log: the host runs this session with full access; tool calls are not approved\n");
    } else {
      process.stderr.write("bridge-log: the host runs this session with permission preset " + permission.preset + "\n");
    }
  }
  const thinking = await pullHostThinking(transport, status, state);
  if (thinking !== undefined) {
    data.setHostThinking(durableId, thinking);
    if (status.model !== undefined) applyThinkingVariants(data, status.model, thinking.availableLevels);
  }
  const lifecycle = readLifecycle(state.lifecycle);

  const messagesResponse = await transport.request("get_messages", { sessionId: status.routingId });
  requireSuccess(messagesResponse, "get_messages");
  const messagesPayload = requireRecord(messagesResponse.data, "get_messages.data");
  const rawMessages = requireArray(messagesPayload, "messages", "get_messages.data");

  const pendingResponse = await transport.request("get_pending_inputs", {
    sessionId: status.routingId,
    knownClientMessageIds: [],
  });
  requireSuccess(pendingResponse, "get_pending_inputs");
  const pending = projectPendingInputs(pendingResponse.data);

  /* Token usage is the host's accounting, not ours: asking for it keeps the session row honest instead
     of showing zeros that look like an unmeasured session. A refusal leaves it unreported. */
  const stats = await pullSessionStats(transport, status.routingId);

  /* The session tree is what the todo surface walks: append-order entries plus the current leaf. */
  /*
   * The session tree is optional enrichment: the todo surface reports "not delivered" when it is
   * absent, so a host that refuses get_entries must not take the whole TUI down. A refusal is still
   * stated on stderr rather than dropped. It is pulled before the transcript because the active
   * branch's message entry ids are the identity the transcript rows carry.
   */
  let branch: BridgeBranchSnapshot | undefined;
  try {
    branch = await pullHostBranch(transport, status);
    data.setHostBranch(durableId, branch);
  } catch (error) {
    process.stderr.write("bridge-log: host session tree unavailable for " + status.routingId + ": " + describeError(error) + "\n");
  }

  const projected = projectHostMessages(rawMessages, state.isStreaming === true, data.ids, durableId, activeMessageEntries(branch));

  const effectiveStatus = directory === status.directory ? status : { ...status, directory: directory };
  data.upsertHostSession(
    hostSessionInfo(effectiveStatus, rawMessages, title, stats, {
      ...(thinking === undefined ? {} : { thinking: thinking }),
      ...(lifecycle === undefined ? {} : { lifecycle: lifecycle }),
      ...(data.hostRevertFor(durableId) === undefined ? {} : { revert: data.hostRevertFor(durableId) }),
    }),
  );
  /* The roster the TUI draws comes from the view layer, not from the host store: without this projection
     every session the host holds is invisible to the session list and to session.get. */
  data.upsertSession({ id: status.durableId, title: title ?? status.durableId, messages: projected.length });
  data.setHostMessages(status.durableId, projected);
  data.setPendingInputs(status.durableId, pending);

  /* The pull is the only channel a title or a directory change travels on, so the change is turned into
     the client's own event after the state above is in place: a consumer reacting to it re-reads what
     already landed. `observe` seeds a session on first sight and reports nothing when nothing changed. */
  const changes = data.diff.observe({
    id: durableId,
    ...(title === undefined ? {} : { title: title }),
    directory: directory,
  });
  for (const event of sessionChangeEvents(changes, { location: { directory: directory }, sequence: () => data.nextEventSequence() })) {
    data.publishClientEvent(event);
  }

  if (sessions !== undefined) {
    const opened = sessions.open({ persistentId: status.durableId, durableId: status.durableId });
    if (opened.kind === "ok" && isRunningStatus(status.status)) sessions.markActive(opened.value);
  }
  return projected.length;
}

/** The host's own token and cost accounting for one session. */
type SessionStats = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
};

async function pullSessionStats(transport: BridgeTransport, sessionId: string): Promise<SessionStats | undefined> {
  const response = await transport.request("get_session_stats", { sessionId: sessionId });
  if (response.success !== true || !isRecord(response.data)) return undefined;
  const tokens = isRecord(response.data.tokens) ? response.data.tokens : undefined;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  return {
    input: count(tokens?.input),
    output: count(tokens?.output),
    cacheRead: count(tokens?.cacheRead),
    cacheWrite: count(tokens?.cacheWrite),
    cost: count(response.data.cost),
  };
}

/**
 * Every status frame moves the row: the host is the authority on whether a turn is running, so a
 * finished turn must stop showing as running without waiting for the next pull to say so.
 */
export function applyLiveStatus(sessions: SessionRegistry, status: HostSessionStatus): void {
  const record = sessions.list().find((candidate) => candidate.durableId === status.durableId);
  if (record === undefined) return;
  if (isRunningStatus(status.status)) sessions.markActive(record.handle);
  else sessions.markIdle(record.handle);
}

/**
 * What a live status frame does to a row: `started` opens a turn, `settled` closes the turn that was
 * running, `steady` repeats the state the row already holds. A settled turn is also the moment the
 * host has appended the finished assistant message, and its stop reason is the only place the turn's
 * terminal outcome travels, so that transition re-reads the session.
 */
export function liveStatusEffect(
  before: SessionState | undefined,
  status: HostSessionStatus,
): "started" | "settled" | "steady" {
  if (isRunningStatus(status.status)) return before === "active" ? "steady" : "started";
  return before === "active" ? "settled" : "steady";
}

function hostSessionInfo(
  status: HostSessionStatus,
  rawMessages: readonly unknown[],
  title: string | undefined,
  stats: SessionStats | undefined,
  host: {
    readonly thinking?: HostThinking;
    readonly lifecycle?: ReturnType<typeof readLifecycle>;
    readonly revert?: { readonly messageID: string };
  },
): SessionInfo {
  const times = messageTimes(rawMessages);
  const base: SessionInfo = {
    id: status.durableId,
    // The host publishes no project identity in these responses; its published working directory is
    // the only stable grouping key the TUI has, so it stands in rather than an invented id.
    projectID: status.directory,
    // Cost and token accounting come from the host's own statistics when it answers for them.
    cost: stats?.cost ?? 0,
    tokens: {
      input: stats?.input ?? 0,
      output: stats?.output ?? 0,
      reasoning: 0,
      cache: { read: stats?.cacheRead ?? 0, write: stats?.cacheWrite ?? 0 },
    },
    time: { created: times.created, updated: times.updated },
    location: { directory: status.directory },
  };
  const titled: SessionInfo = title === undefined ? base : { ...base, title: title };
  /* The composer reads a model's effort from the session's model variant, and `get_state.thinkingLevel`
     is the level this session actually runs at, so the host's answer is what the row reports. */
  const model: ModelRef | undefined =
    status.model === undefined
      ? undefined
      : host.thinking === undefined
        ? status.model
        : { ...status.model, variant: host.thinking.level };
  const withModel: SessionInfo = model === undefined ? titled : { ...titled, model: model };
  /* `lifecycle.parentSessionId` is spawned-by ancestry; fork ancestry is `parentID` and a different
     relation, so only a child session opened with `spawnedBy` reports a parent here. */
  const parent = host.lifecycle?.role === "child" ? host.lifecycle.parentSessionId : undefined;
  const withParent: SessionInfo = parent === undefined ? withModel : { ...withModel, parentID: parent };
  return host.revert === undefined ? withParent : { ...withParent, revert: { messageID: host.revert.messageID } };
}

function messageTimes(rawMessages: readonly unknown[]): { readonly created: number; readonly updated: number } {
  let created: number | undefined;
  let updated: number | undefined;
  for (const entry of rawMessages) {
    if (!isRecord(entry)) continue;
    const timestamp = entry.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
    if (created === undefined || timestamp < created) created = timestamp;
    if (updated === undefined || timestamp > updated) updated = timestamp;
  }
  return { created: created ?? 0, updated: updated ?? 0 };
}

type MessageEntryIds = { readonly user: readonly string[]; readonly assistant: readonly string[] };

/**
 * The message entries of the branch that leads to the host's leaf, in append order. `get_messages`
 * returns exactly that branch, so the two lists bind row by row; the entry id is what `navigate_tree`,
 * `edit_user_message` and `fork` address, and it is the identity a row needs before the TUI can ask
 * the host to act on the message a user selected.
 */
function activeMessageEntries(branch: BridgeBranchSnapshot | undefined): MessageEntryIds | undefined {
  if (branch === undefined || branch.leafId === null) return undefined;
  const byId = new Map(branch.entries.map((entry) => [entry.id, entry]));
  const active: BridgeBranchEntry[] = [];
  const seen = new Set<string>();
  let cursor: string | null = branch.leafId;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const entry = byId.get(cursor);
    if (entry === undefined) return undefined;
    active.push(entry);
    cursor = entry.parentId;
  }
  active.reverse();
  const user: string[] = [];
  const assistant: string[] = [];
  for (const entry of active) {
    if (!isRecord(entry.data) || entry.data.type !== "message") continue;
    const message = isRecord(entry.data.message) ? entry.data.message : undefined;
    if (message?.role === "user") user.push(entry.id);
    else if (message?.role === "assistant") assistant.push(entry.id);
  }
  return { user: user, assistant: assistant };
}

/** The binding holds only when both lists agree on every message, by role and in order. */
function alignedEntryIds(rawMessages: readonly unknown[], entryIds: MessageEntryIds | undefined): MessageEntryIds | undefined {
  if (entryIds === undefined) return undefined;
  let user = 0;
  let assistant = 0;
  for (const entry of rawMessages) {
    if (!isRecord(entry)) continue;
    if (entry.role === "user") user += 1;
    else if (entry.role === "assistant") assistant += 1;
  }
  return entryIds.user.length === user && entryIds.assistant.length === assistant ? entryIds : undefined;
}

/**
 * The thinking state of one session, read the way the host documents it: `get_available_thinking_levels`
 * for the levels the active model offers, then `get_model_thinking_level` with an explicit provider and
 * model id for the level itself. A host with no usable model refuses the second read with
 * `model_not_found`; the level `get_state` reports still stands, so the read is recorded around it
 * rather than failing the whole pull.
 */
async function pullHostThinking(
  transport: BridgeTransport,
  status: HostSessionStatus,
  state: TransportFrame,
): Promise<HostThinking | undefined> {
  const level = readString(state, "thinkingLevel");
  if (level === undefined) return undefined;
  const source = readString(state, "thinkingLevelSource") ?? null;
  let availableLevels: readonly string[] = [];
  try {
    const answer = await transport.request("get_available_thinking_levels", { sessionId: status.routingId });
    if (answer.success === true) availableLevels = readThinkingLevels(answer.data) ?? [];
  } catch (error) {
    process.stderr.write(
      "bridge-log: host thinking levels unavailable for " + status.routingId + ": " + describeError(error) + "\n",
    );
  }
  const model = readModel(state.model);
  if (model !== undefined) {
    try {
      const answer = await transport.request("get_model_thinking_level", {
        sessionId: status.routingId,
        provider: model.providerID,
        modelId: model.id,
      });
      const perModel = answer.success === true ? readModelThinkingLevel(answer.data) : undefined;
      if (perModel !== undefined) return perModel;
    } catch (error) {
      process.stderr.write(
        "bridge-log: host per-model thinking level unavailable for " + status.routingId + ": " + describeError(error) + "\n",
      );
    }
  }
  return { level: level, source: source, availableLevels: availableLevels };
}

/**
 * Labels a model row with the levels the host offers it, so the composer's variant list is the host's
 * own vocabulary. Only the model this session runs is labelled: `get_available_thinking_levels`
 * answers for the active model, and a level list invented for any other model would be a guess.
 */
function applyThinkingVariants(data: BridgeData, model: ModelRef, levels: readonly string[]): void {
  const current = data.location().model;
  if (current === undefined || levels.length === 0) return;
  data.mergeLocation({
    model: current.map((entry) =>
      entry.providerID === model.providerID && entry.id === model.id
        ? { ...entry, variants: levels.map((level) => ({ id: level })) }
        : entry,
    ),
  } as never);
}

/**
 * Projects the host's `AgentMessage` list into the TUI's message type. `toolResult` messages are
 * folded into the tool part of the assistant message that called them, so both the call and its
 * result stay visible; message ids are bridge-local because the host sends none.
 */
function projectHostMessages(
  rawMessages: readonly unknown[],
  streaming: boolean,
  ids: BridgeData["ids"],
  sessionID: string,
  entryIds?: MessageEntryIds,
): SessionMessageInfo[] {
  const messages: SessionMessageInfo[] = [];
  const toolParts = new Map<string, ToolPartPosition>();
  let lastAssistant = -1;
  for (let index = 0; index < rawMessages.length; index += 1) {
    const candidate = rawMessages[index];
    if (isRecord(candidate) && candidate.role === "assistant") lastAssistant = index;
  }
  /* A host entry id is only the identity of a row when the two lists agree on every kind, so the
     binding is dropped as soon as one side has a message the other does not. */
  const bindings = alignedEntryIds(rawMessages, entryIds);
  let userIndex = 0;
  let assistantIndex = 0;
  for (let index = 0; index < rawMessages.length; index += 1) {
    const where = "get_messages.data.messages[" + String(index) + "]";
    const message = requireRecord(rawMessages[index], where);
    const role = requireText(message, "role", where);
    const timestamp = requireTimestamp(message, "timestamp", where);
    const entryId = role === "user" ? bindings?.user[userIndex++] : role === "assistant" ? bindings?.assistant[assistantIndex++] : undefined;
    /* The client-shaped id is minted from the host entry (or the host's append ordinal when the two
       lists disagree); the host entry id itself travels in `metadata`, which is the only place a
       consumer that must address the host reads it from. */
    const id = ids.messageID(
      { sessionID: sessionID, ...(entryId === undefined ? {} : { entryID: entryId }), ordinal: index },
      timestamp,
    );
    const metadata = entryId === undefined ? {} : { metadata: { hostEntryID: entryId } };
    if (role === "user") {
      messages.push({ id: id, type: "user", time: { created: timestamp }, text: textOfContent(message.content), ...metadata });
      continue;
    }
    if (role === "assistant") {
      /* A failed provider request leaves stopReason "error" plus the host message, which is what the
       * transcript renders; dropping them hid the failure from the user. */
      const stoppedFields = hostStop(message, where);
      messages.push({
        id: id,
        type: "assistant",
        // The host's assistant message carries no agent identity, so none is attributed.
        agent: "",
        model: assistantModel(message, where),
        time:
          streaming && index === lastAssistant
            ? { created: timestamp }
            : { created: timestamp, completed: timestamp },
        content: assistantContent(message, messages.length, toolParts, timestamp, where),
        ...stoppedFields,
        ...metadata,
      });
    }
    // toolResult is folded into its call below; system and configuration messages have no place
    // in the TUI timeline, so they are not projected.
  }
  foldToolResults(rawMessages, messages, toolParts);
  return messages;
}

/**
 * The client shape of a turn the user stopped. It is the same pair the fork's own runner writes
 * (`packages/core/src/session/runner/step.ts`, `STEP_INTERRUPTED`), which is what the transcript
 * reads as "interrupted" rather than as a provider error.
 */
const STEP_INTERRUPTED = { finish: "error", error: { type: "aborted", message: "Step interrupted" } } as const;

/** Maps the host stop reason to the client finish value and keeps a failed run message. */
export function hostStop(
  message: Record<string, unknown>,
  where: string,
): { finish?: "stop" | "length" | "tool-calls" | "content-filter" | "error" | "unknown"; error?: { type: string; message: string; status?: number } } {
  const raw = message.stopReason;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "string") throw new BridgeTransportFailure("pull_failed", where + ".stopReason is not a string");
  /* The host says "aborted" for a turn the user stopped; the client vocabulary has no such finish, and
     "unknown" would hide the outcome, so the turn keeps the interrupted shape the fork itself writes. */
  if (raw === "aborted") return STEP_INTERRUPTED;
  const finish =
    raw === "stop" ? "stop" : raw === "length" ? "length" : raw === "toolUse" || raw === "tool-calls" ? "tool-calls" : raw === "error" ? "error" : "unknown";
  if (finish !== "error") return { finish: finish };
  const detail = message.errorMessage;
  if (typeof detail !== "string" || detail.length === 0) return { finish: finish };
  return { finish: finish, error: { type: "provider.unavailable", message: detail, status: 400 } };
}

function assistantContent(
  message: TransportFrame,
  messageIndex: number,
  toolParts: Map<string, ToolPartPosition>,
  timestamp: number,
  where: string,
): SessionMessageAssistant["content"] {
  const blocks = requireArray(message, "content", where);
  const content: SessionMessageAssistant["content"] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const blockPath = where + ".content[" + String(index) + "]";
    const block = requireRecord(blocks[index], blockPath);
    const kind = requireText(block, "type", blockPath);
    if (kind === "text") {
      content.push({ type: "text", text: requireText(block, "text", blockPath) });
      continue;
    }
    if (kind === "thinking") {
      content.push({
        type: "reasoning",
        text: requireText(block, "thinking", blockPath),
        time: { created: timestamp },
      });
      continue;
    }
    if (kind === "toolCall") {
      const callId = requireText(block, "id", blockPath);
      const name = requireText(block, "name", blockPath);
      const input = requireJsonObject(block.arguments, blockPath + ".arguments");
      toolParts.set(callId, { message: messageIndex, part: content.length, input: input });
      content.push({
        type: "tool",
        id: callId,
        name: name,
        time: { created: timestamp },
        state: { status: "running", input: input, metadata: {} },
      });
    }
  }
  return content;
}

function foldToolResults(
  rawMessages: readonly unknown[],
  messages: SessionMessageInfo[],
  toolParts: Map<string, ToolPartPosition>,
): void {
  for (const entry of rawMessages) {
    if (!isRecord(entry)) continue;
    if (entry.role !== "toolResult") continue;
    const callId = readString(entry, "toolCallId");
    if (callId === undefined) continue;
    const position = toolParts.get(callId);
    if (position === undefined) continue;
    const assistant = messages[position.message];
    if (assistant === undefined || assistant.type !== "assistant") continue;
    const part = assistant.content[position.part];
    if (part === undefined || part.type !== "tool") continue;
    const text = textOfContent(entry.content);
    const state: SessionMessageAssistantTool["state"] =
      entry.isError === true
        ? {
            status: "error",
            input: position.input,
            content: [{ type: "text", text: text }],
            metadata: {},
            error: { type: "tool_result_error", message: text },
          }
        : { status: "completed", input: position.input, content: [{ type: "text", text: text }], metadata: {} };
    const next: SessionMessageAssistantTool = { ...part, state: state };
    messages[position.message] = {
      ...assistant,
      content: assistant.content.map((candidate, index) => (index === position.part ? next : candidate)),
    };
  }
}

function projectPendingInputs(value: unknown): HostPendingInput[] {
  const payload = requireRecord(value, "get_pending_inputs.data");
  const inputs = requireArray(payload, "inputs", "get_pending_inputs.data");
  return inputs.map((entry, index) => {
    const where = "get_pending_inputs.data.inputs[" + String(index) + "]";
    const input = requireRecord(entry, where);
    return {
      clientMessageId: requireText(input, "clientMessageId", where),
      state: requireText(input, "state", where),
      text: requireText(input, "text", where),
      requestedMode: readString(input, "requestedMode") ?? null,
    };
  });
}

function assistantModel(message: TransportFrame, where: string): ModelRef {
  return { providerID: requireText(message, "provider", where), id: requireText(message, "model", where) };
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type !== "text") continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function readSessionStatus(value: unknown, where: string): HostSessionStatus | undefined {
  const record = requireRecord(value, where);
  const type = readString(record, "type");
  if (type !== undefined && type !== "session_status") {
    throw new BridgeTransportFailure("pull_failed", where + ".type is " + type + ", not session_status");
  }
  const kind = readString(record, "kind");
  if (kind === "worker") return undefined;
  return {
    routingId: requireText(record, "sessionId", where),
    durableId: requireText(record, "durableSessionId", where),
    directory: requireText(record, "cwd", where),
    status: readString(record, "status"),
    model: readModel(record.model),
  };
}

/** A status frame is a live record, so a shape the initial pull would refuse is passed through untouched. */
function liveSessionStatus(frame: TransportFrame): HostSessionStatus | undefined {
  if (frame.type !== "session_status") return undefined;
  if (readString(frame, "kind") === "worker") return undefined;
  const routingId = readString(frame, "sessionId");
  const durableId = readString(frame, "durableSessionId");
  const directory = readString(frame, "cwd");
  if (routingId === undefined || durableId === undefined || directory === undefined) return undefined;
  return {
    routingId: routingId,
    durableId: durableId,
    directory: directory,
    status: readString(frame, "status"),
    model: readModel(frame.model),
  };
}

function readModel(value: unknown): ModelRef | undefined {
  if (!isRecord(value)) return undefined;
  const provider = readString(value, "provider");
  const id = readString(value, "id");
  if (provider === undefined || id === undefined) return undefined;
  return { providerID: provider, id: id };
}

function isRunningStatus(status: string | undefined): boolean {
  return status === "running" || status === "waiting_input" || status === "compacting";
}

function requireSuccess(frame: TransportFrame, command: string): void {
  if (frame.success === true) return;
  throw new BridgeTransportFailure("pull_failed", command + " was refused: " + responseError(frame));
}

function requireRecord(value: unknown, where: string): TransportFrame {
  if (!isRecord(value)) throw new BridgeTransportFailure("pull_failed", where + " is not an object");
  return value;
}

function requireArray(record: TransportFrame, key: string, where: string): readonly unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new BridgeTransportFailure("pull_failed", where + "." + key + " is not an array");
  return value;
}

function requireText(record: TransportFrame, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BridgeTransportFailure("pull_failed", where + "." + key + " is not a non-empty string");
  }
  return value;
}

function requireTimestamp(record: TransportFrame, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BridgeTransportFailure("pull_failed", where + "." + key + " is not a finite number");
  }
  return value;
}

function requireJsonObject(value: unknown, where: string): { [key: string]: JsonValue } {
  const json = jsonValue(value);
  if (json === undefined || json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new BridgeTransportFailure("pull_failed", where + " is not a JSON object");
  }
  return json;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items: JsonValue[] = [];
    for (const item of value) {
      const converted = jsonValue(item);
      if (converted === undefined) return undefined;
      items.push(converted);
    }
    return items;
  }
  if (isRecord(value)) {
    const fields: { [key: string]: JsonValue } = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = jsonValue(item);
      if (converted === undefined) return undefined;
      fields[key] = converted;
    }
    return fields;
  }
  return undefined;
}

export type BridgeHostOpsDeps = {
  readonly transport: () => BridgeTransport | undefined;
  readonly data: BridgeData;
  readonly sessions: SessionRegistry;
  readonly routingById: Map<string, string>;
  readonly statusById: Map<string, HostSessionStatus>;
  readonly recallRouting: (status: HostSessionStatus) => void;
  readonly pulled: Set<string>;
  readonly interaction: InteractionController;
  readonly cwd: string;
};

export type BridgeHostOps = {
  readonly switchModel: (input: {
    readonly sessionID: string;
    readonly providerID: string;
    readonly modelID: string;
    readonly variant?: string;
  }) => Promise<unknown>;
  readonly createSession: (input: {
    readonly id?: string;
    readonly parentID?: string;
    readonly title?: string;
    readonly directory?: string;
  }) => Promise<SessionInfo>;
  readonly forkSession: (input: { readonly sessionID: string; readonly before?: string }) => Promise<SessionInfo>;
  readonly revertStage: (input: {
    readonly sessionID: string;
    readonly messageID: string;
    readonly files?: boolean;
  }) => Promise<{ readonly messageID: string }>;
  readonly revertCommit: (input: { readonly sessionID: string }) => Promise<void>;
  readonly revertClear: (input: { readonly sessionID: string }) => Promise<void>;
  /** The client message channel's edit member; the transcript row id is resolved to the host entry id. */
  readonly editMessage: (input: MessageChannelEditInput) => Promise<MessageChannelEditOutcome>;
  /** The assistant-side edit; same addressing, and the host demands the target be an assistant message. */
  readonly editAssistantMessage: (input: MessageChannelEditInput) => Promise<MessageChannelEditOutcome>;
  readonly continueFromLeaf: (input: MessageChannelContinueInput) => Promise<void>;
};

/**
 * The host commands the TUI needs but cannot reach itself: the launcher owns the transport, so every
 * one of these is built here and handed to the client surface as a plain promise. Kept out of the
 * launch function so a QA case can drive the shipped code against a real host without drawing a TUI.
 */
export function createBridgeHostOps(deps: BridgeHostOpsDeps): BridgeHostOps {
  let createSequence = 0;

  const transportOf = (): BridgeTransport => {
    const transport = deps.transport();
    if (transport === undefined) throw new BridgeTransportFailure("stream_closed", "the bridge transport is not open");
    return transport;
  };

  const rootDurableId = (durableId: string): string | undefined => {
    let current: string | undefined = durableId;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const parent: string | undefined = deps.data.hostSession(current)?.parentID;
      if (parent === undefined) return current;
      current = parent;
    }
    return undefined;
  };

  const statusOf = (sessionID: string): HostSessionStatus => {
    const status = deps.statusById.get(sessionID);
    if (status === undefined) {
      throw new BridgeTransportFailure("pull_failed", "the host never announced session " + sessionID);
    }
    return status;
  };

  /**
   * One host edit command: resolve the transcript row to the host entry, send it, and read back the
   * documented outcome. The host is the one that decides whether the entry has the right role.
   */
  const editEntry = async (
    command: "edit_user_message" | "edit_assistant_message",
    input: MessageChannelEditInput,
  ): Promise<MessageChannelEditOutcome> => {
    const transport = transportOf();
    const status = statusOf(input.sessionID);
    const entryId = hostEntryIdFor(deps.data, input.sessionID, input.messageID);
    const answer = await transport.request(command, {
      sessionId: status.routingId,
      entryId: entryId,
      text: input.text,
      ...(input.expectedLeafID === undefined ? {} : { expectedLeafId: input.expectedLeafID }),
    });
    if (answer.success !== true) throw messageChannelRefusal(answer, command);
    const payload = requireRecord(answer.data, command + ".data");
    const outcome = readEditOutcome(payload, command);
    const leaf = payload.leafId;
    if (!(leaf === null || typeof leaf === "string")) {
      throw new BridgeTransportFailure("pull_failed", command + ".data.leafId is neither a string nor null");
    }
    const entry = isRecord(payload.entry) ? readString(payload.entry, "id") : undefined;
    /* The active branch just moved, so the transcript the TUI reads is re-read from the host. */
    await pullHostSession(transport, deps.data, deps.sessions, status);
    return { outcome: outcome, leafID: leaf, ...(entry === undefined ? {} : { entryID: entry }) };
  };

  return {
    switchModel: async (input) => {
      const transport = transportOf();
      const status = statusOf(input.sessionID);
      const answer = await transport.request("set_model", {
        sessionId: status.routingId,
        provider: input.providerID,
        modelId: input.modelID,
      });
      requireSuccess(answer, "set_model");
      if (input.variant !== undefined && input.variant.length > 0) {
        const levelsAnswer = await transport.request("get_available_thinking_levels", { sessionId: status.routingId });
        requireSuccess(levelsAnswer, "get_available_thinking_levels");
        const levels = readThinkingLevels(levelsAnswer.data) ?? [];
        if (!supportsThinkingLevel(input.variant, levels)) {
          throw new BridgeTransportFailure(
            "protocol_failure",
            "the model offers " + (levels.length === 0 ? "no thinking levels" : levels.join(", ")) + ", not " + input.variant,
          );
        }
        const setAnswer = await transport.request("set_thinking_level", { sessionId: status.routingId, level: input.variant });
        requireSuccess(setAnswer, "set_thinking_level");
        deps.interaction.setThinkingLevel(input.variant);
      }
      await pullHostSession(transport, deps.data, deps.sessions, status);
      return answer.data;
    },

    createSession: async (input) => {
      const transport = transportOf();
      const directory = input.directory ?? deps.cwd;
      const parent = input.parentID === undefined ? undefined : deps.statusById.get(input.parentID);
      if (input.parentID !== undefined && parent === undefined) {
        throw new BridgeTransportFailure("pull_failed", "the host never announced parent session " + input.parentID);
      }
      const payload: TransportFrame = { cwd: directory };
      if (input.id !== undefined) payload.durableSessionId = input.id;
      if (parent !== undefined) {
        payload.spawnedBy = {
          parentSessionId: parent.durableId,
          rootSessionId: rootDurableId(parent.durableId) ?? parent.durableId,
          taskId: "bridge-child-" + String((createSequence += 1)),
        };
      }
      const answer = await transport.request("open_session", payload);
      requireSuccess(answer, "open_session");
      const opened = requireRecord(answer.data, "open_session.data");
      const state = requireRecord(opened.state, "open_session.data.state");
      const durableId = requireText(state, "sessionId", "open_session.data.state");
      if (input.id !== undefined && durableId !== input.id) {
        throw new BridgeTransportFailure(
          "pull_failed",
          "the host opened " + durableId + " instead of the id the client minted (" + input.id + ")",
        );
      }
      const status: HostSessionStatus = {
        routingId: requireText(opened, "sessionId", "open_session.data"),
        durableId: durableId,
        directory: readString(state, "cwd") ?? directory,
        status: state.isStreaming === true ? "running" : "idle",
        model: readModel(state.model),
      };
      if (input.title !== undefined && input.title.length > 0) {
        const renamed = await transport.request("set_session_name", { sessionId: status.routingId, name: input.title });
        requireSuccess(renamed, "set_session_name");
      }
      deps.recallRouting(status);
      deps.pulled.add(durableId);
      await pullHostSession(transport, deps.data, deps.sessions, status);
      const openedInfo = deps.data.hostSession(durableId);
      if (openedInfo === undefined) {
        throw new BridgeTransportFailure("pull_failed", "the host opened a session it will not answer for");
      }
      return openedInfo;
    },

    forkSession: async (input) => {
      const transport = transportOf();
      const status = statusOf(input.sessionID);
      const command = input.before === undefined ? "clone" : "fork";
      const answer = await transport.request(command, {
        sessionId: status.routingId,
        ...(input.before === undefined ? {} : { entryId: input.before }),
      });
      requireSuccess(answer, command);
      const payload = requireRecord(answer.data, command + ".data");
      if (payload.cancelled === true) throw new BridgeTransportFailure("pull_failed", "the host cancelled the " + command);
      const stateAnswer = await transport.request("get_state", { sessionId: status.routingId });
      requireSuccess(stateAnswer, "get_state");
      const state = requireRecord(stateAnswer.data, "get_state.data");
      const durableId = requireText(state, "sessionId", "get_state.data");
      if (durableId === status.durableId) {
        throw new BridgeTransportFailure("pull_failed", "the " + command + " produced no new session on this connection");
      }
      deps.routingById.delete(status.durableId);
      deps.statusById.delete(status.durableId);
      const next: HostSessionStatus = {
        routingId: status.routingId,
        durableId: durableId,
        directory: readString(state, "cwd") ?? status.directory,
        status: state.isStreaming === true ? "running" : "idle",
        model: readModel(state.model),
      };
      deps.recallRouting(next);
      deps.pulled.add(durableId);
      await pullHostSession(transport, deps.data, deps.sessions, next);
      const info = deps.data.hostSession(durableId);
      if (info === undefined) throw new BridgeTransportFailure("pull_failed", "the host forked into a session it will not answer for");
      return info;
    },

    revertStage: async (input) => {
      if (input.files === true) {
        throw new BridgeTransportFailure(
          "protocol_failure",
          "the host keeps no file snapshots, so a revert cannot restore file changes",
        );
      }
      const branch = deps.data.hostBranchFor(input.sessionID);
      const held = branch?.entries.some((entry) => entry.id === input.messageID) === true;
      if (!held) {
        throw new BridgeTransportFailure("pull_failed", "message " + input.messageID + " is not an entry of the host session tree");
      }
      deps.data.setHostRevert(input.sessionID, { messageID: input.messageID });
      return { messageID: input.messageID };
    },

    revertClear: async (input) => {
      deps.data.setHostRevert(input.sessionID, null);
    },

    revertCommit: async (input) => {
      const staged = deps.data.hostRevertFor(input.sessionID);
      if (staged === undefined) return;
      const transport = transportOf();
      const status = statusOf(input.sessionID);
      const answer = await transport.request("navigate_tree", { sessionId: status.routingId, entryId: staged.messageID });
      requireSuccess(answer, "navigate_tree");
      const outcome = readNavigateOutcome(answer.data);
      if (outcome === undefined) {
        throw new BridgeTransportFailure("pull_failed", "navigate_tree answered without a documented outcome");
      }
      /* A cancelled navigation leaves the conversation where it was, so the boundary stays staged. */
      if (outcome.outcome !== "navigated") return;
      deps.data.setHostRevert(input.sessionID, null);
      await pullHostSession(transport, deps.data, deps.sessions, status);
    },

    /*
     * The two host edits share one path: both address a message entry, both answer the same documented
     * outcomes, and both leave the abandoned branch in the session file. They differ only in which
     * role the host accepts, which is the host's check and not the bridge's.
     */
    editMessage: async (input) => editEntry("edit_user_message", input),

    editAssistantMessage: async (input) => editEntry("edit_assistant_message", input),

    continueFromLeaf: async (input) => {
      const transport = transportOf();
      const status = statusOf(input.sessionID);
      const answer = await transport.request("continue_from_leaf", { sessionId: status.routingId });
      if (answer.success !== true) throw messageChannelRefusal(answer, "continue_from_leaf");
      /* The turn streams like any other; the pull only records the leaf it starts from. */
      await pullHostSession(transport, deps.data, deps.sessions, status);
    },
  };
}

/**
 * The three documented edit outcomes. `cancelled` is an extension stopping the navigation or the
 * branch summary it asked for; the host reports it as an outcome, not a failure, so it stays one here
 * rather than being flattened into a protocol error.
 */
function readEditOutcome(payload: TransportFrame, command: string): MessageChannelEditOutcome["outcome"] {
  const outcome = payload.outcome;
  if (outcome === "edited" || outcome === "unchanged" || outcome === "cancelled") return outcome;
  throw new BridgeTransportFailure("pull_failed", command + " answered without a documented outcome");
}

const MESSAGE_CHANNEL_ERROR_CODES: readonly MessageChannelFailureCode[] = [
  "streaming",
  "not_found",
  "not_user",
  "not_assistant",
  "empty",
  "stale_leaf",
  "nothing_to_continue",
  "leaf_not_assistant",
];

/** The host's own `errorCode` is what a caller acts on, so a documented one travels as itself. */
function messageChannelRefusal(answer: TransportFrame, command: string): Error {
  const code = readString(answer, "errorCode");
  if (code !== undefined && (MESSAGE_CHANNEL_ERROR_CODES as readonly string[]).includes(code)) {
    return new MessageChannelRefused(code as MessageChannelFailureCode, responseError(answer));
  }
  return new BridgeTransportFailure("protocol_failure", command + " was refused: " + responseError(answer));
}

/**
 * The host entry id a transcript row names. The row's id is the client-shaped id the bridge minted and
 * the host entry id travels in the row's metadata; a caller that passes the host entry id directly is
 * accepted when the session tree holds it. A row with neither cannot address the host, so it refuses.
 */
function hostEntryIdFor(data: BridgeData, sessionID: string, messageID: string): string {
  const row = data.hostMessagesFor(sessionID).find((candidate) => candidate.id === messageID);
  const bound = row?.metadata?.["hostEntryID"];
  if (typeof bound === "string" && bound.length > 0) return bound;
  if (data.hostBranchFor(sessionID)?.entries.some((entry) => entry.id === messageID) === true) return messageID;
  throw new BridgeTransportFailure(
    "pull_failed",
    "message " + messageID + " has no host entry id in this session; the transcript and the host tree do not agree",
  );
}

export async function launchBridgeTui(
  options: BridgeLaunchOptions,
  report?: (state: BridgeLaunchReport) => void,
): Promise<BridgeLaunchReport> {
  /* The host reads `<agentDir>/settings.json` at start, and `--key-record` names a file inside that
     directory, so the agent directory is known before this process dials anything. Staging here is
     what makes the next `omo daemon run` load the companion extension; a launch without a configured
     or shipped entry writes nothing. */
  const staged = stageCompanionExtensionProfile({ agentDir: dirname(dirname(dirname(options.keyRecord))) });
  if (staged !== undefined && staged.action !== "unchanged") {
    process.stderr.write(
      "bridge-log: companion extension profile " +
        staged.action +
        " at " +
        staged.path +
        (staged.detail === undefined ? "" : " (" + staged.detail + ")") +
        (staged.extensions.length === 0 ? "" : ": " + staged.extensions.join(", ")) +
        "\n",
    );
  }
  let reached: BridgeLaunchReport = {
    state: "failed",
    code: "dial_failed",
    detail: "the transport was never dialled",
  };
  let closeTransport = () => {};
  const data = new BridgeData();
  const sessions = new SessionRegistry();
  let bridgeTransport: BridgeTransport | undefined;
  const pulled = new Set<string>();
  const waiting: HostSessionStatus[] = [];
  /* A session that appears after the first pull (opened or attached by another client) is pulled
     as soon as its status record arrives, so every session the TUI can select holds its messages. */
  /*
   * The TUI addresses sessions by durable id; the host's commands address them by the routing id it
   * published with `session_status`. Both are recorded as statuses arrive, and only a session the host
   * actually announced can be prompted.
   */
  const routingById = new Map<string, string>();
  const statusById = new Map<string, HostSessionStatus>();
  const recallRouting = (status: HostSessionStatus) => {
    routingById.set(status.durableId, status.routingId);
    statusById.set(status.durableId, status);
    /* The host dialog tags its session with the routing handle; the rules are keyed by the durable id,
       so the mapping has to live where the dialog handling can read it. */
    data.rememberRoutingId(status.durableId, status.routingId);
  };
  const pullLive = (status: HostSessionStatus) => {
    recallRouting(status);
    const transport = bridgeTransport;
    if (transport === undefined) {
      waiting.push(status);
      return;
    }
    if (pulled.has(status.durableId)) return;
    pulled.add(status.durableId);
    void pullHostSession(transport, data, sessions, status).catch((error: unknown) => {
      pulled.delete(status.durableId);
      process.stderr.write("bridge-log: host pull failed for " + status.routingId + ": " + describeError(error) + "\n");
    });
  };
  const requester = createExtensionRequester({
    write: (frame) => {
      if (bridgeTransport === undefined) throw new Error("the bridge transport is not open");
      bridgeTransport.send(frame);
    },
  });
  data.setExtensionRequester(requester);

  /*
   * A settled turn is re-read from the host: the assistant message and the stop reason that says how
   * the turn ended are appended at that boundary, and the live overlay is empty once the row is idle,
   * so without this read the transcript would lose the reply the turn just produced. A read already in
   * flight for the same session is left to finish instead of racing a second one.
   */
  const settled = new Set<string>();
  const refreshSettledSession = (status: HostSessionStatus) => {
    const transport = bridgeTransport;
    if (transport === undefined || settled.has(status.durableId)) return;
    settled.add(status.durableId);
    void pullHostSession(transport, data, sessions, status)
      .catch((error: unknown) => {
        process.stderr.write(
          "bridge-log: refresh after a settled turn failed for " + status.routingId + ": " + describeError(error) + "\n",
        );
      })
      .finally(() => settled.delete(status.durableId));
  };

  const entry = createBridgeEntry({ socket: options.socket, mini: options.mini }, async (target) => {
    const transport = await openBridgeTransport({ ...options, socket: target }, (frame) => {
      routeInboundFrame(frame, {
        acceptExtensionAnswer: (id, answer) => requester.accept(id, answer),
        publish: (inbound) => {
          /* Every frame reaches the event projection; a status record is also applied to the roster here. */
          data.publishEvent(inbound);
          const status = liveSessionStatus(inbound);
          if (status === undefined) return;
          const before = sessions.list().find((candidate) => candidate.durableId === status.durableId)?.state;
          const effect = liveStatusEffect(before, status);
          applyLiveStatus(sessions, status);
          /* The row is bridge state: without this the composer keeps drawing the status it last read. */
          if (effect !== "steady") data.statusChanged();
          pullLive(status);
          if (effect === "settled") refreshSettledSession(status);
        },
      });
    });
    bridgeTransport = transport;
    reached = transport.report;
    closeTransport = () => {
      requester.failAll("the bridge transport closed before the host answered");
      transport.close();
    };
    if (reached.state !== "authenticated") {
      const code: BridgeFailureCode = reached.state === "unproven" ? "connection_unproven" : failureCode(reached);
      throw new BridgeTransportFailure(code, reached.detail);
    }
    for (const status of waiting.splice(0)) pullLive(status);
    try {
      const outcome = await pullHostState(transport, data, sessions);
      /* The snapshot is the only announcement a quietly connected host gives for its sessions, so the
         routing handles it published have to be recorded here or `session.prompt` would call every
         session "never announced" until some later live status frame repeated it. */
      for (const status of outcome.statuses) recallRouting(status);
      for (const id of outcome.sessionIds) pulled.add(id);
    } catch (error) {
      reached = reportOf(error);
      throw error;
    }
  });

  const connection = await entry.connect();
  const state: BridgeLaunchReport =
    reached.state === "authenticated" && connection !== "ready"
      ? {
          state: "failed",
          code: "entry_state_mismatch",
          detail: "the entry reported " + connection + " after an authenticated handshake",
        }
      : reached;
  report?.(state);
  if (state.state !== "authenticated") {
    closeTransport();
    return state;
  }

  if (options.mini) {
    /* Mini runs against the same authenticated socket: the transport is injected, never re-dialled. */
    const transport = bridgeTransport;
    if (transport === undefined) throw new BridgeTransportFailure("connection_unproven", "the bridge transport is not open");
    const { runMini } = await import("./mini");
    try {
      const program = Effect.gen(function* () {
        const global = yield* Global.Service;
        yield* Effect.promise(() =>
          runMini({
            bridge: {
              data: data,
              connect: async () => ({
                report: transport.report,
                send: transport.send,
                close: transport.close,
              }),
            },
            replay: true,
            paths: { home: global.home, state: global.state, log: global.log },
          }),
        );
      });
      await Effect.runPromise(Effect.scoped(Effect.provide(program, LayerNode.compile(Global.node))));
    } finally {
      entry.close();
      closeTransport();
    }
    return state;
  }

  const sendPrompt = createBridgePromptSender({
    transport: () => bridgeTransport,
    data: data,
    sessions: sessions,
    routingId: (durableId) => routingById.get(durableId),
    status: (durableId) => statusById.get(durableId),
  });

  /*
   * The bridge's own per-session permission rules. The host publishes a preset, not a rule set, so the
   * document lives with the bridge's config directory; an absent file means no rule can answer an ask
   * and every dialog is surfaced as before, and an unreadable one is reported instead of dropping rules
   * silently.
   */
  const configDirectory = process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config;
  const permissionRules = new SessionPermissionRules((() => {
    try {
      return loadPermissionRuleDocument(permissionRulesPath(configDirectory));
    } catch (error) {
      process.stderr.write("bridge-log: permission rules not loaded: " + describeError(error) + "\n");
      return undefined;
    }
  })());

  /*
   * The terminal surface is backed by the fork's own persistent PTY service, driven in this process.
   * The runtime it builds is disposed with the launcher so no daemon outlives the TUI.
   */
  const pty = createBridgePty();
  /* Whatever closes the launcher also releases the PTY runtime, so no terminal daemon outlives the TUI. */
  const closeBeforePty = closeTransport;
  closeTransport = () => {
    void pty.dispose();
    closeBeforePty();
  };
  const interaction = new InteractionController();
  const ops = createBridgeHostOps({
    transport: () => bridgeTransport,
    data: data,
    sessions: sessions,
    routingById: routingById,
    statusById: statusById,
    recallRouting: recallRouting,
    pulled: pulled,
    interaction: interaction,
    cwd: options.cwd,
  });

  const context = createBridgeTuiContext(
    {
      data: data,
      pty: pty,
      switchModel: ops.switchModel,
      createSession: ops.createSession,
      forkSession: ops.forkSession,
      revertStage: ops.revertStage,
      revertCommit: ops.revertCommit,
      revertClear: ops.revertClear,
      editMessage: ops.editMessage,
      editAssistantMessage: ops.editAssistantMessage,
      continueFromLeaf: ops.continueFromLeaf,
      permissionRules: permissionRules,
      defaultLocation: { directory: options.cwd },
      sessions: sessions,
      dialogs: new DialogRegistry(),
      interaction: interaction,
      sendPrompt: sendPrompt,
    },
    () => entry.state(),
  );
  context.tuiData.hostDialogs.useSender(bridgeTransport?.send);
  /*
   * The companion extension's MCP requests reach this process as `tui.pack.mcp.request` extension
   * events; this client runs them and answers with `tui.pack.mcp.reply` over the same transport. It
   * is composed unconditionally: without a terminal service it answers every request with an error,
   * which is what the extension can act on, instead of leaving the request unanswered.
   */
  const clientMcp = connectBridgeMcp(data, {
    execute: createBridgeMcpExecutor(pty),
    onError: (message) => process.stderr.write("bridge-log: client MCP: " + message + "\n"),
    /* The extension names a session by the id it holds; the reply frame needs this connection's
       routing handle, which only the launcher's map knows. */
    routeSession: (sessionID) => routingById.get(sessionID),
  });
  const closeBeforeMcp = closeTransport;
  closeTransport = () => {
    clientMcp.stop();
    closeBeforeMcp();
  };
  /* The TUI is written against the solid JSX runtime, which bun only supplies through the
     `@opentui/solid/preload` entry of a bunfig.toml. Launching from a directory without one makes bun
     fall back to react/jsx-dev-runtime and fail with a module error that says nothing about the cause,
     so that case is reported for what it is instead of as a mysterious import failure. */
  const tuiModules = await Promise.all([import("@opencode/tui/config"), import("@opencode/tui")]).catch(
    (error: unknown) => {
      const detail = describeError(error);
      if (detail.includes("react/jsx-dev-runtime")) {
        throw new BridgeTransportFailure(
          "protocol_failure",
          "the TUI needs the solid JSX preload: run from packages/cli (its bunfig.toml preloads @opentui/solid/preload) — " + detail,
        );
      }
      throw error;
    },
  );
  const { Config } = tuiModules[0];
  const { run } = tuiModules[1];
  /*
   * The TUI's approval switch is its config document's `session.permissions`, and the host publishes
   * a preset rather than a rule set. `full-access` is the one preset with no approval boundary, so it
   * is the only one the TUI shows as `autoaccept`; every other preset keeps its per-call prompt.
   */
  const permissionMode = (): "autoaccept" | "prompt" | undefined => {
    for (const session of data.hostSessionList()) {
      const reported = data.hostPermissionFor(session.id);
      if (reported === undefined) continue;
      return reported.effective === "full-access" ? "autoaccept" : "prompt";
    }
    return undefined;
  };
  const approval = permissionMode();
  /* Theme and keybinds are the CLI's own TUI document, not a host surface: the host refuses its config
     RPC, so the local `cli.json` is read here and the host's approval preset is layered over it. */
  const tuiConfig = createBridgeTuiConfig({
    directory: process.env.OPENCODE_CONFIG_DIR ?? Global.Path.config,
    decode: (value) => Option.getOrUndefined(Schema.decodeUnknownOption(Config.Info)(value)),
    overlay: approval === undefined ? {} : { session: { permissions: approval } },
  });
  const tui = run({
    app: {
      name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
      version: OPENCODE_VERSION,
      channel: process.env.OPENCODE_TUI_CHANNEL ?? OPENCODE_CHANNEL,
      highlights: OPENCODE_HIGHLIGHTS,
    },
    // Bridge mode has no HTTP endpoint: the in-process adapter above replaces it.
    server: { local: true },
    args: {
      continue: false,
      sessionID: undefined,
      newSessionID: undefined,
      prompt: undefined,
      auto: false,
    },
    config: {
      path: tuiConfig.path,
      get: tuiConfig.get,
      update: async () => {
        throw new BridgeTransportFailure("protocol_failure", "the bridge launcher does not persist TUI config");
      },
    },
    packages: {
      prepare: async () => {
        throw new BridgeTransportFailure("protocol_failure", "the bridge launcher installs no plugin packages");
      },
    },
    environment: Env.session(),
    bridgeData: context.tuiData,
    bridgeApi: context.api,
    /* The terminal pane reads this when the launcher owns the pty service in this process. */
    bridgePty: pty,
    log: (level, message) => {
      // The renderer owns the screen; only fatal conditions are worth a stderr line.
      if (level === "error") process.stderr.write("bridge-log: " + message + "\n");
    },
  });

  try {
    // Same execution seam as the command handler: build the Global layer, then run through it.
    const program = Effect.gen(function* () {
      const global = yield* Layer.build(LayerNode.compile(Global.node));
      /* The TUI's effect is typed against the services its own tree needs; every one of them is built by
         the Global layer above, which is why the context is passed rather than re-provided here. */
      yield* Effect.promise(() => Effect.runPromiseWith(global)(tui as Effect.Effect<void, unknown, never>));
    });
    await Effect.runPromise(Effect.scoped(program));
  } finally {
    entry.close();
    closeTransport();
  }
  return state;
}

/**
 * One inbound frame from the transport. A `response` the request table did not claim is an answer to
 * an extension request and belongs to the correlator; every other frame is host state or a host
 * event and is published.
 *
 * The discriminator is the frame's `type`, never the presence of an `id`. `extension_ui_request` and
 * `question_resolved` carry ids of the host's own, and reading those as answer correlations dropped
 * every permission prompt and question the host asked before anything could see it.
 */
export function routeInboundFrame(
  frame: TransportFrame,
  plan: {
    /** An id the extension correlator does not know is a late or duplicate answer, which its own bookkeeping reports. */
    readonly acceptExtensionAnswer: (id: string, frame: TransportFrame) => void;
    readonly publish: (frame: TransportFrame) => void;
  },
): void {
  const answerId = frame.type === "response" ? readString(frame, "id") : undefined;
  if (answerId === undefined) {
    plan.publish(frame);
    return;
  }
  plan.acceptExtensionAnswer(answerId, frame);
}


/**
 * Reads the session tree with a bounded number of pages. `get_entries` is documented as an
 * append-order list with a durable entry-id cursor and a `leafId` marking the current branch
 * (upstream/senpi/packages/coding-agent/docs/rpc.md, get_entries). The pull stops at the first
 * response without `nextSince`, and a page that repeats a cursor fails the pull instead of looping.
 */
async function pullHostBranch(
  transport: BridgeTransport,
  status: HostSessionStatus,
): Promise<BridgeBranchSnapshot> {
  const entries: BridgeBranchEntry[] = [];
  let leafId: string | null = null;
  let since: string | undefined = undefined;
  const seen = new Set<string>();
  for (let page = 0; page < BRANCH_PAGE_LIMIT; page += 1) {
    const request: Record<string, unknown> = { type: "get_entries", sessionId: status.routingId };
    if (since !== undefined) request.since = since;
    const response = await transport.request("get_entries", request);
    requireSuccess(response, "get_entries");
    const payload = requireRecord(response.data, "get_entries.data");
    const rawEntries = requireArray(payload, "entries", "get_entries.data");
    for (const raw of rawEntries) entries.push(projectBranchEntry(raw));
    const leaf = payload.leafId;
    if (typeof leaf === "string" || leaf === null) leafId = leaf;
    const next = payload.nextSince;
    if (typeof next !== "string") return { leafId: leafId, entries: entries };
    if (seen.has(next)) throw new BridgeTransportFailure("pull_failed", "get_entries repeated the cursor " + next);
    seen.add(next);
    since = next;
  }
  throw new BridgeTransportFailure("pull_failed", "get_entries did not finish within " + String(BRANCH_PAGE_LIMIT) + " pages");
}

/** One session entry, reduced to what the todo reconstruction needs. */
function projectBranchEntry(raw: unknown): BridgeBranchEntry {
  const entry = requireRecord(raw, "get_entries.entries[]");
  const id = requireText(entry, "id", "get_entries.entries[]");
  const parent = entry.parentId;
  if (parent !== undefined && parent !== null && typeof parent !== "string")
    throw new BridgeTransportFailure("pull_failed", "get_entries entry " + id + " has a non-string parentId");
  const customType = entry.customType;
  if (customType !== undefined && customType !== null && typeof customType !== "string")
    throw new BridgeTransportFailure("pull_failed", "get_entries entry " + id + " has a non-string customType");
  return {
    id: id,
    parentId: typeof parent === "string" ? parent : null,
    customType: typeof customType === "string" ? customType : null,
    data: entry,
  };
}

function failed(code: BridgeFailureCode, detail: string): BridgeTransport {
  return {
    report: { state: "failed", code: code, detail: detail },
    close: () => {},
    send: () => {
      throw new BridgeTransportFailure("stream_closed", "the transport never opened");
    },
    request: async () => {
      throw new BridgeTransportFailure("stream_closed", "the transport never opened");
    },
  };
}

function reportOf(error: unknown): BridgeLaunchReport {
  if (error instanceof BridgeTransportFailure) return { state: "failed", code: error.code, detail: error.message };
  return { state: "failed", code: "protocol_failure", detail: describeError(error) };
}

function failureCode(report: BridgeLaunchReport): BridgeFailureCode {
  if (report.code === "authenticated") return "protocol_failure";
  return report.code;
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BridgeTransportFailure("handshake_timeout", what + " did not answer within " + timeoutMs + "ms"));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function proof(key: Uint8Array, parts: readonly string[]): Buffer {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest();
}

function sameBytes(expected: Buffer, received: Buffer): boolean {
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}

function isRecord(value: unknown): value is TransportFrame {
  if (typeof value !== "object" || value === null) return false;
  return !Array.isArray(value);
}

function readString(source: TransportFrame, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readAuth(value: unknown): LaunchAuth | undefined {
  if (!isRecord(value)) return undefined;
  const launchId = readString(value, "launch_id");
  const serverNonce = readString(value, "server_nonce");
  const serverProof = readString(value, "server_proof");
  if (launchId === undefined || launchId.length === 0) return undefined;
  if (serverNonce === undefined || serverProof === undefined) return undefined;
  return { launchId: launchId, serverNonce: serverNonce, serverProof: serverProof };
}

function requireRecordedProof(auth: LaunchAuth) {
  if (!HEX_64.test(auth.serverNonce)) {
    throw new BridgeTransportFailure("protocol_failure", "the server nonce is not 64 lowercase hex characters");
  }
  if (!HEX_64.test(auth.serverProof)) {
    throw new BridgeTransportFailure("protocol_failure", "the server proof is not 64 lowercase hex characters");
  }
}

function responseError(frame: TransportFrame): string {
  const error = readString(frame, "error");
  const code = readString(frame, "errorCode");
  if (error === undefined) return "the host answered with success=false";
  return error + (code === undefined ? "" : " (" + code + ")");
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Reads the host-published record exactly the way the documented client does: O_NOFOLLOW on the
 * file, a user-owned 0600 regular file, a 0700 `keys` directory and no group/other write on the
 * `rpc` and agent directories. Key material is never printed or returned outside this module.
 */
function loadKeyRecord(recordPath: string): KeyRecord {
  requireDirectory(dirname(recordPath), "rpc/keys", 0o700);
  requireDirectory(dirname(dirname(recordPath)), "rpc", undefined);
  requireDirectory(dirname(dirname(dirname(recordPath))), "agent directory", undefined);
  const fd = (() => {
    try {
      return openSync(recordPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      throw new BridgeTransportFailure("key_record_missing", describeError(error));
    }
  })();
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new BridgeTransportFailure("unsafe_key_record", "the key record is not a regular file");
    if (stat.uid !== currentUid()) {
      throw new BridgeTransportFailure("unsafe_key_record", "the key record is not owned by this user");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new BridgeTransportFailure("unsafe_key_record", "the key record is accessible to group or others");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(fd, "utf8"));
    } catch {
      throw new BridgeTransportFailure("unsafe_key_record", "the key record is not valid JSON");
    }
    if (!isRecord(parsed)) throw new BridgeTransportFailure("unsafe_key_record", "the key record is not an object");
    if (parsed.version !== 1) {
      throw new BridgeTransportFailure("unsafe_key_record", "the key record version is not 1");
    }
    const launchId = readString(parsed, "launch_id");
    const key = readString(parsed, "key");
    if (launchId === undefined || launchId.length === 0) {
      throw new BridgeTransportFailure("unsafe_key_record", "the key record has no launch id");
    }
    if (key === undefined || !HEX_64.test(key)) {
      throw new BridgeTransportFailure("unsafe_key_record", "the key record does not hold a 32-byte hex key");
    }
    return { launchId: launchId, key: Buffer.from(key, "hex") };
  } finally {
    closeSync(fd);
  }
}

function requireDirectory(path: string, what: string, exactMode: number | undefined) {
  const stat = (() => {
    try {
      return lstatSync(path);
    } catch (error) {
      throw new BridgeTransportFailure("unsafe_key_record", what + " is missing: " + describeError(error));
    }
  })();
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new BridgeTransportFailure("unsafe_key_record", what + " is not a plain directory");
  }
  if (stat.uid !== currentUid()) {
    throw new BridgeTransportFailure("unsafe_key_record", what + " is not owned by this user");
  }
  if (exactMode !== undefined && (stat.mode & 0o777) !== exactMode) {
    throw new BridgeTransportFailure("unsafe_key_record", what + " is not " + exactMode.toString(8));
  }
  if (exactMode === undefined && (stat.mode & 0o022) !== 0) {
    throw new BridgeTransportFailure("unsafe_key_record", what + " is group or other writable");
  }
}

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : -1;
}

if (import.meta.main) {
  const write = (line: string) => process.stderr.write(line + "\n");
  const parsed = (() => {
    try {
      return parseBridgeLaunchArgs(process.argv.slice(2));
    } catch (error) {
      write("BRIDGE_STATE=failed");
      write("BRIDGE_STATE_DETAIL=usage: " + describeError(error));
      return undefined;
    }
  })();
  if (parsed === undefined) {
    process.exitCode = 2;
  } else {
    const result = await launchBridgeTui(parsed, (state) => {
      write("BRIDGE_STATE=" + (state.state === "authenticated" ? "ready" : state.state));
      write("BRIDGE_STATE_DETAIL=" + state.code + (state.detail.length === 0 ? "" : ": " + state.detail));
    });
    process.exitCode = result.state === "authenticated" ? 0 : 1;
  }
}
