// Classification of senpi `extension_ui_request` frames into the four buckets the bridge serves.
//
// Permission prompts and question dialogs are first-class flows; every other dialog is a form and
// every fire-and-forget method is status. The classifier is total by design: a frame that does not
// match a known dialog shape is `status`, never an exception, so one odd host frame cannot take the
// event loop down.

export const PERMISSION_TITLE_PREFIX = "Permission required:";

/** Fields every outbound UI request carries; the method decides the rest. */
export type ExtensionUiFrame = {
  type?: "extension_ui_request";
  id?: string;
  method: string;
  [key: string]: unknown;
};

/**
 * A permission prompt: `method:"select"` whose title starts with `Permission required:`. The frame
 * binds the prompt to the tool call it approves with `toolCallId` (a codemode script adds
 * `parentToolCallId`); `options` is the wording the engine offers, which the reply must select from.
 */
export type PermissionUiRequest = ExtensionUiFrame & {
  method: "select";
  title: string;
  options?: string[];
  toolCallId?: string;
  parentToolCallId?: string;
};

export type QuestionOption = {
  label: string;
  description?: string;
};

export type QuestionSpec = {
  id: string;
  header: string;
  question: string;
  multiSelect: boolean;
  options?: QuestionOption[];
};

/** A question dialog: `method:"question"` with the `questions[]` payload mapped to a form. */
export type QuestionUiRequest = ExtensionUiFrame & {
  method: "question";
  requestId: string;
  questions: QuestionSpec[];
  toolCallId?: string;
};

/** Any other dialog: plain selects, free-form input, confirmation and the multi-line editor. */
export type FormUiRequest = ExtensionUiFrame & {
  method: "select" | "input" | "confirm" | "editor";
};

export type UiRequestClassification =
  | { kind: "permission"; permission: PermissionUiRequest }
  | { kind: "question"; question: QuestionUiRequest }
  | { kind: "form"; form: FormUiRequest }
  | { kind: "status" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function classifyUiRequest(frame: unknown): UiRequestClassification {
  const record = asRecord(frame);
  if (record === undefined) return { kind: "status" };
  if (record.type !== undefined && record.type !== "extension_ui_request") return { kind: "status" };
  const method = record.method;
  if (typeof method !== "string") return { kind: "status" };

  if (method === "select") {
    const title = record.title;
    if (typeof title === "string" && title.startsWith(PERMISSION_TITLE_PREFIX)) {
      return { kind: "permission", permission: record as PermissionUiRequest };
    }
    // A select with any other title is an ordinary dialog; only the permission title is a permission.
    return { kind: "form", form: record as FormUiRequest };
  }

  if (method === "question") {
    const requestId = record.requestId;
    if (typeof requestId === "string" && requestId.length > 0 && Array.isArray(record.questions)) {
      return { kind: "question", question: record as QuestionUiRequest };
    }
    return { kind: "status" };
  }

  if (method === "input" || method === "confirm" || method === "editor") {
    return { kind: "form", form: record as FormUiRequest };
  }

  // notify / setStatus / setWidget / setTitle / set_editor_text / setSubagentCost and anything new.
  return { kind: "status" };
}
