import { createSignal } from "solid-js";
import type { HostDialogRequestFrame } from "../../../../../bridge-core/src/dialogs-host.ts";
import type { BridgeTuiData } from "../../../context/bridge-data.ts";
import {
  applyDialogClose,
  applyDialogDelivery,
  buildQuestionAnswer,
  dialogEntryOf,
  draftComment,
  draftQuestionText,
  emptyQuestionDraft,
  formatDuration,
  liveDialogs,
  recordDialogFailure,
  remainingMsFor,
  settleDialogAnswer,
  settleDialogCancel,
  summarizeConfirmAnswer,
  summarizeQuestionAnswer,
  summarizeTextAnswer,
  toggleDraftOption,
} from "./state.ts";
import type { DialogEntry, QuestionDraft } from "./state.ts";

export type DialogsStoreDeps = {
  readonly data: BridgeTuiData;
  readonly now?: () => number;
};

export type DialogAnswerOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "not-live"; readonly reason: string }
  | { readonly kind: "invalid"; readonly reason: string };

export type DialogsStore = {
  readonly entries: () => readonly DialogEntry[];
  readonly live: () => readonly DialogEntry[];
  readonly entry: (identity: string) => DialogEntry | undefined;
  readonly draft: (identity: string) => QuestionDraft;
  readonly textFor: (entry: DialogEntry) => string;
  readonly clock: () => number;
  readonly remaining: (entry: DialogEntry) => number | null;
  readonly remainingLabel: (entry: DialogEntry) => string;
  readonly refreshClock: () => void;
  readonly answerSelect: (identity: string, label: string) => DialogAnswerOutcome;
  readonly answerConfirm: (identity: string, confirmed: boolean) => DialogAnswerOutcome;
  readonly answerText: (identity: string) => DialogAnswerOutcome;
  readonly toggleOption: (identity: string, questionId: string, label: string) => void;
  readonly setQuestionText: (identity: string, questionId: string, text: string) => void;
  readonly setComment: (identity: string, comment: string) => void;
  readonly setText: (identity: string, text: string) => void;
  readonly submitQuestion: (identity: string) => DialogAnswerOutcome;
  readonly cancel: (identity: string) => DialogAnswerOutcome;
  readonly dispose: () => void;
};

type AnswerGate =
  | { readonly kind: "answerable"; readonly entry: DialogEntry }
  | { readonly kind: "refused"; readonly outcome: DialogAnswerOutcome };

/**
 * Holds the open host dialogs and writes answers back through `respondToHostDialog`, which is the
 * only send path the bridge exposes. A store-side precheck against `hostDialogs` keeps a prompt the
 * host already dropped from being answered late, and `gate` is the single place that decides an
 * entry is still answerable, so every method settles at most once.
 */
export function createDialogsStore(deps: DialogsStoreDeps): DialogsStore {
  const now = deps.now ?? (() => Date.now());
  const seeded = deps.data.hostDialogs
    .list()
    .reduce<readonly DialogEntry[]>(
      (entries, frame: HostDialogRequestFrame) => applyDialogDelivery(entries, frame, now()),
      [],
    );
  const [entries, setEntries] = createSignal<readonly DialogEntry[]>(seeded);
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, QuestionDraft>>>({});
  const [texts, setTexts] = createSignal<Readonly<Record<string, string>>>({});
  const [tick, setTick] = createSignal(0);

  const stopOpen = deps.data.onHostDialog((frame) => {
    setEntries((current) => applyDialogDelivery(current, frame, now()));
  });
  const stopClose = deps.data.hostDialogs.subscribe((change) => {
    if (change.kind !== "closed") return;
    setEntries((current) => applyDialogClose(current, change.dialogId));
  });

  const entry = (identity: string) => dialogEntryOf(entries(), identity);
  const draft = (identity: string) => drafts()[identity] ?? emptyQuestionDraft;
  /* an editor arrives with the host's prefill, so the field starts from it until the first keystroke */
  const textFor = (held: DialogEntry) => {
    const typed = texts()[held.identity];
    if (typed !== undefined) return typed;
    return held.method === "editor" ? (held.frame.prefill ?? "") : "";
  };
  const clock = () => {
    tick();
    return now();
  };

  const gate = (identity: string): AnswerGate => {
    const held = entry(identity);
    if (held === undefined) {
      return { kind: "refused", outcome: { kind: "not-live", reason: "the host is no longer waiting on this dialog" } };
    }
    if (held.status !== "open") {
      return {
        kind: "refused",
        outcome: { kind: "not-live", reason: "this dialog was already " + held.status + " and is not sent again" },
      };
    }
    if (deps.data.hostDialogs.get(held.frame.id) === undefined) {
      setEntries((current) => applyDialogClose(current, held.frame.id));
      return { kind: "refused", outcome: { kind: "not-live", reason: "the host already closed this dialog" } };
    }
    return { kind: "answerable", entry: held };
  };

  const send = (held: DialogEntry, answer: Parameters<BridgeTuiData["respondToHostDialog"]>[1]) => {
    try {
      deps.data.respondToHostDialog(held.frame.id, answer);
    } catch (error) {
      setEntries((current) =>
        recordDialogFailure(current, held.identity, error instanceof Error ? error.message : String(error)),
      );
      throw error;
    }
    /* respondToHostDialog resolves the bridge store first, so the close it emits already ran above */
    setDrafts((current) => {
      const next = { ...current };
      delete next[held.identity];
      return next;
    });
    setTexts((current) => {
      const next = { ...current };
      delete next[held.identity];
      return next;
    });
  };

  return {
    entries: entries,
    live: () => liveDialogs(entries()),
    entry: entry,
    draft: draft,
    textFor: textFor,
    clock: clock,
    remaining: (held) => remainingMsFor(held.frame, held.deliveredAtMs, clock()),
    remainingLabel: (held) => {
      const left = remainingMsFor(held.frame, held.deliveredAtMs, clock());
      if (left === null) return "";
      if (left === 0) return "the host deadline has passed; waiting for the host to settle this question";
      return "≈ " + formatDuration(left) + " left before the host closes this question";
    },
    refreshClock: () => setTick((value) => value + 1),
    answerSelect: (identity, label) => {
      const open = gate(identity);
      if (open.kind === "refused") return open.outcome;
      const held = open.entry;
      if (held.method !== "select") return { kind: "invalid", reason: "this is a " + held.method + " prompt, not a select" };
      if (!held.frame.options.includes(label)) {
        return { kind: "invalid", reason: label + " is not an option the host offered" };
      }
      send(held, { kind: "value", value: label });
      setEntries((current) => settleDialogAnswer(current, identity, label));
      return { kind: "sent" };
    },
    answerConfirm: (identity, confirmed) => {
      const open = gate(identity);
      if (open.kind === "refused") return open.outcome;
      const held = open.entry;
      if (held.method !== "confirm") return { kind: "invalid", reason: "this is a " + held.method + " prompt, not a confirm" };
      send(held, { kind: "confirmed", confirmed: confirmed });
      setEntries((current) => settleDialogAnswer(current, identity, summarizeConfirmAnswer(confirmed)));
      return { kind: "sent" };
    },
    answerText: (identity) => {
      const open = gate(identity);
      if (open.kind === "refused") return open.outcome;
      const held = open.entry;
      if (held.method !== "input" && held.method !== "editor") {
        return { kind: "invalid", reason: "this is a " + held.method + " prompt, not a text prompt" };
      }
      const value = textFor(held);
      if (value.length === 0) {
        return { kind: "invalid", reason: "an empty value is not sent; use Cancel to decline" };
      }
      send(held, { kind: "value", value: value });
      setEntries((current) => settleDialogAnswer(current, identity, summarizeTextAnswer(held.frame, value)));
      return { kind: "sent" };
    },
    toggleOption: (identity, questionId, label) => {
      const held = entry(identity);
      if (held === undefined || held.method !== "question") return;
      const question = held.frame.questions.find((candidate) => candidate.id === questionId);
      if (question === undefined) return;
      const current = draft(identity);
      setDrafts((all) => ({ ...all, [identity]: toggleDraftOption(current, question, label) }));
    },
    setQuestionText: (identity, questionId, text) => {
      const current = draft(identity);
      setDrafts((all) => ({ ...all, [identity]: draftQuestionText(current, questionId, text) }));
    },
    setComment: (identity, comment) => {
      const current = draft(identity);
      setDrafts((all) => ({ ...all, [identity]: draftComment(current, comment) }));
    },
    setText: (identity, text) => {
      const held = entry(identity);
      if (held === undefined || held.status !== "open") return;
      setTexts((all) => ({ ...all, [identity]: text }));
    },
    submitQuestion: (identity) => {
      const open = gate(identity);
      if (open.kind === "refused") return open.outcome;
      const held = open.entry;
      if (held.method !== "question") return { kind: "invalid", reason: "this is a " + held.method + " prompt, not a question" };
      const built = buildQuestionAnswer(held.frame, draft(identity));
      if (!built.ok) return { kind: "invalid", reason: built.reason };
      send(held, { kind: "answers", answers: built.answers, comment: built.comment });
      setEntries((current) => settleDialogAnswer(current, identity, summarizeQuestionAnswer(built)));
      return { kind: "sent" };
    },
    cancel: (identity) => {
      const open = gate(identity);
      if (open.kind === "refused") return open.outcome;
      send(open.entry, { kind: "cancelled" });
      setEntries((current) => settleDialogCancel(current, identity, "client"));
      return { kind: "sent" };
    },
    dispose: () => {
      stopOpen();
      stopClose();
    },
  };
}
