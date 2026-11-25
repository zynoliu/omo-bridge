import type { HostDialogRequestFrame } from "../../../../../bridge-core/src/dialogs-host.ts";
import type {
  ConfirmRequestFrame,
  EditorRequestFrame,
  HostQuestionAnswers,
  InputRequestFrame,
  QuestionRequestFrame,
  SelectRequestFrame,
} from "../../../../../bridge-core/src/host-frames.ts";

/**
 * The dialogs the host is waiting on, derived from the `extension_ui_request` frames it wrote.
 *
 * Identity is the host's own handle, never a locally minted one: a `select`, `confirm`, `input` or
 * `editor` dialog is one prompt per frame `id`, and a `question` dialog is one prompt per
 * `requestId` across the frame ids a reconnect can reissue for it. The answer is always correlated
 * by the newest frame `id`, because that is what `extension_ui_response.uiRequestId` names
 * (`spec/host-frame-vocabulary.md`, "Correlation: which id a client must echo").
 *
 * All five `extension_ui_request` methods the decoder in `packages/bridge-core/src/host-frames.ts`
 * accepts are modelled here, each as its own entry so no field has to be invented for a kind that
 * does not carry it: a `select` has an option list, a `question` has questions, a `confirm` has a
 * message and a yes/no outcome, an `input` has a placeholder and an optional secret marker, and an
 * `editor` has a prefilled text. Answer shapes follow `HostResponseAnswer`: `confirmed` for a
 * confirm, `value` for select/input/editor, `answers` for a question, `cancelled` for any of them.
 */

export type DialogStatus = "open" | "answered" | "cancelled";

export type DialogCancelledBy = "client" | "host";

/** `failure` is only ever set on an `open` entry: a write that did not happen leaves the prompt answerable. */
type DialogEntryBase = {
  readonly identity: string;
  readonly deliveredAtMs: number;
  readonly redeliveries: number;
  readonly status: DialogStatus;
  readonly answer: string | null;
  readonly cancelledBy: DialogCancelledBy | null;
  readonly failure: string | null;
};

export type SelectDialogEntry = DialogEntryBase & { readonly method: "select"; readonly frame: SelectRequestFrame };

export type QuestionDialogEntry = DialogEntryBase & { readonly method: "question"; readonly frame: QuestionRequestFrame };

export type ConfirmDialogEntry = DialogEntryBase & { readonly method: "confirm"; readonly frame: ConfirmRequestFrame };

export type InputDialogEntry = DialogEntryBase & { readonly method: "input"; readonly frame: InputRequestFrame };

export type EditorDialogEntry = DialogEntryBase & { readonly method: "editor"; readonly frame: EditorRequestFrame };

export type DialogEntry =
  | SelectDialogEntry
  | QuestionDialogEntry
  | ConfirmDialogEntry
  | InputDialogEntry
  | EditorDialogEntry;

/** The two methods answered with a plain string in `value`. */
export type TextDialogEntry = InputDialogEntry | EditorDialogEntry;

export function selectEntry(entry: DialogEntry): SelectDialogEntry | undefined {
  return entry.method === "select" ? entry : undefined;
}

export function questionEntry(entry: DialogEntry): QuestionDialogEntry | undefined {
  return entry.method === "question" ? entry : undefined;
}

export function confirmEntry(entry: DialogEntry): ConfirmDialogEntry | undefined {
  return entry.method === "confirm" ? entry : undefined;
}

export function inputEntry(entry: DialogEntry): InputDialogEntry | undefined {
  return entry.method === "input" ? entry : undefined;
}

export function editorEntry(entry: DialogEntry): EditorDialogEntry | undefined {
  return entry.method === "editor" ? entry : undefined;
}

function openDialog(
  frame: HostDialogRequestFrame,
  deliveredAtMs: number,
  redeliveries: number,
): DialogEntry {
  const base: DialogEntryBase = {
    identity: dialogIdentity(frame),
    deliveredAtMs: deliveredAtMs,
    redeliveries: redeliveries,
    status: "open",
    answer: null,
    cancelledBy: null,
    failure: null,
  };
  if (frame.method === "select") return { ...base, method: "select", frame: frame };
  if (frame.method === "question") return { ...base, method: "question", frame: frame };
  if (frame.method === "confirm") return { ...base, method: "confirm", frame: frame };
  if (frame.method === "input") return { ...base, method: "input", frame: frame };
  return { ...base, method: "editor", frame: frame };
}

/**
 * `question` prompts are keyed by the host's `requestId` so a replay that carries a fresh frame id
 * updates the prompt instead of duplicating it; the other four methods have no such id, so their
 * frame id is their identity.
 */
export function dialogIdentity(frame: HostDialogRequestFrame): string {
  return frame.method === "question" ? "question:" + frame.requestId : frame.method + ":" + frame.id;
}

/** A host-authored multi-line string, split the way every frame that carries one is displayed. */
export function textLines(value: string): readonly string[] {
  return value.split("\n").filter((line) => line.trim().length > 0);
}

export function dialogTitleLines(frame: { readonly title: string }): readonly string[] {
  return textLines(frame.title);
}

/** The title lines an entry draws; a `question` frame has no title (its questions carry headers). */
export function entryTitleLines(entry: DialogEntry): readonly string[] {
  return entry.method === "question" ? [] : dialogTitleLines(entry.frame);
}

export function dialogEntryOf(entries: readonly DialogEntry[], identity: string): DialogEntry | undefined {
  return entries.find((entry) => entry.identity === identity);
}

export function liveDialogs(entries: readonly DialogEntry[]): readonly DialogEntry[] {
  return entries.filter((entry) => entry.status === "open");
}

/**
 * Folds one host delivery into the queue.
 *
 * A frame id seen again while its entry is still open is the same dialog delivered twice: the entry
 * keeps its identity and takes the newer frame, so the panel never shows two rows for one prompt. An
 * identity that already settled is only reopened when the host re-asks under a *new* frame id; the
 * same frame id arriving after settlement is a stale replay and is ignored, so a prompt the host
 * already timed out or cancelled cannot be resurrected as answerable.
 */
export function applyDialogDelivery(
  entries: readonly DialogEntry[],
  frame: HostDialogRequestFrame,
  deliveredAtMs: number,
): readonly DialogEntry[] {
  const identity = dialogIdentity(frame);
  const existing = dialogEntryOf(entries, identity);
  if (existing === undefined) return [...entries, openDialog(frame, deliveredAtMs, 0)];
  const staleReplay = existing.frame.id === frame.id && existing.status !== "open";
  if (staleReplay) return entries;
  const updated = openDialog(frame, deliveredAtMs, existing.redeliveries + 1);
  return entries.map((entry) => (entry.identity === identity ? updated : entry));
}

/**
 * Folds a close notification in. The store emits the answered frame's id, so an entry is found by
 * the frame it currently holds; an entry this client already settled is untouched.
 */
export function applyDialogClose(entries: readonly DialogEntry[], frameId: string): readonly DialogEntry[] {
  return entries.map((entry) => {
    if (entry.frame.id !== frameId || entry.status !== "open") return entry;
    return { ...entry, status: "cancelled", cancelledBy: "host", failure: null };
  });
}

export function settleDialogAnswer(
  entries: readonly DialogEntry[],
  identity: string,
  summary: string,
): readonly DialogEntry[] {
  return entries.map((entry) => {
    if (entry.identity !== identity) return entry;
    return { ...entry, status: "answered", answer: summary, cancelledBy: null, failure: null };
  });
}

export function settleDialogCancel(
  entries: readonly DialogEntry[],
  identity: string,
  by: DialogCancelledBy,
): readonly DialogEntry[] {
  return entries.map((entry) => {
    if (entry.identity !== identity) return entry;
    return { ...entry, status: "cancelled", cancelledBy: by, failure: null };
  });
}

export function recordDialogFailure(
  entries: readonly DialogEntry[],
  identity: string,
  message: string,
): readonly DialogEntry[] {
  return entries.map((entry) => {
    if (entry.identity !== identity) return entry;
    return { ...entry, failure: message };
  });
}

/**
 * `deadlineAtMs` on a `question` is on the host's clock, so the host-computed `remainingMs` plus
 * local elapsed time is the only honest anchor. A `select`, `confirm` or `input` frame carries a
 * bare `timeout` with no start, and `input`'s optional `deadlineAtMs` arrives without the
 * `askedAtMs`/`remainingMs` pair that would let it be anchored locally, so none of them gets a
 * countdown; an `editor` frame carries no deadline at all.
 */
export function remainingMsFor(frame: HostDialogRequestFrame, deliveredAtMs: number, nowMs: number): number | null {
  if (frame.method !== "question") return null;
  return Math.max(0, frame.remainingMs - Math.max(0, nowMs - deliveredAtMs));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return hours + "h " + minutes + "m";
  if (minutes > 0) return minutes + "m " + seconds + "s";
  return seconds + "s";
}

export type QuestionDraft = {
  readonly selections: Readonly<Record<string, readonly string[]>>;
  readonly texts: Readonly<Record<string, string>>;
  readonly comment: string;
};

export const emptyQuestionDraft: QuestionDraft = { selections: {}, texts: {}, comment: "" };

export function toggleDraftOption(
  draft: QuestionDraft,
  question: QuestionRequestFrame["questions"][number],
  label: string,
): QuestionDraft {
  const current = draft.selections[question.id] ?? [];
  const next = question.multiSelect
    ? current.includes(label)
      ? current.filter((held) => held !== label)
      : [...current, label]
    : current.includes(label)
      ? []
      : [label];
  return { ...draft, selections: { ...draft.selections, [question.id]: next } };
}

export function draftQuestionText(draft: QuestionDraft, questionId: string, text: string): QuestionDraft {
  return { ...draft, texts: { ...draft.texts, [questionId]: text } };
}

export function draftComment(draft: QuestionDraft, comment: string): QuestionDraft {
  return { ...draft, comment: comment };
}

export type QuestionAnswerBuild =
  | { readonly ok: true; readonly answers: HostQuestionAnswers; readonly comment?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * A submission with nothing in it is refused here because the host would refuse it as
 * `question_incomplete`; this is frame completeness, not an authorization judgement.
 */
export function buildQuestionAnswer(frame: QuestionRequestFrame, draft: QuestionDraft): QuestionAnswerBuild {
  const answers: Record<string, { readonly selected: readonly string[]; readonly text?: string }> = {};
  for (const question of frame.questions) {
    const selected = draft.selections[question.id] ?? [];
    const text = (draft.texts[question.id] ?? "").trim();
    if (!question.multiSelect && selected.length > 1) {
      return { ok: false, reason: question.id + " accepts a single selection" };
    }
    const unknown = selected.find((label) => !question.options.some((option) => option.label === label));
    if (unknown !== undefined) return { ok: false, reason: unknown + " is not an option the host offered" };
    if (selected.length === 0 && text.length === 0) continue;
    answers[question.id] = text.length > 0 ? { selected: selected, text: text } : { selected: selected };
  }
  const comment = draft.comment.trim();
  if (Object.keys(answers).length === 0 && comment.length === 0) {
    return { ok: false, reason: "the host refuses an answer with no selection, text or comment" };
  }
  return comment.length === 0 ? { ok: true, answers: answers } : { ok: true, answers: answers, comment: comment };
}

export function summarizeQuestionAnswer(build: { readonly answers: HostQuestionAnswers; readonly comment?: string }): string {
  const count = Object.keys(build.answers).length;
  return count + (count === 1 ? " answer" : " answers") + (build.comment === undefined ? "" : " and a comment");
}

/** The text a `confirm` answer sends, in the shape the settled line shows. */
export function summarizeConfirmAnswer(confirmed: boolean): string {
  return confirmed ? "confirmed=true" : "confirmed=false";
}

/**
 * The text an `input` or `editor` answer sends, in the shape the settled line shows. A secret is
 * never echoed back into the panel, not even in part: only its length is reported.
 */
export function summarizeTextAnswer(frame: InputRequestFrame | EditorRequestFrame, value: string): string {
  if (frame.method === "input" && frame.secret === true) {
    return "a secret value (" + Array.from(value).length + " characters, not shown)";
  }
  if (value.length === 0) return "an empty value";
  if (frame.method === "editor") {
    const lines = textLines(value).length;
    if (lines > 1) return "text of " + lines + " lines";
  }
  return value;
}

/**
 * What a secret field draws instead of its draft. A character count is all this panel is allowed to
 * reveal: the host, not the panel, holds the value.
 */
export function secretMask(value: string): string {
  return "•".repeat(Array.from(value).length);
}
