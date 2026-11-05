import { classifyUiRequest, PERMISSION_TITLE_PREFIX } from "../../bridge/ui-requests";
import type { SenpiExtensionUIResponse } from "../../senpi/transport";
import { eventBus as sharedEventBus, type EventBus } from "../events";

// The permission bridge translates senpi `extension_ui_request` permission prompts into opencode
// `permission.asked` / `permission.replied` state and turns the TUI's reply back into the
// `extension_ui_response` the engine is blocked on.
//
// A rejection with feedback is a two-phase wire dialog, not one frame: the engine raises its feedback
// `input` only when the select was answered with "Deny with feedback", and a bare "Deny" settles the
// call with no message. So the reply parks the feedback under the tool call id and the follow-up
// frame is answered from the frame dispatcher instead.
//
// `POST /api/session/:id/permission` is the injection endpoint used to seed a pending dialog (the TUI
// QA harness needs one without a model turn); such a request has no engine prompt behind it, so its
// reply publishes `permission.replied` and sends no wire frame.
//
// Handlers take (request, url) and read the transport from a module-level seam, matching the other
// http handlers; route mounting stays an independent change (see src/http/routes).

const JSON_CONTENT_TYPE = "application/json";

/** The option wording the engine's permission prompt uses (`permission-system/prompt.js`). */
export const DEFAULT_PERMISSION_OPTIONS: readonly string[] = [
  "Allow once",
  "Allow always",
  "Deny",
  "Deny with feedback",
];
export const DENY_OPTION = "Deny";
export const DENY_WITH_FEEDBACK_OPTION = "Deny with feedback";
const UNKNOWN_ACTION = "unknown";

/** `Permission.Request` (`packages/schema/src/permission.ts:36`): what the TUI renders and answers. */
export type PermissionRequest = {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  message?: string;
};

/**
 * A filed request plus the bridge-side correlation the opencode contract does not carry: the id of
 * the `extension_ui_request` being answered (absent on injected requests), the tool call it binds to,
 * and the options the engine offered.
 */
export type PendingPermission = PermissionRequest & {
  uiRequestId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  options: string[];
};

/** One row `GET /api/permission/saved` is meant to serve, recorded when a reply picks "always". */
export type SavedPermission = {
  sessionID: string;
  action: string;
  resource: string;
  savedAt: number;
};

/** The slice of the senpi transport the bridge answers through; absent methods degrade loudly. */
export type PermissionTransport = {
  readonly sessionId?: string | undefined;
  sendExtensionUIResponse?: (response: SenpiExtensionUIResponse) => Promise<void>;
};

let transport: PermissionTransport | undefined;
let bus: EventBus = sharedEventBus;

export function setPermissionTransport(next: PermissionTransport | undefined): void {
  transport = next;
}

export function getPermissionTransport(): PermissionTransport | undefined {
  return transport;
}

export function setPermissionEventBus(next: EventBus | undefined): void {
  bus = next ?? sharedEventBus;
}

const pending = new Map<string, PendingPermission>();
const saved = new Map<string, SavedPermission>();
// Deny-with-feedback messages waiting for the engine's follow-up `input` frame, keyed by tool call.
const feedback = new Map<string, string>();
let idSequence = 0;

export function resetPermissions(): void {
  pending.clear();
  saved.clear();
  feedback.clear();
  idSequence = 0;
}

/** The saved rules recorded by "always" replies, optionally narrowed to one session. */
export function listSavedPermissions(sessionID?: string): SavedPermission[] {
  return [...saved.values()]
    .filter((entry) => sessionID === undefined || entry.sessionID === sessionID)
    .map((entry) => ({ ...entry }));
}

class HandlerProblem extends Error {
  readonly status: number;
  readonly tag: string;
  readonly fields: Record<string, unknown>;

  constructor(status: number, tag: string, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = "HandlerProblem";
    this.status = status;
    this.tag = tag;
    this.fields = fields;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

function errorResponse(status: number, tag: string, message: string, fields: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { _tag: tag, message, ...fields });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function respond(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HandlerProblem) return errorResponse(error.status, error.tag, error.message, error.fields);
    return errorResponse(503, "ServiceUnavailableError", messageOf(error), { service: "senpi" });
  }
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

function permissionNotFound(requestID: string): HandlerProblem {
  return new HandlerProblem(404, "PermissionNotFoundError", `permission request not found: ${requestID}`, {
    requestID,
  });
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

function permissionIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("permission");
  const requestID = at >= 0 ? segments[at + 1] : undefined;
  if (requestID === undefined || requestID.length === 0) {
    throw invalidRequest(`no permission request id in path ${url.pathname}`, "requestID");
  }
  return requestID;
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
    throw invalidRequest("permission payload must be JSON", "body");
  }
  const record = asRecord(payload);
  if (record === undefined) throw invalidRequest("permission payload must be a JSON object", "body");
  return record;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidRequest(`${field} must be a non-empty string`, field);
  }
  return value;
}

function requireStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw invalidRequest(`${field} must be an array of strings`, field);
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw invalidRequest(`${field} must be an array of strings`, field);
    values.push(item);
  }
  return values;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value);
  if (record === undefined) throw invalidRequest(`${field} must be a JSON object`, field);
  return record;
}

const DECISIONS = ["once", "always", "reject"] as const;
export type PermissionDecision = (typeof DECISIONS)[number];

function parseDecision(value: unknown): PermissionDecision {
  const decision = DECISIONS.find((candidate) => candidate === value);
  if (decision === undefined) {
    throw invalidRequest(`decision must be one of ${DECISIONS.join(", ")} (found ${JSON.stringify(value)})`, "decision");
  }
  return decision;
}

function optionalMessage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalidRequest("message must be a string", "message");
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function nextPermissionId(): string {
  idSequence += 1;
  return `per_${Date.now().toString(36)}${idSequence.toString(36)}`;
}

/** The opencode-facing row: only the contract's fields, cloned so readers cannot mutate the registry. */
function toRequest(row: PendingPermission): PermissionRequest {
  return {
    id: row.id,
    sessionID: row.sessionID,
    action: row.action,
    resources: [...row.resources],
    ...(row.save === undefined ? {} : { save: [...row.save] }),
    ...(row.metadata === undefined ? {} : { metadata: { ...row.metadata } }),
    ...(row.message === undefined ? {} : { message: row.message }),
  };
}

/**
 * Parse the engine's prompt title into the opencode action and resources:
 * `Permission required: read\n\nPath: /project/a.txt\n\nPatterns:\n  - /project/a.txt`.
 * The display block is the only place the resource list exists on the wire.
 */
function describePermissionTitle(title: string): { action: string; resources: string[] } {
  const body = title.startsWith(PERMISSION_TITLE_PREFIX) ? title.slice(PERMISSION_TITLE_PREFIX.length) : title;
  const lines = body.split("\n");
  const action = (lines[0] ?? "").trim() || UNKNOWN_ACTION;
  const resources: string[] = [];
  const seen = new Set<string>();
  const push = (value: string): void => {
    if (value.length === 0 || seen.has(value)) return;
    seen.add(value);
    resources.push(value);
  };
  let inPatterns = false;
  for (const raw of lines.slice(1)) {
    const line = raw.trim();
    if (line.startsWith("Patterns:")) {
      inPatterns = true;
      continue;
    }
    if (inPatterns && line.startsWith("- ")) {
      push(line.slice(2).trim());
      continue;
    }
    inPatterns = false;
    const labeled = /^(Path|File|Directory|Command|Query):(.*)$/.exec(line);
    if (labeled === null) continue;
    let value = (labeled[2] ?? "").trim();
    if (labeled[1] === "Command" && value.startsWith("$ ")) value = value.slice(2).trim();
    push(value);
  }
  return { action, resources: resources.length > 0 ? resources : ["*"] };
}

type RegisterInput = {
  sessionID: string;
  action: string;
  resources: string[];
  save?: string[];
  metadata?: Record<string, unknown>;
  message?: string;
  uiRequestId?: string;
  toolCallId?: string;
  parentToolCallId?: string;
  options?: string[];
};

function register(input: RegisterInput): PendingPermission {
  const options = input.options === undefined || input.options.length === 0
    ? [...DEFAULT_PERMISSION_OPTIONS]
    : input.options;
  const row: PendingPermission = {
    id: nextPermissionId(),
    sessionID: input.sessionID,
    action: input.action,
    resources: [...input.resources],
    options,
    ...(input.save === undefined ? {} : { save: [...input.save] }),
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.uiRequestId === undefined ? {} : { uiRequestId: input.uiRequestId }),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.parentToolCallId === undefined ? {} : { parentToolCallId: input.parentToolCallId }),
  };
  pending.set(row.id, row);
  bus.publish({ type: "permission.asked", data: toRequest(row) });
  return row;
}

/**
 * File a real `extension_ui_request` frame. The runtime feeds every frame through here; a frame the
 * classifier does not call a permission is ignored, and one without a session or frame id cannot be
 * answered and is ignored too. Returns the filed row so the caller can log what it registered.
 *
 * `sessionID` is optional because the frame usually does not carry it: the runtime knows which
 * session the frame belongs to, and a routed frame may name `sessionId` itself.
 */
export async function onUiRequest(frame: unknown, sessionID?: string): Promise<PendingPermission | undefined> {
  const record = asRecord(frame);
  if (record === undefined) return undefined;
  const frameId = typeof record.id === "string" && record.id.length > 0 ? record.id : undefined;

  if (record.method === "input") {
    await answerFeedback(record, frameId);
    return undefined;
  }

  const classification = classifyUiRequest(record);
  if (classification.kind !== "permission") return undefined;
  const request = classification.permission;
  const target = sessionID ?? frameSessionId(request);
  if (target === undefined || frameId === undefined) return undefined;

  const { action, resources } = describePermissionTitle(request.title);
  const options = Array.isArray(request.options)
    ? request.options.filter((option): option is string => typeof option === "string")
    : [];
  return register({
    sessionID: target,
    action,
    resources,
    uiRequestId: frameId,
    toolCallId: typeof request.toolCallId === "string" ? request.toolCallId : undefined,
    parentToolCallId: typeof request.parentToolCallId === "string" ? request.parentToolCallId : undefined,
    options,
  });
}

function frameSessionId(frame: Record<string, unknown>): string | undefined {
  for (const key of ["sessionId", "sessionID"]) {
    const value = frame[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return transport?.sessionId;
}

/** Answer the engine's follow-up "Feedback" input with the message a deny-with-feedback reply parked. */
async function answerFeedback(frame: Record<string, unknown>, frameId: string | undefined): Promise<void> {
  const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : undefined;
  if (toolCallId === undefined || frameId === undefined) return;
  const message = feedback.get(toolCallId);
  if (message === undefined) return;
  const send = requireSend();
  await send({ type: "extension_ui_response", id: frameId, value: message });
  feedback.delete(toolCallId);
}

function responseFrame(uiRequestId: string, value: string): SenpiExtensionUIResponse {
  return { type: "extension_ui_response", id: uiRequestId, value };
}

function requireSend(): (response: SenpiExtensionUIResponse) => Promise<void> {
  const send = transport?.sendExtensionUIResponse;
  if (send === undefined) throw serviceUnavailable("no senpi transport is wired into the http layer");
  return (response) => send.call(transport, response);
}

function optionAt(options: readonly string[], index: number, fallback: string): string {
  return options[index] ?? fallback;
}

function denyOption(options: readonly string[]): string {
  return options.find((option) => option.trim() === DENY_OPTION) ?? DENY_OPTION;
}

function denyWithFeedbackOption(options: readonly string[]): string | undefined {
  return options.find((option) => option.trim() === DENY_WITH_FEEDBACK_OPTION);
}

/**
 * The value the select must answer with, plus the feedback text to park when the engine will follow
 * up with its feedback input.
 */
function replyValue(
  decision: PermissionDecision,
  message: string | undefined,
  options: readonly string[],
): { value: string; parked?: string } {
  if (decision === "once") return { value: optionAt(options, 0, "Allow once") };
  if (decision === "always") return { value: optionAt(options, 1, "Allow always") };
  if (message === undefined) return { value: denyOption(options) };
  const feedbackOption = denyWithFeedbackOption(options);
  if (feedbackOption === undefined) return { value: denyOption(options) };
  return { value: feedbackOption, parked: message };
}

function rememberSaved(row: PendingPermission): void {
  const patterns = row.save !== undefined && row.save.length > 0 ? row.save : row.resources;
  for (const resource of patterns) {
    const key = `${row.sessionID}\u0000${row.action}\u0000${resource}`;
    const existing = saved.get(key);
    saved.set(key, {
      sessionID: row.sessionID,
      action: row.action,
      resource,
      savedAt: existing?.savedAt ?? Date.now(),
    });
  }
}

export async function handlePermissionCreate(request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const sessionID = sessionIdFromPath(url);
    const payload = await readBody(request);
    const action = requireText(payload.action, "action");
    const resources = requireStringList(payload.resources, "resources");
    const save = payload.save === undefined ? undefined : requireStringList(payload.save, "save");
    const metadata = optionalRecord(payload.metadata, "metadata");
    const created = register({ sessionID, action, resources, save, metadata });
    return jsonResponse(200, { data: { id: created.id, effect: "ask" } });
  });
}

export async function handlePermissionList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const sessionID = sessionIdFromPath(url);
    const data = [...pending.values()]
      .filter((row) => row.sessionID === sessionID)
      .map(toRequest);
    return jsonResponse(200, { data });
  });
}

export async function handlePermissionReply(request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const sessionID = sessionIdFromPath(url);
    const requestID = permissionIdFromPath(url);
    const row = pending.get(requestID);
    if (row === undefined || row.sessionID !== sessionID) throw permissionNotFound(requestID);

    const payload = await readBody(request);
    const decision = parseDecision(payload.decision);
    const message = optionalMessage(payload.message);

    // The engine is blocked on this request only when a real frame filed it. The frame is sent
    // before the registry changes, so a transport failure leaves the request answerable.
    const send = row.uiRequestId === undefined ? undefined : requireSend();
    const options = row.options.length > 0 ? row.options : DEFAULT_PERMISSION_OPTIONS;
    const reply = replyValue(decision, message, options);
    if (send !== undefined && row.uiRequestId !== undefined) {
      await send(responseFrame(row.uiRequestId, reply.value));
    }

    pending.delete(requestID);
    bus.publish({ type: "permission.replied", data: { sessionID, requestID, reply: decision } });
    if (decision === "always") rememberSaved(row);
    if (reply.parked !== undefined && row.toolCallId !== undefined) feedback.set(row.toolCallId, reply.parked);
    return noContent();
  });
}
