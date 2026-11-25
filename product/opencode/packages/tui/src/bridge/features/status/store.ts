import { createSignal } from "solid-js";
import type { BridgeData } from "../../../../../bridge-core/src/data.ts";
import {
  MEMORY_FACTS_APPLY_METHOD,
  decodeMemoryAnswer,
  decodeStatusFrame,
  gateMemoryWrite,
  memoryFields,
  planMemoryWrite,
  teamSurface,
  upsertMember,
} from "./state.ts";
import type {
  MemoryFactsRequest,
  MemoryFactsResponse,
  MemoryWriteRefusalCode,
  MemorySnapshot,
  MemorySurface,
  MemoryWriteOutcome,
  MemoryWritePlan,
  MemoryWritePlanOutcome,
  TeamMemberRow,
  TeamSurface,
  TurnLiveness,
  StatusEntry,
  StatusFrame,
  NotificationsView,
  NotificationEntry,
  ReportedField,
  WidgetAction,
  WidgetEntry,
  WidgetSurface,
} from "./state.ts";

/** A refusal or a rejected frame, kept so the column can show it instead of dropping it. */
export type StatusNotice = {
  readonly id: number;
  readonly code: string;
  readonly message: string;
};

export type ApplyOutcome =
  | { readonly kind: "applied"; readonly subject: "memory" | "team" | "status" | "widget" | "notification" | "turn" }
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "other-session"; readonly sessionId: string };

type MemoryHeld =
  | { readonly kind: "snapshot"; readonly snapshot: MemorySnapshot }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly schemaVersion: string; readonly reason: string };

export type StatusStoreDeps = {
  /** The one session these surfaces read. A frame routed elsewhere is never applied here. */
  readonly sessionID: string | null;
  /** The facts channel. Absent means a persistent write cannot be sent at all. */
  readonly applyFacts?: (request: MemoryFactsRequest) => Promise<MemoryFactsResponse>;
};

export type StatusStore = {
  readonly sessionID: () => string | null;
  readonly memory: () => MemorySurface;
  readonly team: () => TeamSurface;
  readonly turnLiveness: () => TurnLiveness | null;
  readonly statuses: () => readonly StatusEntry[];
  readonly widgets: () => WidgetSurface;
  readonly notifications: () => NotificationsView;
  readonly notices: () => readonly StatusNotice[];
  readonly otherSessionFrames: () => number;
  readonly pendingWrite: () => MemoryWritePlan | null;
  readonly writeOutcome: () => MemoryWriteOutcome | null;
  readonly applyFrame: (raw: unknown) => ApplyOutcome;
  readonly applyMemoryAnswer: (raw: unknown) => ApplyOutcome;
  readonly applyStatus: (key: string, text: string | null) => void;
  readonly applyWidget: (input: {
    readonly key: string;
    readonly lines: readonly string[];
    readonly placement: string | null;
    readonly actions: readonly WidgetAction[];
    readonly cleared: boolean;
  }) => void;
  readonly planWrite: (input: MemoryFactsRequest) => MemoryWritePlanOutcome;
  readonly authorizeWrite: (planId: string, shownContent: string) => Promise<MemoryWriteOutcome>;
  readonly clearNotices: () => void;
};

/**
 * Holds each subject in its own signal, so a team notification never rewrites the memory surface.
 * Reads apply only to `deps.sessionID`; the one write is planned, previewed and authorized, and a
 * refusal is recorded as a notice as well as returned.
 */
export function createStatusStore(deps: StatusStoreDeps): StatusStore {
  const [memoryHeld, setMemoryHeld] = createSignal<MemoryHeld | null>(null);
  const [members, setMembers] = createSignal<readonly TeamMemberRow[]>([]);
  const [teamDelivered, setTeamDelivered] = createSignal(false);
  const [turn, setTurn] = createSignal<TurnLiveness | null>(null);
  const [statuses, setStatuses] = createSignal<readonly StatusEntry[]>([]);
  const [widgets, setWidgets] = createSignal<readonly WidgetEntry[]>([]);
  const [notifications, setNotifications] = createSignal<readonly NotificationEntry[]>([]);
  const [notices, setNotices] = createSignal<readonly StatusNotice[]>([]);
  const [otherSession, setOtherSession] = createSignal(0);
  const [plan, setPlan] = createSignal<MemoryWritePlan | null>(null);
  const [outcome, setOutcome] = createSignal<MemoryWriteOutcome | null>(null);
  const [writing, setWriting] = createSignal(false);
  let nextNotification = 1;
  let nextNotice = 1;
  let nextPlan = 1;

  const note = (code: string, message: string): void => {
    const id = nextNotice;
    nextNotice += 1;
    setNotices((current) => [...current, { id: id, code: code, message: message }]);
  };

  const refuse = (code: MemoryWriteRefusalCode, message: string): MemoryWriteOutcome => {
    const refused: MemoryWriteOutcome = { kind: "refused", code: code, message: message };
    note(code, message);
    return refused;
  };

  const memory = (): MemorySurface => {
    const held = memoryHeld();
    if (held === null) {
      return { kind: "not-reported", reason: "The host has not answered the memory snapshot for this session." };
    }
    if (held.kind === "unavailable") return { kind: "unavailable", reason: held.reason };
    if (held.kind === "unsupported") {
      return { kind: "unsupported", schemaVersion: held.schemaVersion, reason: held.reason };
    }
    const fields: readonly ReportedField[] = memoryFields(held.snapshot);
    return {
      kind: "reported",
      snapshot: held.snapshot,
      fields: fields,
      note:
        held.snapshot.nonJournalUnknown
          ? "The host delivered a journal-only snapshot; non-journal counts are unknown, not zero."
          : "Every field below is what the host delivered; a value it omitted reads as not reported.",
    };
  };

  const applyMemoryAnswer = (raw: unknown): ApplyOutcome => {
    const decoded = decodeMemoryAnswer(raw);
    if (decoded.kind === "unavailable") {
      setMemoryHeld({ kind: "unavailable", reason: decoded.reason });
      return { kind: "applied", subject: "memory" };
    }
    if (decoded.kind === "rejected") {
      note("FRAME_REJECTED", "The memory answer was rejected: " + decoded.reason);
      return { kind: "rejected", reason: decoded.reason };
    }
    const sessionID = deps.sessionID;
    const journalSession = decoded.snapshot.journal.sessionId;
    if (journalSession !== undefined && sessionID !== null && journalSession !== sessionID) {
      const reason =
        "the memory snapshot belongs to session " + journalSession + ", not to this thread (" + sessionID + ")";
      note("SESSION_MISMATCH", "The memory snapshot was not applied: " + reason + ".");
      return { kind: "refused", reason: reason };
    }
    setMemoryHeld({ kind: "snapshot", snapshot: decoded.snapshot });
    return { kind: "applied", subject: "memory" };
  };

  const applyStatus = (key: string, text: string | null): void => {
    setStatuses((current) => {
      const index = current.findIndex((entry) => entry.key === key);
      const next: StatusEntry = { key: key, text: text };
      if (index === -1) return [...current, next];
      return current.map((entry, at) => (at === index ? next : entry));
    });
  };

  const applyWidget = (input: {
    readonly key: string;
    readonly lines: readonly string[];
    readonly placement: string | null;
    readonly actions: readonly WidgetAction[];
    readonly cleared: boolean;
  }): void => {
    const entry: WidgetEntry = {
      key: input.key,
      lines: input.cleared ? [] : input.lines,
      placement: input.placement,
      actions: input.cleared ? [] : input.actions,
      cleared: input.cleared,
    };
    setWidgets((current) => {
      const index = current.findIndex((candidate) => candidate.key === entry.key);
      if (index === -1) return [...current, entry];
      return current.map((candidate, at) => (at === index ? entry : candidate));
    });
  };

  const addNotification = (message: string, level: string, display: boolean, source: "notify" | "custom-message"): void => {
    const id = nextNotification;
    nextNotification += 1;
    setNotifications((current) => [...current, { id: id, message: message, level: level, display: display, source: source }]);
  };

  const applyFrame = (raw: unknown): ApplyOutcome => {
    const frame: StatusFrame = decodeStatusFrame(raw);
    if (frame.kind === "ignored") return frame;
    if (frame.kind === "rejected") {
      note("FRAME_REJECTED", "The host frame was rejected: " + frame.reason);
      return frame;
    }
    if (frame.sessionId !== null && deps.sessionID !== null && frame.sessionId !== deps.sessionID) {
      setOtherSession((current) => current + 1);
      return { kind: "other-session", sessionId: frame.sessionId };
    }
    if (frame.kind === "memory") return applyMemoryAnswer(frame.data);
    if (frame.kind === "team-liveness") {
      setMembers((current) => upsertMember(current, frame.details));
      setTeamDelivered(true);
      if (!frame.display) {
        addNotification(
          "team member liveness notice for " + frame.details.memberName,
          "info",
          false,
          "custom-message",
        );
      }
      return { kind: "applied", subject: "team" };
    }
    if (frame.kind === "turn-liveness") {
      setTurn({ verdict: frame.verdict, reason: frame.reason });
      return { kind: "applied", subject: "turn" };
    }
    if (frame.kind === "status") {
      applyStatus(frame.key, frame.text);
      return { kind: "applied", subject: "status" };
    }
    if (frame.kind === "widget") {
      applyWidget({
        key: frame.key,
        lines: frame.lines,
        placement: frame.placement,
        actions: frame.actions,
        cleared: frame.cleared,
      });
      return { kind: "applied", subject: "widget" };
    }
    addNotification(frame.message, frame.level, true, "notify");
    return { kind: "applied", subject: "notification" };
  };

  return {
    sessionID: () => deps.sessionID,
    memory: memory,
    team: () => teamSurface(members(), teamDelivered() || members().length > 0),
    turnLiveness: turn,
    statuses: statuses,
    widgets: (): WidgetSurface => {
      const entries = widgets();
      if (entries.length === 0) {
        return { kind: "not-reported", reason: "The host has sent no string-array widget for this session." };
      }
      return {
        kind: "reported",
        entries: entries,
        note: "Rows below are the widget strings the host sent, in its order; this surface adds none.",
      };
    },
    notifications: (): NotificationsView => {
      const all = notifications();
      return {
        visible: all.filter((entry) => entry.display),
        hidden: all.filter((entry) => !entry.display),
        note:
          all.length === 0
            ? "The host has sent no notification for this session."
            : "A notification the host marks display=false is counted here and never drawn as a notification.",
      };
    },
    notices: notices,
    otherSessionFrames: otherSession,
    pendingWrite: plan,
    writeOutcome: outcome,
    applyFrame: applyFrame,
    applyMemoryAnswer: applyMemoryAnswer,
    applyStatus: applyStatus,
    applyWidget: applyWidget,
    planWrite: (input) => {
      const planId = "memory-write-" + String(nextPlan);
      nextPlan += 1;
      const planned = planMemoryWrite(planId, input);
      if (planned.kind === "refused") {
        note(planned.code, planned.message);
        setOutcome(planned);
        return planned;
      }
      setPlan(planned.plan);
      setOutcome(null);
      return planned;
    },
    authorizeWrite: async (planId, shownContent) => {
      const gate = gateMemoryWrite({
        plan: plan(),
        planId: planId,
        shownContent: shownContent,
        inFlight: writing(),
        connected: deps.applyFacts !== undefined,
      });
      if (gate !== null) return refuse(gate.code, gate.message);
      const held = plan();
      if (held === null) return refuse("UNKNOWN_PLAN", "No pending memory write matches " + planId + ", so nothing was sent.");
      setWriting(true);
      try {
        const response = await deps.applyFacts?.(held.request);
        if (response === undefined) return refuse("NOT_CONNECTED", "No memory facts channel is attached, so nothing was sent.");
        if ("kind" in response) {
          return refuse("HOST_REFUSED", MEMORY_FACTS_APPLY_METHOD + " refused the batch: " + response.reason);
        }
        if (response.outcome === "committed") {
          const committed: MemoryWriteOutcome = {
            kind: "committed",
            sha: response.sha,
            affectedPaths: response.affectedPaths,
            batchId: response.batchId,
          };
          setPlan(null);
          setOutcome(committed);
          return committed;
        }
        if (response.outcome === "no_facts") {
          const empty: MemoryWriteOutcome = { kind: "no-facts" };
          setPlan(null);
          setOutcome(empty);
          return empty;
        }
        return refuse(
          "HOST_REFUSED",
          MEMORY_FACTS_APPLY_METHOD + " did not commit (parent_dirty): " + (response.detail ?? "no detail reported"),
        );
      } catch (error) {
        const message = "The memory write failed before a receipt arrived: " + describe(error);
        note("WRITE_FAILED", message);
        const failed: MemoryWriteOutcome = { kind: "refused", code: "WRITE_FAILED", message: message };
        setOutcome(failed);
        return failed;
      } finally {
        setWriting(false);
      }
    },
    clearNotices: () => setNotices([]),
  };
}

/**
 * Feeds every raw host frame the bridge keeps into the status store; the decoder decides what it is.
 *
 * When the launcher has installed an extension request sender, one `omo.memory.status` pull is issued
 * so the memory section starts from the host's own snapshot instead of waiting for a push. A pull that
 * fails is reported to `onPullError`; it never fabricates a snapshot.
 */
export function connectBridgeStatus(
  store: StatusStore,
  data: BridgeData,
  options: { readonly onPullError?: (message: string) => void } = {},
): () => void {
  const unsubscribe = data.subscribeEvents((frame) => {
    store.applyFrame(frame);
  });
  /* Only ask when the launcher really installed a sender; otherwise the section stays "not reported". */
  if (!data.hasExtensionRequester()) return unsubscribe;
  const id = "memory-status-" + Date.now().toString(36);
  void data
    .requestExtension(id, { id: id, type: "extension_request", name: "omo.memory.status" })
    .then((answer) => {
      store.applyMemoryAnswer(answer);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      options.onPullError?.(message);
    });
  return unsubscribe;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
