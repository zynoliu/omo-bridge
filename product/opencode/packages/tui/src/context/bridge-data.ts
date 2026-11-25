import type {
  FormField,
  LocationRef,
  OpenCodeClient,
  OpenCodeEvent,
  Project,
  SessionFormCancelInput,
  SessionFormReplyInput,
  SessionInfo,
  SessionInboxUser,
  SessionMessageInfo,
  SessionPromptInput,
} from "@opencode/client";
import type { Data } from "@opencode/client/solid";
import { createSignal } from "solid-js";
import type {
  MessageChannel,
  MessageChannelContinueInput,
  MessageChannelEditInput,
  MessageChannelEditOutcome,
} from "../../../client/src/message-channel.ts";
import { UnsupportedCapability } from "../../../bridge-core/src/client.ts";
import { applyFormEvent, applyPermissionEvent, decodeHostEvent } from "../../../bridge-core/src/host-event.ts";
import type { HostEventFrame } from "../../../bridge-core/src/host-event.ts";
import { HostDialogStore } from "../../../bridge-core/src/dialogs-host.ts";
import type { HostDialogRequestFrame } from "../../../bridge-core/src/dialogs-host.ts";
import { translatePromptAgentSelection } from "../../../bridge-core/src/prompt-input.ts";
import {
  answerForEffect,
  PERMISSION_DIALOG_TITLE,
  permissionAskOfTitle,
} from "../../../bridge-core/src/permission-rules.ts";
import type { PermissionRuleset, SessionPermissionRules } from "../../../bridge-core/src/permission-rules.ts";
import { decodeHostFrame, encodeHostResponseFrame } from "../../../bridge-core/src/host-frames.ts";
import type { HostResponseAnswer, QuestionRequestFrame, SelectRequestFrame } from "../../../bridge-core/src/host-frames.ts";
import type { BridgeData } from "../../../bridge-core/src/data.ts";
import type { DialogRegistry, InteractionController, SessionRegistry } from "../../../bridge-core/src/index.ts";

export type BridgeTuiDataDeps = {
  readonly data: BridgeData;
  readonly sessions: SessionRegistry;
  readonly dialogs: DialogRegistry;
  readonly interaction: InteractionController;
  readonly defaultLocation: LocationRef;
  /**
   * The bridge client's event stream: the same `api.event` the TUI's client connection consumes.
   * Its only frame is the `server.connected` attachment handshake, and `on`/`listen` deliver
   * exactly what it yields rather than decoding frames of another vocabulary.
   */
  readonly events: OpenCodeClient["event"];
  /**
   * Writes one user prompt to the host and resolves when the host has answered it. The correlation
   * id is the caller's `clientMessageId`: a host with the `effect_ledger` capability adopts it as
   * the input's effect id, and `get_pending_inputs` reports it back, so the row this layer returns
   * is the same row the host answers about rather than an id invented on this side.
   */
  readonly sendPrompt?: (input: BridgePromptSubmission) => Promise<void>;
  /**
   * Opens a session on the host. The launcher owns the transport, so this is the only way a create
   * reaches `open_session`; without it `session.create` refuses instead of admitting a local record.
   */
  readonly createSession?: (input: {
    readonly id?: string;
    readonly title?: string;
    readonly directory?: string;
    /** The session this one is spawned under; the host takes it as `spawnedBy`. */
    readonly parentID?: string;
  }) => Promise<SessionInfo>;
  /**
   * The bridge's own per-session permission rules. Absent means no rule can answer an ask, so every
   * permission dialog is surfaced exactly as it was before this layer had rules.
   */
  readonly permissionRules?: SessionPermissionRules;
  /** `edit_user_message`, carried by the client's message channel (P-739). */
  readonly editMessage?: MessageChannel["edit"];
  /** `edit_assistant_message`, carried by the client's message channel (P-739). */
  readonly editAssistantMessage?: MessageChannel["editAssistantMessage"];
  /** `continue_from_leaf`, carried by the client's message channel (P-739). */
  readonly continueFromLeaf?: MessageChannel["continueFromLeaf"];
};

/** One prompt this adapter hands to the injected sender. */
export type BridgePromptSubmission = {
  readonly sessionID: string;
  readonly text: string;
  readonly clientMessageId: string;
  readonly delivery: "steer" | "queue";
  /**
   * The `agent` selection the caller named, already translated into the prompt text. The launcher
   * records it as host session context; it never becomes an agent switch, because the host has none.
   */
  readonly agentRequest?: { readonly requested: readonly string[] };
};

/** What the prompt surface passes in: the client contract's input, structurally. */
type BridgePromptInput = SessionPromptInput & {
  readonly gate?: Promise<unknown>;
  readonly prepare?: () => unknown;
};

/**
 * Adapts the in-process bridge to the TUI data contract. Session identity, cost, root and
 * status come from host payloads, pending inputs from the host's pending-input report, and
 * `on`/`listen` from the bridge client's own event stream. Surfaces the bridge cannot answer
 * fail loudly; the two the render path reads during layout (`shell.*`, `session.pending.*`) answer
 * with what the host actually delivered and record the remaining gap in `spec/capabilities.json`.
 */
export type BridgeTuiData = Data & {
  /** The raw bridge store, so a surface can subscribe to host frames and issue requests itself. */
  readonly bridgeData: BridgeData;
  /** The session registry the launcher pulled into, so a surface can reopen a recorded session. */
  readonly sessionRegistry: SessionRegistry;
  /**
   * Validated host events. The client data contract types its own subscriptions against the
   * generated event union, so bridge consumers subscribe here instead; rejected frames never arrive.
   */
  readonly onHostEvent: (listener: (event: HostEventFrame) => void) => () => void;
  /**
   * Live dialogs the host is waiting on, in the shape it wrote them: a `select` prompt (a permission
   * ask among others), a structured question, a `confirm`, an `input` or an `editor`. They are not
   * OpenCode permission or form events; the host never emits those, so they are kept in their own
   * store rather than reshaped into one.
   */
  readonly hostDialogs: HostDialogStore;
  /** Validated dialog requests, delivered once per dialog as it opens. */
  readonly onHostDialog: (listener: (dialog: HostDialogRequestFrame) => void) => () => void;
  /**
   * Answers a live host dialog over the sender the launcher injected into `hostDialogs`. Without a
   * sender it throws `UnsupportedCapability` rather than reporting an answer that was not written.
   */
  readonly respondToHostDialog: (requestId: string, answer: HostResponseAnswer) => void;
  readonly session: Data["session"] & {
    /**
     * The bridge's `session.create` takes a `parentID` the client input has no field for: it is the
     * route to a child session, mapped by the opener onto the host's `spawnedBy`. The rest of the
     * input is the client's own, unchanged.
     */
    readonly create: (
      input: Parameters<Data["session"]["create"]>[0] & { readonly parentID?: string },
    ) => ReturnType<Data["session"]["create"]>;
    readonly title: {
      readonly pending: (sessionID: string) => boolean;
      readonly generate: (sessionID: string) => Promise<void>;
    };
    /**
     * The message channel, plus the two members the generated client is missing (P-739): the host's
     * `edit_user_message` and `continue_from_leaf`, with no file restore behind either.
     */
    readonly message: Data["session"]["message"] & MessageChannel;
    /**
     * The bridge's rule set for a session, in the client's own `PermissionRuleset` shape. The same value
     * is on `session.get(sessionID).permissions`; this member is the direct read.
     */
    readonly permission: Data["session"]["permission"] & {
      readonly rules: (sessionID: string) => PermissionRuleset;
    };
    /** What the bridge did with an `agent` selection a prompt named; absent when none was named. */
    readonly agentRequest: (sessionID: string) => ReturnType<BridgeData["promptAgentRecordFor"]>;
  };
};

/** Maps a bridge data layer to the raw store, so a surface can subscribe without a cast. */
export const bridgeStores = new WeakMap<object, BridgeData>()

/** The adapter object itself, for a surface that needs the bridge-only members (dialogs, events). */
export const bridgeAdapters = new WeakMap<object, BridgeTuiData>()

export function createBridgeTuiData(deps: BridgeTuiDataDeps): BridgeTuiData {
  const sessionInfo = (sessionID: string) => deps.data.hostSession(sessionID);

  /*
   * The client data layer is reactive because it writes a store. BridgeData is a plain class whose
   * readers never notify Solid, so this version signal is the store replacement: every read of host
   * state passes through `tracked`, and a pull that lands after the first render repaints instead of
   * leaving the TUI on the snapshot it started with.
   */
  const [revision, setRevision] = createSignal(0);
  deps.data.subscribe(() => setRevision((value) => value + 1));
  const tracked = <Value>(read: () => Value): Value => {
    revision();
    return read();
  };

  const unsupported = (what: string): never => {
    throw new UnsupportedCapability(what);
  };

  /*
   * The rule document is the source of truth; the session rows carry a copy so `session.get().permissions`
   * reports it like any other SessionInfo field. This layer owns the copy, so a rule set changed while the
   * TUI is running lands on the row the TUI reads without a pull.
   */
  const permissionRules = deps.permissionRules;
  if (permissionRules !== undefined) {
    for (const sessionID of permissionRules.sessionIds()) {
      deps.data.setSessionPermissionRules(sessionID, permissionRules.rulesFor(sessionID));
    }
    permissionRules.subscribe((change) => deps.data.setSessionPermissionRules(change.sessionID, change.rules));
  }

  const requireSession = (sessionID: string): SessionInfo => {
    const info = tracked(() => sessionInfo(sessionID));
    if (info === undefined) return unsupported("session:" + sessionID);
    return info;
  };

  const messages = (sessionID: string) => tracked(() => {
    const pulled = deps.data.hostMessagesFor(sessionID);
    const overlay = liveOverlay(sessionID);
    return overlay.length === 0 ? pulled : [...pulled, ...overlay];
  });

  /*
   * While a turn streams, the host has not delivered its assistant message yet. The overlay comes from
   * the stream projector this process is already feeding, so a retry notice, reasoning, partial text and
   * a running tool are visible during the turn instead of appearing only when the pull catches up.
   */
  const liveOverlay = (sessionID: string): SessionMessageInfo[] => {
    const active = deps.sessions.list().some((record) => record.persistentId === sessionID && record.state === "active");
    if (!active) return [];
    const live = deps.data.view().message;
    const rows: SessionMessageInfo[] = [];
    if (live.notice.length > 0) {
      rows.push({ id: "live-notice", type: "system", text: live.notice, description: live.notice } as unknown as SessionMessageInfo);
    }
    const assistant = liveAssistant(live);
    return assistant === undefined ? rows : [...rows, assistant];
  };

  const liveAssistant = (live: { readonly status: string; readonly thinking: string; readonly text: string; readonly tools: readonly { readonly callId: string; readonly arguments: string; readonly result: string | null }[] }): SessionMessageInfo | undefined => {
    if (live.status !== "streaming") return undefined;
    const content: Record<string, unknown>[] = [];
    if (live.thinking.length > 0) content.push({ type: "reasoning", text: live.thinking });
    if (live.text.length > 0) content.push({ type: "text", text: live.text });
    for (const tool of live.tools) {
      content.push({
        type: "tool",
        id: "live-" + tool.callId,
        name: "",
        state:
          tool.result === null
            ? { status: "running", input: tool.arguments, content: [] }
            : { status: "completed", input: tool.arguments, content: [{ type: "text", text: tool.result }], metadata: {} },
      });
    }
    if (content.length === 0) return undefined;
    return {
      id: "live-assistant",
      type: "assistant",
      time: { created: Date.now() },
      model: { providerID: "bridge", id: "live" },
      content: content,
    } as unknown as SessionMessageInfo;
  };

  /*
   * Upstream `resolveRoot` is total: an unknown id resolves to itself, and a `parentID` chain is
   * followed with a cycle guard, so a persisted tab or an unpulled route cannot crash a render.
   */
  const resolveRoot = (sessionID: string): string => {
    let current = sessionID;
    let parentID = sessionInfo(sessionID)?.parentID;
    const seen = new Set([sessionID]);
    while (parentID !== undefined && parentID.length > 0) {
      if (seen.has(parentID)) break;
      seen.add(parentID);
      current = parentID;
      parentID = sessionInfo(parentID)?.parentID;
    }
    return current;
  };

  /*
   * The pending inputs the host reports it still holds, in the client inbox shape. The host reports
   * no enqueue time and its own `state` vocabulary, so `time.created` is NaN ("no timestamp", never
   * a plausible instant) and only `queued` maps to the client's `queue`; every other reported state
   * is no longer waiting behind the turn and reads as `steer`. P-628/P-762 record both gaps.
   */
  const pendingInputs = (sessionID: string): SessionInboxUser[] =>
    tracked(() => deps.data.pendingInputsFor(sessionID)).map(
      (input): SessionInboxUser => ({
        id: input.clientMessageId,
        sessionID: sessionID,
        time: { created: Number.NaN },
        type: "user",
        payload: { text: input.text },
        delivery: input.state === "queued" ? "queue" : "steer",
      }),
    );

  /*
   * The bridge client's own event stream: the same `api.event` the TUI's client connection reads.
   * Its only frame is the attachment handshake, so a subscriber receives exactly what the client
   * received and nothing is synthesized. A stream failure ends the subscription and is reported.
   */
  const onClientEvent = (listener: (event: OpenCodeEvent) => void): (() => void) => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of deps.events.subscribe({ signal: controller.signal })) listener(event);
      } catch (error) {
        if (!controller.signal.aborted) console.error("bridge client event stream failed", error);
      }
    })();
    return () => controller.abort();
  };

  /* the client's own event map, named here so the decoded frame narrows to the subscriber's type */
  type BridgeEventMap = { [Name in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Name }> };

  /* narrows one streamed event to the type a subscriber asked for, so the handler needs no assertion */
  const isEventOfType = <Type extends OpenCodeEvent["type"]>(
    event: OpenCodeEvent,
    type: Type,
  ): event is BridgeEventMap[Type] => event.type === type;

  /* typed by the client data contract itself, so the subscription surface cannot drift from it */
  const on: Data["on"] = (type, handler) =>
    onClientEvent((event) => {
      if (isEventOfType(event, type)) handler(event);
    });

  const listen: Data["listen"] = (handler) =>
    onClientEvent((event) => handler({ name: event.type, details: event }));

  /* The same request answered twice with the same answer grants nothing new, and two dialog surfaces can
     both be listening for one keypress. An identical repeat is dropped; a different answer (cancel after a
     value) still goes through. */
  const answeredDialogs = new Map<string, string>();
  const hostDialogs = new HostDialogStore();
  /* toolCallId -> the reason a deny rule gave, waiting for the host's `Feedback` input dialog. */
  const pendingDenyFeedback = new Map<string, string>();

  /*
   * One answer path for every dialog-shaped surface: the dialog feature, the form members and the rule
   * enforcement below all write an `extension_ui_response` through here, so an answer is never reported
   * as sent without a sender. A routed host scopes the answer by the session the dialog was raised on
   * and refuses one that does not name it, so the dialog's own routing tag travels back with it.
   */
  const writeDialogAnswer = (
    requestId: string,
    sessionId: string | undefined,
    answer: HostResponseAnswer,
  ): boolean => {
    const send = hostDialogs.sender();
    if (send === undefined) return false;
    const key = JSON.stringify(answer);
    if (answeredDialogs.get(requestId) === key) return true;
    const encoded = encodeHostResponseFrame({
      id: requestId + ":response",
      uiRequestId: requestId,
      ...(sessionId === undefined ? {} : { sessionId: sessionId }),
      answer: answer,
    });
    if (!encoded.ok) throw new Error("host dialog response rejected: " + encoded.reason);
    answeredDialogs.set(requestId, key);
    send(encoded.frame);
    /* The host writes no settlement frame for a dialog answer, so the answer itself is published
       and the event projection turns it into the permission/form settlement. */
    deps.data.publishEvent(encoded.frame);
    hostDialogs.resolve(requestId);
    return true;
  };

  const respondToHostDialog = (requestId: string, answer: HostResponseAnswer): void => {
    if (hostDialogs.sender() === undefined) return unsupported("hostDialog.respond");
    writeDialogAnswer(requestId, hostDialogs.get(requestId)?.sessionId, answer);
  };

  const durableIdOf = (sessionId: string | undefined): string =>
    (sessionId === undefined ? undefined : deps.data.durableIdForRouting(sessionId)) ?? sessionId ?? "";

  /*
   * The session's own rules answer the ask before it reaches a person. An allow or deny rule answers the
   * dialog immediately; anything else (including a dialog whose options cannot carry the decision, and a
   * bridge with no answer channel yet) is surfaced exactly as before. The deny reason travels through the
   * host's `Feedback` dialog, which is the only path that puts it in front of the model.
   */
  const enforcePermissionRule = (frame: SelectRequestFrame): boolean => {
    const rules = deps.permissionRules;
    if (rules === undefined) return false;
    const ask = permissionAskOfTitle(frame.title);
    if (ask === undefined) return false;
    const decision = rules.decide(durableIdOf(frame.sessionId), ask);
    if (decision.effect === "ask") return false;
    const answer = answerForEffect(decision.effect, frame.options, decision.rule?.reason);
    if (answer === undefined) return false;
    if (hostDialogs.sender() === undefined) return false;
    if (answer.wantsFeedback && frame.toolCallId !== undefined && decision.rule?.reason !== undefined) {
      pendingDenyFeedback.set(frame.toolCallId, decision.rule.reason);
    }
    return writeDialogAnswer(frame.id, frame.sessionId, { kind: "value", value: answer.value });
  };

  /* The host's follow-up to `Deny with feedback`: an `input` dialog carrying the same tool call id. */
  const answerDenyFeedback = (frame: HostDialogRequestFrame): boolean => {
    if (frame.method !== "input") return false;
    const toolCallId = frame.toolCallId;
    if (toolCallId === undefined) return false;
    const reason = pendingDenyFeedback.get(toolCallId);
    if (reason === undefined) return false;
    if (hostDialogs.sender() === undefined) return false;
    pendingDenyFeedback.delete(toolCallId);
    return writeDialogAnswer(frame.id, frame.sessionId, { kind: "value", value: reason });
  };

  /* one decode for every inbound frame: a ruled ask is answered, every other dialog opens in the store */
  deps.data.subscribeEvents((raw) => {
    const decoded = decodeHostFrame(raw);
    if (!decoded.ok) return;
    if (decoded.frame.type === "extension_ui_request") {
      // every decoded dialog method reaches the store: select and question as before, and confirm,
      // input and editor, which the dialog feature models as their own entries and answers in the
      // shape `HostResponseAnswer` gives each one (confirmed, value, cancelled).
      if (decoded.frame.method === "select" && enforcePermissionRule(decoded.frame)) return;
      if (answerDenyFeedback(decoded.frame)) return;
      hostDialogs.upsert(decoded.frame);
      return;
    }
    if (decoded.frame.type === "question_resolved") hostDialogs.resolveRequest(decoded.frame.requestId);
  });

  /*
   * The host dialog a client form id names. The projection publishes a host question as a client form and
   * records the dialog frame id in its metadata (host-projection.ts projectFormRequest), so the answer
   * reaches the dialog the FormPrompt is showing. A form with no live dialog behind it has no host to
   * settle it, so the members refuse instead of admitting a local answer.
   */
  const questionDialogFor = (sessionID: string, formID: string): QuestionRequestFrame | undefined => {
    const form = deps.data.formsFor(sessionID).find((candidate) => candidate.id === formID);
    const dialogId = form?.metadata?.["dialogId"];
    if (typeof dialogId === "string") {
      const stored = hostDialogs.get(dialogId);
      if (stored !== undefined && stored.method === "question") return stored;
    }
    return hostDialogs
      .list()
      .find(
        (dialog): dialog is QuestionRequestFrame =>
          dialog.method === "question" && (dialog.id === formID || dialog.requestId === formID),
      );
  };

  /* The live permission dialog a projected request id names: the projection brands the host id `per_`. */
  const permissionDialogFor = (requestID: string): SelectRequestFrame | undefined =>
    hostDialogs.list().find(
      (dialog): dialog is SelectRequestFrame =>
        dialog.method === "select" &&
        dialog.title.startsWith(PERMISSION_DIALOG_TITLE) &&
        (dialog.id === requestID || "per_" + dialog.id === requestID),
    );

  /* The client's per-field answer, in the host's per-question shape: a selection when the value is an
     offered option, the value's text otherwise (`{selected: [], text}` is what the host reads as free text). */
  const hostAnswerFor = (field: FormField, value: SessionFormReplyInput["answer"][string]) => {
    if (Array.isArray(value)) return { selected: [...value] };
    const offered = "options" in field ? field.options : undefined;
    if (typeof value === "string" && offered?.some((option) => option.value === value) === true) {
      return { selected: [value] };
    }
    return { selected: [], text: String(value) };
  };

  const built: BridgeTuiData = {
    bridgeData: deps.data,
    sessionRegistry: deps.sessions,
    onHostEvent: (listener: (event: HostEventFrame) => void) =>
      deps.data.subscribeEvents((frame) => {
        const decoded = decodeHostEvent(frame);
        if (!decoded.ok) return;
        // These project the OpenCode schema events; this host writes none of them (its permission and
        // question traffic is the extension-UI dialog sub-protocol). The dialog frames are synthesized
        // onto the client event stream by bridge-core/host-projection.ts instead.
        applyPermissionEvent(deps.data, decoded.event);
        applyFormEvent(deps.data, decoded.event);
        listener(decoded.event);
      }),
    hostDialogs: hostDialogs,
    onHostDialog: (listener: (dialog: HostDialogRequestFrame) => void) =>
      hostDialogs.subscribe((change) => {
        if (change.kind === "open") listener(change.dialog);
      }),
    respondToHostDialog: respondToHostDialog,
    /*
     * Subscriptions are the client's own: every frame the bridge event stream yields reaches the
     * subscriber with its declared type, including `server.connected`. Host dialog frames travel on
     * `onHostDialog` instead; they are not client events and are never reshaped into one.
     */
    on: on,
    listen: listen,
    session: {
      list: () => tracked(() => deps.data.hostSessionList()),
      /* a caller may hold an id the bridge does not publish (a stale tab); upstream returns undefined */
      get: (sessionID: string): SessionInfo | undefined => tracked(() => sessionInfo(sessionID)),
      /* the TUI treats root as a session id: upstream resolveRoot is total and follows parentID */
      root: (sessionID: string) => resolveRoot(sessionID),
      family: (sessionID: string) => {
        const root = resolveRoot(sessionID);
        return tracked(() => deps.data.hostSessionList())
          .flatMap((info) => (info.id === root || resolveRoot(info.id) === root ? [info.id] : []));
      },
      missing: (sessionID: string) => tracked(() => sessionInfo(sessionID)) === undefined,
      forget: (sessionID: string) => {
        deps.data.removeHostSession(sessionID);
      },
      /* prompt/compact belong to the interaction task; they fail loudly until wired */
      /*
       * The client mints the id and mounts a session view before the create settles, so the id is
       * handed to the host as `durableSessionId`: the host adopts it, and every later command and
       * roster row uses the same id the TUI already navigated to.
       *
       * `parentID` is the route to a child session: the opener maps it onto the host's
       * `spawnedBy {parentSessionId, rootSessionId, taskId}` (packages/cli/src/bridge-run.ts), and the
       * optimistic row carries it so `root`/`family` nest the new session before the pull lands. A
       * host that never announced the parent is refused by the opener, not here.
       */
      create: (input: {
        id?: string;
        title?: string;
        agent?: string;
        model?: { readonly providerID: string; readonly id: string; readonly variant?: string };
        location?: { readonly directory: string };
        projectID?: string;
        parentID?: string;
      }) => {
        const create = deps.createSession;
        if (create === undefined) return unsupported("session.create");
        const id = input.id ?? crypto.randomUUID();
        const directory = input.location?.directory ?? deps.defaultLocation.directory;
        /*
         * The caller mounts the session it just created, so the row exists before the host answers.
         * The host adopts the same id, so the pull that follows replaces this row instead of adding a
         * second one; a failed create removes it again, but never a row the host already acknowledged.
         */
        const placeholder = {
          id: id,
          projectID: input.projectID ?? directory,
          ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          ...(input.model === undefined ? {} : { model: input.model }),
          ...(input.title === undefined ? {} : { title: input.title }),
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), updated: Date.now() },
          location: { directory: directory },
        };
        deps.data.upsertHostSession(placeholder);
        const request = create({
          id: id,
          ...(input.title === undefined ? {} : { title: input.title }),
          directory: directory,
          ...(input.parentID === undefined ? {} : { parentID: input.parentID }),
        }).then(
          (info) => {
            deps.data.upsertHostSession(info);
            return info;
          },
          (error: unknown) => {
            const held = deps.data.hostSession(id);
            if (held !== undefined && held.title === placeholder.title) deps.data.removeHostSession(id);
            throw error;
          },
        );
        return { id: id, request: request };
      },
      compact: () => unsupported("session.compact"),
      /*
       * The client contract wants a SessionInboxUser back: a row carrying an id the client chose.
       * This layer mints that id as the submission's `clientMessageId` and the host adopts it, so the
       * returned row is the row the host will answer about. The row is not spliced into the transcript
       * here: the transcript is host-delivered, and inserting a local copy would show a message the
       * host has not acknowledged yet. Without an injected sender nothing can be sent, so the surface
       * refuses rather than reporting a submission that never left this process.
       */
      prompt: async (input: BridgePromptInput): Promise<SessionInboxUser> => {
        const send = deps.sendPrompt;
        if (send === undefined) return unsupported("session.prompt");
        /* The host prompt command carries no agent field, so the selection is translated into one
           documented instruction and recorded on the session; see bridge-core/src/prompt-input.ts. */
        const translation = translatePromptAgentSelection(input);
        if (input.gate !== undefined) await input.gate;
        if (input.prepare !== undefined) await input.prepare();
        const clientMessageId = crypto.randomUUID();
        const delivery = input.delivery ?? "queue";
        /* The record exists before the send so the launcher can report what the host answered to the
           session-context patch; a prompt the host never took leaves no record behind. */
        if (translation.selection !== undefined) {
          deps.data.setPromptAgentRecord(input.sessionID, { ...translation.selection, recordedAt: Date.now() });
        }
        try {
          await send({
            sessionID: input.sessionID,
            text: translation.text,
            clientMessageId: clientMessageId,
            delivery: delivery,
            ...(translation.selection === undefined
              ? {}
              : { agentRequest: { requested: translation.selection.requested } }),
          });
        } catch (error) {
          if (translation.selection !== undefined) deps.data.clearPromptAgentRecord(input.sessionID);
          throw error;
        }
        /* The row is the acknowledgement handle, not a message: the transcript comes from the host's
           pull, so no attachment is repeated on a row that never reaches it. The text is what the user
           typed; the instruction the host received is in the transcript the host delivers. */
        return {
          id: clientMessageId,
          sessionID: input.sessionID,
          time: { created: Date.now() },
          type: "user",
          payload: { text: input.text },
          delivery: delivery,
        };
      },
      /* the bridge opens sessions synchronously, so nothing is ever mid-create */
      creating: () => false,
      remember: (info: SessionInfo) => {
        deps.data.upsertHostSession(info);
      },
      setStatus: () => {},
      evict: (sessionID: string) => {
        deps.data.setHostMessages(sessionID, []);
      },
      active: () =>
        deps.sessions
          .list()
          .filter((record) => record.state === "active")
          .map((record) => record.persistentId),
      input: {
        /* upstream derives the in-flight input ids from the pending store; the host report is that store */
        list: (sessionID: string) => pendingInputs(sessionID).map((item) => item.id),
        has: (sessionID: string, inboxID: string) => pendingInputs(sessionID).some((item) => item.id === inboxID),
      },
      cost: (sessionID: string) => requireSession(sessionID).cost,
      status: (sessionID: string) => {
        const record = tracked(() =>
          deps.sessions.list().find((candidate) => candidate.persistentId === sessionID),
        );
        return record !== undefined && record.state === "active" ? "running" : "idle";
      },
      pending: {
        /* projected from the host's pending-input report; pendingInputs documents the fields it cannot fill */
        list: (sessionID: string) => pendingInputs(sessionID),
        status: () => undefined,
        sync: async () => {},
        invalidate: () => {},
      },
      sync: async () => {},
      invalidate: () => {},
      title: {
        /* the bridge never starts title generation, so pending is false rather than unknown */
        pending: () => false,
        generate: async () => unsupported("session.title.generate"),
      },
      /* what the bridge did with a prompt's `agent` selection; absent when the prompt named none */
      agentRequest: (sessionID: string) => tracked(() => deps.data.promptAgentRecordFor(sessionID)),
      message: {
        list: (sessionID: string) => messages(sessionID),
        get: (sessionID: string, messageID: string) =>
          tracked(() => messages(sessionID).find((message) => message.id === messageID)),
        sync: async () => {},
        invalidate: () => {},
        /* the bridge receives whole message lists, so there is never another page to load */
        more: () => false,
        loading: () => false,
        loadMore: async () => {},
        /*
         * The host's `edit_user_message`: the edited copy becomes the new leaf and the abandoned branch
         * stays in the session file. No file is restored, because the host keeps no snapshots.
         */
        edit: async (input: MessageChannelEditInput): Promise<MessageChannelEditOutcome> => {
          const edit = deps.editMessage;
          if (edit === undefined) return unsupported("session.message.edit");
          return await edit(input);
        },
        /*
         * The host's `edit_assistant_message`: the reply is replaced with an edited copy and the
         * original answer stays in the session file on an abandoned branch. No file is restored,
         * because the host keeps no snapshots.
         */
        editAssistantMessage: async (input: MessageChannelEditInput): Promise<MessageChannelEditOutcome> => {
          const edit = deps.editAssistantMessage;
          if (edit === undefined) return unsupported("session.message.editAssistantMessage");
          return await edit(input);
        },
        /* `continue_from_leaf`: a turn from the current leaf, without a new user prompt. */
        continueFromLeaf: async (input: MessageChannelContinueInput): Promise<void> => {
          const run = deps.continueFromLeaf;
          if (run === undefined) return unsupported("session.message.continueFromLeaf");
          return await run(input);
        },
      },
      permission: {
        /* projected from the permission.asked and permission.replied host events */
        list: (sessionID: string) => deps.data.permissionsFor(sessionID),
        sessions: () => unsupported("session.permission.sessions"),
        /*
         * The PermissionPrompt and the autoaccept path both answer through here. The projected request
         * id carries the client's `per_` brand over the host's dialog id, so the live dialog is found
         * by either; a request with no live dialog has no host to settle it and refuses.
         */
        reply: async (input: {
          readonly sessionID: string;
          readonly requestID: string;
          readonly decision: "once" | "always" | "reject";
          readonly message?: string;
        }): Promise<void> => {
          const dialog = permissionDialogFor(input.requestID);
          if (dialog === undefined) return unsupported("session.permission.reply:" + input.requestID);
          const reason = input.decision === "reject" ? input.message : undefined;
          const feedback = reason === undefined || reason.length === 0 ? undefined : "Deny with feedback";
          const value =
            feedback !== undefined && dialog.options.includes(feedback)
              ? feedback
              : input.decision === "once"
                ? "Allow once"
                : input.decision === "always"
                  ? "Allow always"
                  : "Deny";
          const wantsReject = input.decision === "reject";
          const label = dialog.options.includes(value)
            ? value
            : dialog.options.find((option) => (wantsReject ? option.startsWith("Deny") : option.startsWith("Allow")));
          if (label === undefined) return unsupported("session.permission.reply:" + input.requestID);
          if (label === "Deny with feedback" && dialog.toolCallId !== undefined && reason !== undefined) {
            pendingDenyFeedback.set(dialog.toolCallId, reason);
          }
          if (!writeDialogAnswer(dialog.id, dialog.sessionId, { kind: "value", value: label })) {
            return unsupported("hostDialog.respond");
          }
        },
        /* The bridge's own rule set for the session, in the client's PermissionRuleset shape. */
        rules: (sessionID: string): PermissionRuleset =>
          tracked(() => permissionRules?.rulesFor(sessionID) ?? deps.data.sessionPermissionRulesFor(sessionID)),
        sync: async () => unsupported("session.permission.sync"),
        invalidate: () => unsupported("session.permission.invalidate"),
      },
      form: {
        /* projected from the form.created, form.replied and form.cancelled host events */        list: (sessionID: string) => deps.data.formsFor(sessionID),
        sessions: () => unsupported("session.form.sessions"),
        sync: async () => unsupported("session.form.sync"),
        invalidate: () => unsupported("session.form.invalidate"),
        /*
         * The FormPrompt answers through these members. A projected form is a host question dialog with an
         * id and a settlement event; the dialog is what the host is actually waiting on, so both members
         * write the same `extension_ui_response` the dialog feature writes, and the published answer
         * becomes the `form.replied`/`form.cancelled` event the projection already handles.
         */
        reply: async (input: SessionFormReplyInput) => {
          const dialog = questionDialogFor(input.sessionID, input.formID);
          const form = deps.data.formsFor(input.sessionID).find((candidate) => candidate.id === input.formID);
          if (dialog === undefined || form === undefined) return unsupported("session.form.reply:" + input.formID);
          const answers: Record<string, ReturnType<typeof hostAnswerFor>> = {};
          for (let index = 0; index < form.fields.length; index += 1) {
            const field = form.fields[index];
            const question = dialog.questions[index];
            /* a field the host question does not have would answer the wrong question, so it refuses */
            if (field === undefined || field.type === "external") continue;
            if (question === undefined) return unsupported("session.form.reply:" + input.formID);
            const value = input.answer[field.key];
            if (value === undefined) continue;
            answers[question.id] = hostAnswerFor(field, value);
          }
          respondToHostDialog(dialog.id, { kind: "answers", answers: answers });
        },
        cancel: async (input: SessionFormCancelInput) => {
          const dialog = questionDialogFor(input.sessionID, input.formID);
          if (dialog === undefined) return unsupported("session.form.cancel:" + input.formID);
          respondToHostDialog(dialog.id, { kind: "cancelled" });
        },
      },
    },
    project: {
      /*
       * The host publishes no project record; the only stable grouping key it gives is the working
       * directory, which is what the launcher recorded as the session's project id. The session route's
       * tab strip reads this during layout, so a throw here took the whole route down: the row is that
       * directory and nothing invented beyond it.
       */
      list: () => tracked(() => projectRows()),
      get: (projectID: string) => tracked(() => projectIndex()[projectID]),
      sync: async () => {},
      invalidate: () => {},
      permission: {
        list: () => unsupported("project.permission.list"),
        sync: async () => unsupported("project.permission.sync"),
        invalidate: () => unsupported("project.permission.invalidate"),
      },
    },
    shell: {
      /*
       * No host shell list exists to project, and the render path reads these during layout, so the
       * answer is empty rather than a throw; P-746/P-747 in spec/capabilities.json record the gap.
       */
      list: () => [],
      listBySession: () => [],
      get: () => undefined,
      sync: async () => {},
      invalidate: () => {},
    },
    location: {
      info: () => deps.data.location().info,
      default: () => deps.defaultLocation,
      syncInfo: async () => unsupported("location.syncInfo"),
      usage: {
        limits: () => unsupported("location.usage.limits"),
        sync: async () => unsupported("location.usage.sync"),
        invalidate: () => unsupported("location.usage.invalidate"),
      },
      config: collection(() => deps.data.location().config),
      websearch: {
        list: () => unsupported("location.websearch.list"),
        refresh: async () => unsupported("location.websearch.refresh"),
      },
      sync: async () => unsupported("location.sync"),
      invalidate: () => unsupported("location.invalidate"),
      vcs: {
        info: () => deps.data.location().vcs,
        sync: async () => unsupported("location.vcs.sync"),
        invalidate: () => unsupported("location.vcs.invalidate"),
      },
      agent: collection(() => deps.data.location().agent),
      command: collection(() => deps.data.location().command),
      integration: collection(() => deps.data.location().integration),
      mcp: {
        server: collection(() => deps.data.location().mcpServer),
        resource: collection(() => deps.data.location().mcpResource),
      },
      model: collection(() => deps.data.location().model),
      provider: collection(() => deps.data.location().provider),
      reference: collection(() => deps.data.location().reference),
      skill: collection(() => deps.data.location().skill),
    },
  };
  bridgeStores.set(built, deps.data);
  bridgeAdapters.set(built, built);
  return built;

  function projectIndex() {
    const index: Record<string, Project> = {};
    for (const project of projectRows()) index[project.id] = project;
    return index;
  }

  function projectRows() {
    const rows = new Map<string, Project>();
    for (const info of deps.data.hostSessionList()) {
      const held = rows.get(info.projectID);
      const created = held === undefined ? info.time.created : Math.min(held.time.created, info.time.created);
      const updated = held === undefined ? info.time.updated : Math.max(held.time.updated, info.time.updated);
      rows.set(info.projectID, {
        id: info.projectID,
        canonical: info.location.directory,
        time: { created: created, updated: updated, active: updated },
        sandboxes: [],
      });
    }
    return [...rows.values()];
  }
}
/**
 * Host catalogues arrive by push, so an unknown entry reads as undefined and a refresh is a no-op
 * rather than a failure the render path has to survive.
 */
function collection<Value>(read: () => Value[] | undefined) {
  return {
    list: () => read(),
    sync: async () => {},
    invalidate: () => {},
  };
}
