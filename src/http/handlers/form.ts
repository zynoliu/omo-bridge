import { isAbsolute, resolve } from "node:path";
import {
  classifyUiRequest,
  type FormUiRequest,
  type QuestionSpec,
  type QuestionUiRequest,
} from "../../bridge/ui-requests";
import type { SenpiExtensionUIResponse } from "../../senpi/transport";
import { eventBus as sharedEventBus, type EventBus } from "../events";
import { locationRef, type LocationPublicRef } from "./fs-location";
import { HandlerProblem, jsonResponse, noContent, respond } from "./problem";
import { requireKnownSession } from "./session-write";

// The form bridge translates senpi dialogs into opencode `form.*` state and turns the TUI's answer
// back into the `extension_ui_response` the engine is blocked on.
//
// A `question` frame becomes one form field per question (positional keys `q0`, `q1`, ...) and its
// answer maps back onto `questions[].id`; `select`/`input`/`confirm`/`editor` frames become a
// single-field form whose answer maps back onto `value` or `confirmed`. Status frames
// (`notify`/`setStatus`/`setWidget`/`setTitle`, ...) carry no answer and are dropped.
//
// `POST /api/session/:id/form` is the injection endpoint used to seed a pending form (the TUI QA
// harness needs one without a model turn); such a form has no engine prompt behind it, so its reply
// sends no wire frame.
//
// Handlers take (request, url) and read the transport from a module-level seam, matching the other
// http handlers; route mounting stays an independent change (see src/http/routes).

/** `Form.Info` (`packages/schema/src/form.ts:136`): what the TUI renders and answers. */
export type FormFieldOption = {
  value: string;
  label: string;
  description?: string;
};

export type FormWhen = {
  key: string;
  op: "eq" | "neq";
  value: string | number | boolean;
};

type FieldBase = {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: FormWhen[];
};

export type FormField =
  | (FieldBase & {
      type: "string";
      format?: "email" | "uri" | "date" | "date-time";
      minLength?: number;
      maxLength?: number;
      pattern?: string;
      placeholder?: string;
      default?: string;
      options?: FormFieldOption[];
      custom?: boolean;
    })
  | (FieldBase & {
      type: "number" | "integer";
      minimum?: number;
      maximum?: number;
      default?: number;
    })
  | (FieldBase & { type: "boolean"; default?: boolean })
  | (FieldBase & {
      type: "multiselect";
      options: FormFieldOption[];
      minItems?: number;
      maxItems?: number;
      custom?: boolean;
      default?: string[];
    })
  | { key: string; type: "external"; url: string; title?: string; description?: string };

export type FormInfo = {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: FormField[];
};

export type FormValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormValue>;

/** A filed form plus the bridge-side correlation the opencode contract does not carry. */
export type PendingForm = FormInfo & {
  state: "pending" | "settled";
  settledAt?: number;
  method: "injected" | FrameMethod;
  /** The frame id an answer must echo; absent on injected forms. */
  uiRequestId?: string;
  /** The engine's questions in positional order; present on `question` frames only. */
  questions?: QuestionSpec[];
};

type FrameMethod = "question" | "select" | "input" | "confirm" | "editor";

/** The slice of the senpi transport the bridge answers through; absent methods degrade loudly. */
export type FormTransport = {
  readonly sessionId?: string | undefined;
  sendExtensionUIResponse?: (response: SenpiExtensionUIResponse) => Promise<void>;
};

export type FormFrameStats = {
  filed: number;
  droppedStatus: number;
};

const SETTLED_RETENTION_MS = 10 * 60 * 1000;
const FIELD_TYPES = ["string", "number", "integer", "boolean", "multiselect", "external"] as const;
const STRING_FORMATS = ["email", "uri", "date", "date-time"] as const;
const DIALOG_TITLES: Record<Exclude<FrameMethod, "question">, string> = {
  select: "Select",
  input: "Input",
  confirm: "Confirm",
  editor: "Editor",
};

let transport: FormTransport | undefined;
let bus: EventBus = sharedEventBus;

export function setFormTransport(next: FormTransport | undefined): void {
  transport = next;
}

export function getFormTransport(): FormTransport | undefined {
  return transport;
}

export function setFormEventBus(next: EventBus | undefined): void {
  bus = next ?? sharedEventBus;
}

// One registry holds every form; a form is scoped to its session by the sessionID it carries, so
// both list endpoints read the same rows. Settled rows stay briefly to answer a repeated reply with
// 409 instead of 404, matching the opencode Form service's retention.
const forms = new Map<string, PendingForm>();
let idSequence = 0;
let filedFrames = 0;
let droppedStatusFrames = 0;

export function resetForms(): void {
  forms.clear();
  idSequence = 0;
  filedFrames = 0;
  droppedStatusFrames = 0;
}

export function formFrameStats(): FormFrameStats {
  return { filed: filedFrames, droppedStatus: droppedStatusFrames };
}

export function listPendingForms(sessionID?: string): FormInfo[] {
  pruneSettled();
  return [...forms.values()]
    .filter((row) => row.state === "pending" && (sessionID === undefined || row.sessionID === sessionID))
    .map(toInfo);
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

function formNotFound(formID: string): HandlerProblem {
  return new HandlerProblem(404, "FormNotFoundError", `Form not found: ${formID}`, { id: formID });
}

function formSettled(formID: string): HandlerProblem {
  return new HandlerProblem(409, "FormAlreadySettledError", `Form already settled: ${formID}`, { id: formID });
}

function invalidAnswer(formID: string, message: string): HandlerProblem {
  return new HandlerProblem(400, "FormInvalidAnswerError", message, { id: formID });
}

function serviceUnavailable(message: string): HandlerProblem {
  return new HandlerProblem(503, "ServiceUnavailableError", message, { service: "senpi" });
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function sessionIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("session");
  const sessionID = at >= 0 ? segments[at + 1] : undefined;
  if (sessionID === undefined || sessionID.length === 0) {
    throw invalidRequest(`no session id in path ${url.pathname}`, "sessionID");
  }
  return sessionID;
}

function formIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("form");
  const formID = at >= 0 ? segments[at + 1] : undefined;
  if (formID === undefined || formID.length === 0) {
    throw invalidRequest(`no form id in path ${url.pathname}`, "formID");
  }
  return formID;
}

function locationFor(url: URL): LocationPublicRef {
  const raw = url.searchParams.get("location[directory]")?.trim();
  const directory =
    raw === undefined || raw.length === 0 ? process.cwd() : isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
  return locationRef(directory);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw invalidRequest("form payload must be JSON", "body");
  }
  const record = asRecord(payload);
  if (record === undefined) throw invalidRequest("form payload must be a JSON object", "body");
  return record;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest(`${field} must be a non-empty string`, field);
  }
  return value;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (record === undefined) throw invalidRequest(`${field} must be a JSON object`, field);
  return record;
}

function nextFormId(): string {
  idSequence += 1;
  return `frm_${Date.now().toString(36)}${idSequence.toString(36)}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The opencode-facing row: only the contract's fields, cloned so readers cannot mutate the registry. */
function toInfo(row: PendingForm): FormInfo {
  return {
    id: row.id,
    sessionID: row.sessionID,
    title: row.title,
    ...(row.metadata === undefined ? {} : { metadata: clone(row.metadata) }),
    fields: clone(row.fields),
  };
}

function pruneSettled(): void {
  const cutoff = Date.now() - SETTLED_RETENTION_MS;
  for (const [id, row] of forms) {
    if (row.state === "settled" && row.settledAt !== undefined && row.settledAt < cutoff) forms.delete(id);
  }
}

type RegisterInput = Omit<FormInfo, "id"> & {
  method: FrameMethod | "injected";
  uiRequestId?: string;
  questions?: QuestionSpec[];
};

function register(input: RegisterInput): PendingForm {
  pruneSettled();
  const row: PendingForm = {
    id: nextFormId(),
    sessionID: input.sessionID,
    title: input.title,
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    fields: input.fields,
    state: "pending",
    method: input.method,
    ...(input.uiRequestId === undefined ? {} : { uiRequestId: input.uiRequestId }),
    ...(input.questions === undefined ? {} : { questions: input.questions }),
  };
  forms.set(row.id, row);
  filedFrames += 1;
  bus.publish({ type: "form.created", data: { form: toInfo(row) } });
  return row;
}

function settle(row: PendingForm): void {
  row.state = "settled";
  row.settledAt = Date.now();
}

function requirePendingForm(sessionID: string, formID: string): PendingForm {
  const row = forms.get(formID);
  if (row === undefined || row.sessionID !== sessionID) throw formNotFound(formID);
  if (row.state !== "pending") throw formSettled(formID);
  return row;
}

function requireSend(): (response: SenpiExtensionUIResponse) => Promise<void> {
  const send = transport?.sendExtensionUIResponse;
  if (send === undefined) throw serviceUnavailable("no senpi transport is wired into the http layer");
  return (response) => send.call(transport, response);
}

export async function handleFormCreate(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    await requireKnownSession(sessionID);
    const payload = await readBody(request);
    const title = requireText(payload.title, "title");
    const fields = parseFields(payload.fields);
    const metadata = optionalRecord(payload.metadata, "metadata");
    const created = register({ sessionID, title, fields, method: "injected", ...(metadata === undefined ? {} : { metadata }) });
    return jsonResponse(200, { data: toInfo(created) });
  });
}

export async function handleSessionFormList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    await requireKnownSession(sessionID);
    return jsonResponse(200, { data: listPendingForms(sessionID) });
  });
}

export async function handleFormList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => jsonResponse(200, { location: locationFor(url), data: listPendingForms() }));
}

export async function handleFormReply(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const formID = formIdFromPath(url);
    const row = requirePendingForm(sessionID, formID);
    const payload = await readBody(request);
    const answer = parseAnswer(payload.answer);
    requireKnownFields(row, answer);

    // The engine is blocked on this form only when a real frame filed it. The frame is sent before
    // the registry changes, so a transport failure leaves the form answerable.
    const frameId = row.uiRequestId;
    if (frameId !== undefined) {
      const send = requireSend();
      await send(responseFor(row, answer, frameId));
    }

    settle(row);
    bus.publish({ type: "form.replied", data: { id: row.id, sessionID: row.sessionID, answer } });
    return noContent();
  });
}

export async function handleFormCancel(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    const formID = formIdFromPath(url);
    const row = requirePendingForm(sessionID, formID);

    const frameId = row.uiRequestId;
    if (frameId !== undefined) {
      const send = requireSend();
      await send(cancelFrame(frameId));
    }

    settle(row);
    bus.publish({ type: "form.cancelled", data: { id: row.id, sessionID: row.sessionID } });
    return noContent();
  });
}

/**
 * The question half of the shared `extension_ui_request` dispatcher. A frame the classifier calls a
 * status is dropped and counted; a permission or dialog frame belongs to another entry point and is
 * ignored here. The frame id is what the engine correlates its answer by, so a frame without one
 * (or without a session) cannot be filed.
 */
export function onQuestionFrame(frame: unknown, sessionID?: string): PendingForm | undefined {
  const classification = classifyUiRequest(frame);
  if (classification.kind === "status") {
    droppedStatusFrames += 1;
    return undefined;
  }
  if (classification.kind !== "question") return undefined;
  return fileQuestionFrame(classification.question, sessionID);
}

/** The dialog half of the dispatcher: `select`/`input`/`confirm`/`editor` become one-field forms. */
export function onDialogFrame(frame: unknown, sessionID?: string): PendingForm | undefined {
  const classification = classifyUiRequest(frame);
  if (classification.kind === "status") {
    droppedStatusFrames += 1;
    return undefined;
  }
  if (classification.kind !== "form") return undefined;
  return fileDialogFrame(classification.form, sessionID);
}

function fileQuestionFrame(request: QuestionUiRequest, sessionID?: string): PendingForm | undefined {
  const frameId = request.id;
  const target = sessionID ?? frameSessionId(request);
  if (typeof frameId !== "string" || frameId.length === 0 || target === undefined) return undefined;
  const questions = request.questions.flatMap((question) => {
    const parsed = parseQuestionSpec(question);
    return parsed === undefined ? [] : [parsed];
  });
  // A frame whose questions cannot all be parsed cannot be answered safely.
  if (questions.length === 0 || questions.length !== request.questions.length) return undefined;

  return register({
    sessionID: target,
    title: "Questions",
    metadata: {
      kind: "question",
      requestId: request.requestId,
      ...(typeof request.toolCallId === "string" ? { toolCallId: request.toolCallId } : {}),
    },
    fields: questions.map((question, index) => questionField(question, index)),
    method: "question",
    uiRequestId: frameId,
    questions,
  });
}

function fileDialogFrame(request: FormUiRequest, sessionID?: string): PendingForm | undefined {
  const frameId = request.id;
  const target = sessionID ?? frameSessionId(request);
  if (typeof frameId !== "string" || frameId.length === 0 || target === undefined) return undefined;

  const method = request.method;
  const title = typeof request.title === "string" && request.title.trim().length > 0
    ? request.title
    : DIALOG_TITLES[method];
  return register({
    sessionID: target,
    title,
    metadata: { kind: method },
    fields: [dialogField(request, method)],
    method,
    uiRequestId: frameId,
  });
}

function questionField(question: QuestionSpec, index: number): FormField {
  return {
    key: `q${index}`,
    title: question.header,
    description: question.question,
    type: question.multiSelect ? "multiselect" : "string",
    options: (question.options ?? []).map((option) => ({
      value: option.label,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    custom: true,
  };
}

function dialogField(request: FormUiRequest, method: Exclude<FrameMethod, "question">): FormField {
  const title = typeof request.title === "string" && request.title.trim().length > 0 ? request.title : DIALOG_TITLES[method];
  if (method === "confirm") {
    return {
      key: "confirmed",
      type: "boolean",
      title,
      ...(typeof request.message === "string" ? { description: request.message } : {}),
    };
  }
  if (method === "select") {
    const options = Array.isArray(request.options)
      ? request.options.flatMap((option) => (typeof option === "string" ? [{ value: option, label: option }] : []))
      : [];
    return {
      key: "value",
      type: "string",
      title,
      ...(options.length === 0 ? {} : { options }),
      custom: true,
    };
  }
  if (method === "editor") {
    return {
      key: "value",
      type: "string",
      title,
      ...(typeof request.prefill === "string" ? { default: request.prefill } : {}),
    };
  }
  return {
    key: "value",
    type: "string",
    title,
    ...(typeof request.placeholder === "string" ? { placeholder: request.placeholder } : {}),
  };
}

function parseQuestionSpec(value: unknown): QuestionSpec | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const id = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;
  if (id === undefined) return undefined;
  const options = Array.isArray(record.options)
    ? record.options.flatMap((option) => {
        const entry = asRecord(option);
        const label = typeof entry?.label === "string" ? entry.label : undefined;
        if (label === undefined) return [];
        const description = typeof entry?.description === "string" ? entry.description : undefined;
        return [{ label, ...(description === undefined ? {} : { description }) }];
      })
    : [];
  return {
    id,
    header: typeof record.header === "string" && record.header.length > 0 ? record.header : id,
    question: typeof record.question === "string" && record.question.length > 0 ? record.question : id,
    multiSelect: record.multiSelect === true,
    options,
  };
}

function frameSessionId(frame: Record<string, unknown>): string | undefined {
  for (const key of ["sessionId", "sessionID"]) {
    const value = frame[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return transport?.sessionId;
}

function frameBase(frameId: string): { type: "extension_ui_response"; id: string; uiRequestId: string } {
  return { type: "extension_ui_response", id: frameId, uiRequestId: frameId };
}

function cancelFrame(frameId: string): SenpiExtensionUIResponse {
  return { ...frameBase(frameId), cancelled: true };
}

/** Map a form answer onto the engine's `extension_ui_response` for the frame this form filed. */
function responseFor(row: PendingForm, answer: FormAnswer, frameId: string): SenpiExtensionUIResponse {
  if (row.method === "question") {
    const answers: Record<string, { selected: string[] }> = {};
    // Fields are keyed positionally (`q0`, `q1`, ...) and the engine's ids live on `questions[]`.
    for (const [index, question] of (row.questions ?? []).entries()) {
      const value = answer[`q${index}`];
      if (value === undefined) continue;
      answers[question.id] = { selected: Array.isArray(value) ? value.map(String) : [String(value)] };
    }
    if (Object.keys(answers).length === 0) {
      throw invalidAnswer(row.id, "answer does not answer any question");
    }
    return { ...frameBase(frameId), answers };
  }

  if (row.method === "confirm") {
    const confirmed = answer.confirmed;
    if (typeof confirmed !== "boolean") {
      throw invalidAnswer(row.id, "answer.confirmed must be a boolean");
    }
    return { ...frameBase(frameId), confirmed };
  }

  const value = answer.value;
  if (typeof value !== "string") {
    throw invalidAnswer(row.id, "answer.value must be a string");
  }
  return { ...frameBase(frameId), value };
}

function requireKnownFields(row: PendingForm, answer: FormAnswer): void {
  const known = new Set(row.fields.map((field) => field.key));
  for (const key of Object.keys(answer)) {
    if (!known.has(key)) throw invalidAnswer(row.id, `Unknown form field: ${key}`);
  }
}

function parseAnswer(value: unknown): FormAnswer {
  const record = asRecord(value);
  if (record === undefined) throw invalidRequest("answer must be a JSON object", "answer");
  const answer: FormAnswer = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      answer[key] = raw;
      continue;
    }
    if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) {
      answer[key] = [...raw];
      continue;
    }
    throw invalidRequest(`answer.${key} must be a string, number, boolean or string array`, `answer.${key}`);
  }
  return answer;
}

function parseFields(value: unknown): FormField[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidRequest("fields must be a non-empty array", "fields");
  const fields = value.map((entry, index) => parseField(entry, index));
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) throw invalidRequest(`duplicate field key: ${field.key}`, "fields");
    keys.add(field.key);
  }
  return fields;
}

function parseField(value: unknown, index: number): FormField {
  const at = `fields[${index}]`;
  const record = asRecord(value);
  if (record === undefined) throw invalidRequest(`${at} must be a JSON object`, "fields");
  const key = requireText(record.key, `${at}.key`);
  const type = FIELD_TYPES.find((candidate) => candidate === record.type);
  if (type === undefined) {
    throw invalidRequest(`${at}.type must be one of ${FIELD_TYPES.join(", ")}`, "fields");
  }

  if (type === "external") {
    return {
      key,
      type,
      url: requireText(record.url, `${at}.url`),
      ...(typeof record.title === "string" ? { title: record.title } : {}),
      ...(typeof record.description === "string" ? { description: record.description } : {}),
    };
  }

  const base: FieldBase = {
    key,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.description === "string" ? { description: record.description } : {}),
    ...(typeof record.required === "boolean" ? { required: record.required } : {}),
    ...(typeof record.hidden === "boolean" ? { hidden: record.hidden } : {}),
    ...(record.when === undefined ? {} : { when: parseWhen(record.when, at) }),
  };

  if (type === "string") {
    const format = record.format === undefined
      ? undefined
      : STRING_FORMATS.find((candidate) => candidate === record.format);
    if (record.format !== undefined && format === undefined) {
      throw invalidRequest(`${at}.format must be one of ${STRING_FORMATS.join(", ")}`, "fields");
    }
    const minLength = optionalCount(record.minLength, `${at}.minLength`);
    const maxLength = optionalCount(record.maxLength, `${at}.maxLength`);
    return {
      ...base,
      type,
      ...(format === undefined ? {} : { format }),
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(typeof record.pattern === "string" ? { pattern: record.pattern } : {}),
      ...(typeof record.placeholder === "string" ? { placeholder: record.placeholder } : {}),
      ...(typeof record.default === "string" ? { default: record.default } : {}),
      ...(record.options === undefined ? {} : { options: parseOptions(record.options, at) }),
      ...(typeof record.custom === "boolean" ? { custom: record.custom } : {}),
    };
  }

  if (type === "number" || type === "integer") {
    return {
      ...base,
      type,
      ...(typeof record.minimum === "number" ? { minimum: record.minimum } : {}),
      ...(typeof record.maximum === "number" ? { maximum: record.maximum } : {}),
      ...(typeof record.default === "number" ? { default: record.default } : {}),
    };
  }

  if (type === "boolean") {
    return { ...base, type, ...(typeof record.default === "boolean" ? { default: record.default } : {}) };
  }

  const options = record.options === undefined ? undefined : parseOptions(record.options, at);
  if (options === undefined) throw invalidRequest(`${at}.options is required for a multiselect field`, "fields");
  const minItems = optionalCount(record.minItems, `${at}.minItems`);
  const maxItems = optionalCount(record.maxItems, `${at}.maxItems`);
  return {
    ...base,
    type,
    options,
    ...(minItems === undefined ? {} : { minItems }),
    ...(maxItems === undefined ? {} : { maxItems }),
    ...(typeof record.custom === "boolean" ? { custom: record.custom } : {}),
    ...(record.default === undefined ? {} : { default: stringList(record.default, `${at}.default`) }),
  };
}

function parseOptions(value: unknown, at: string): FormFieldOption[] {
  if (!Array.isArray(value)) throw invalidRequest(`${at}.options must be an array`, "fields");
  return value.map((entry, index) => {
    const option = asRecord(entry);
    if (option === undefined) throw invalidRequest(`${at}.options[${index}] must be a JSON object`, "fields");
    return {
      value: requireText(option.value, `${at}.options[${index}].value`),
      label: requireText(option.label, `${at}.options[${index}].label`),
      ...(typeof option.description === "string" ? { description: option.description } : {}),
    };
  });
}

function parseWhen(value: unknown, at: string): FormWhen[] {
  if (!Array.isArray(value)) throw invalidRequest(`${at}.when must be an array`, "fields");
  return value.map((entry, index) => {
    const condition = asRecord(entry);
    if (condition === undefined) throw invalidRequest(`${at}.when[${index}] must be a JSON object`, "fields");
    const op = condition.op === "eq" || condition.op === "neq" ? condition.op : undefined;
    if (op === undefined) throw invalidRequest(`${at}.when[${index}].op must be "eq" or "neq"`, "fields");
    const compared = condition.value;
    if (typeof compared !== "string" && typeof compared !== "number" && typeof compared !== "boolean") {
      throw invalidRequest(`${at}.when[${index}].value must be a string, number or boolean`, "fields");
    }
    return { key: requireText(condition.key, `${at}.when[${index}].key`), op, value: compared };
  });
}

function optionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidRequest(`${field} must be a non-negative integer`, "fields");
  }
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw invalidRequest(`${field} must be an array of strings`, "fields");
  }
  return [...value];
}
