import { randomUUID } from "node:crypto";
import { projectFor, toPublicSessionInfo, type SessionRecord } from "../../model/session-map";
import type { SenpiImages, SenpiPromptOptions, SenpiSessionSummary, SenpiTransport } from "../../senpi/transport";

// Write-side session endpoints: create, prompt, synthetic input and slash commands.
//
// The transport is injected once with setSessionWriteTransport(), the same seam the read handlers
// use, so handlers stay `(request, url)` and the http layer owns no connection.
//
// Idempotency: senpi dedupes a delivery by durable session header id + clientMessageId, but the
// bridge must not even reach the wire twice for a replay the TUI re-sends after a dropped response.
// Admissions are therefore cached in-process under that same durable key; a repeated delivery
// returns the stored admission and sends nothing.

const JSON_CONTENT_TYPE = "application/json";
const DEFAULT_DELIVERY = "queue" as const;

// senpi refuses a client message id longer than 256 characters (docs/rpc.md, durable client identity).
export const MAX_CLIENT_MESSAGE_ID_LENGTH = 256;
export const MAX_REMEMBERED_ADMISSIONS = 4096;

export type Delivery = "steer" | "queue";

// Naming a session and listing its command surface are plain RPC commands that the SenpiTransport
// facade does not wrap; the raw attach channel is the only seam this layer may reach them through.
export interface PromptCommandChannel {
  request<T = unknown>(command: PromptCommand): Promise<T>;
}

export type PromptCommand =
  | { type: "set_session_name"; name: string }
  | { type: "get_commands" };

export type SessionWriteTransport = Pick<
  SenpiTransport,
  "openSession" | "prompt" | "steer" | "followUp" | "getState" | "listSessions"
> & {
  readonly sessionId?: string | undefined;
  readonly raw: PromptCommandChannel;
};

export type PublicInboxUser = {
  id: string;
  sessionID: string;
  time: { created: string };
  type: "user";
  payload: { text: string; files?: Array<{ uri: string }>; metadata?: Record<string, unknown> };
  delivery: Delivery;
  disposition: PromptDisposition;
  state: "running" | "queued" | "completed";
};

export type PublicInboxSynthetic = {
  id: string;
  sessionID: string;
  time: { created: string };
  type: "synthetic";
  payload: { text: string; description?: string; metadata?: Record<string, unknown> };
  delivery: Delivery;
  disposition: PromptDisposition;
  state: "running" | "queued" | "completed";
};

type PromptDisposition = "started" | "queued" | "handled";

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

let transport: SessionWriteTransport | undefined;

export function setSessionWriteTransport(next: SessionWriteTransport | undefined): void {
  transport = next;
}

export function getSessionWriteTransport(): SessionWriteTransport | undefined {
  return transport;
}

type AdmissionEntry = { admission?: PublicInboxUser; pending?: Promise<PublicInboxUser> };
const admissions = new Map<string, AdmissionEntry>();

export function resetPromptAdmissions(): void {
  admissions.clear();
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

function requireTransport(): SessionWriteTransport {
  if (transport === undefined) {
    throw new HandlerProblem(503, "ServiceUnavailableError", "no senpi transport is wired into the http layer", {
      service: "senpi",
    });
  }
  return transport;
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

function sessionNotFound(sessionID: string): HandlerProblem {
  return new HandlerProblem(404, "SessionNotFoundError", `session not found: ${sessionID}`, { sessionID });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asTrimmed(value: unknown): string | undefined {
  const text = asString(value)?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw invalidRequest("request body must be JSON", "body");
  }
  const record = asRecord(payload);
  if (record === undefined) throw invalidRequest("request body must be a JSON object", "body");
  return record;
}

function segmentsOf(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function sessionIdFromPath(url: URL): string {
  const segments = segmentsOf(url);
  const at = segments.indexOf("session");
  const sessionID = at >= 0 ? segments[at + 1] : undefined;
  if (sessionID === undefined || sessionID.length === 0) {
    throw invalidRequest(`no session id in path ${url.pathname}`, "sessionID");
  }
  return sessionID;
}

// The routing id is recycled by a reopened session, so admissions key on the durable identity only.
function durableKeyOf(row: SenpiSessionSummary): string {
  return row.durableSessionId ?? row.sessionPath ?? row.sessionId;
}

function matchesRow(row: SenpiSessionSummary, sessionID: string): boolean {
  return row.durableSessionId === sessionID || row.sessionId === sessionID || row.sessionPath === sessionID;
}

async function resolveTarget(
  caller: SessionWriteTransport,
  sessionID: string,
): Promise<{ row: SenpiSessionSummary; key: string }> {
  const rows = await caller.listSessions();
  for (const row of rows) {
    if (matchesRow(row, sessionID)) return { row, key: durableKeyOf(row) };
  }
  throw sessionNotFound(sessionID);
}

/**
 * The transport holds exactly one session open; sending to another one would land the input in the
 * wrong transcript. Re-attach by path when the target is a different session, exactly as a reader
 * would resume it, and refuse when there is no durable path to resume.
 */
async function ensureAttached(caller: SessionWriteTransport, row: SenpiSessionSummary): Promise<void> {
  const current = caller.sessionId;
  if (current === undefined || current === row.sessionId) return;
  if (row.sessionPath === undefined) {
    throw new HandlerProblem(409, "ConflictError", "the bridge holds a different session open and this one has no path to reopen", {
      sessionID: row.durableSessionId ?? row.sessionId,
    });
  }
  await caller.openSession({ sessionPath: row.sessionPath, retainOnDisconnect: true });
}

// A state that names another routing id says nothing about this target; a read failure is left to
// surface rather than silently routing a prompt into a turn.
async function isStreaming(caller: SessionWriteTransport, row: SenpiSessionSummary): Promise<boolean> {
  const state = await caller.getState();
  if (state.sessionId !== row.sessionId && state.sessionId !== row.durableSessionId) return false;
  return state.isStreaming === true;
}

function dispositionState(disposition: PromptDisposition): PublicInboxUser["state"] {
  if (disposition === "handled") return "completed";
  return disposition === "queued" ? "queued" : "running";
}

type ParsedInput = {
  text: string;
  images: NonNullable<SenpiImages>;
  files: Array<{ uri: string }>;
  delivery: Delivery;
  clientMessageId?: string;
  metadata?: Record<string, unknown>;
};

function parseDelivery(value: unknown): Delivery | undefined {
  if (value === undefined || value === null) return DEFAULT_DELIVERY;
  if (value === "steer") return "steer";
  if (value === "queue" || value === "followUp" || value === "follow_up") return "queue";
  return undefined;
}

// senpi receives bytes inline only, so a non-`data:` URL is dropped instead of sent as a broken image.
function imageOfDataUri(uri: string, declaredMime: string | undefined): { type: "image"; data: string; mimeType: string } | undefined {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(uri);
  if (match === null) return undefined;
  const mimeType = declaredMime?.trim() || match[1] || "application/octet-stream";
  const encoded = match[3] ?? "";
  if (match[2] === ";base64") return { type: "image", data: encoded, mimeType };
  try {
    return { type: "image", data: Buffer.from(decodeURIComponent(encoded), "utf8").toString("base64"), mimeType };
  } catch {
    return undefined;
  }
}

function parsePromptInput(body: Record<string, unknown>): ParsedInput {
  const delivery = parseDelivery(body.delivery);
  if (delivery === undefined) {
    throw invalidRequest(`delivery must be "steer" or "queue" (found ${JSON.stringify(body.delivery)})`, "delivery");
  }

  const texts: string[] = [];
  const images: NonNullable<SenpiImages> = [];
  const files: Array<{ uri: string }> = [];

  const acceptFile = (part: Record<string, unknown>): void => {
    const uri = asTrimmed(part.url) ?? asTrimmed(part.uri);
    if (uri === undefined) throw invalidRequest("a file part needs a url", "parts");
    files.push({ uri });
    const image = imageOfDataUri(uri, asTrimmed(part.mime) ?? asTrimmed(part.mimeType));
    if (image !== undefined) images.push(image);
  };

  const parts = body.parts;
  if (parts !== undefined) {
    if (!Array.isArray(parts)) throw invalidRequest("parts must be an array", "parts");
    for (const entry of parts) {
      const part = asRecord(entry);
      if (part === undefined) throw invalidRequest("each part must be an object", "parts");
      if (part.type === "text") {
        const text = asString(part.text);
        if (text === undefined) throw invalidRequest("a text part needs a text field", "parts");
        texts.push(text);
        continue;
      }
      if (part.type === "file") {
        acceptFile(part);
        continue;
      }
      throw invalidRequest(`unsupported part type ${JSON.stringify(part.type)}`, "parts");
    }
  } else {
    // The TUI data layer sends flat text/files instead of parts; both spellings must admit.
    const text = asString(body.text);
    if (text !== undefined) texts.push(text);
    const flatFiles = body.files;
    if (Array.isArray(flatFiles)) {
      for (const entry of flatFiles) {
        const file = asRecord(entry);
        if (file === undefined) throw invalidRequest("each file must be an object", "files");
        acceptFile(file);
      }
    }
  }

  const text = texts.join("\n");
  if (text.length === 0 && images.length === 0) {
    throw invalidRequest("prompt needs at least one text part or inline file", "parts");
  }

  const metadata = asRecord(body.metadata);
  const candidate = asTrimmed(body.id) ?? asTrimmed(metadata?.clientMessageId);
  if (candidate !== undefined && candidate.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    throw invalidRequest(
      `clientMessageId must be at most ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters (found ${candidate.length})`,
      "id",
    );
  }

  return {
    text,
    images,
    files,
    delivery,
    ...(candidate === undefined ? {} : { clientMessageId: candidate }),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

async function sendParsed(
  caller: SessionWriteTransport,
  row: SenpiSessionSummary,
  input: ParsedInput,
): Promise<PromptDisposition> {
  await ensureAttached(caller, row);
  const identity = input.clientMessageId === undefined ? undefined : { clientMessageId: input.clientMessageId };
  if (await isStreaming(caller, row)) {
    return input.delivery === "steer"
      ? await caller.steer(input.text, input.images.length > 0 ? input.images : undefined, identity)
      : await caller.followUp(input.text, input.images.length > 0 ? input.images : undefined, identity);
  }
  const options: SenpiPromptOptions = {
    ...(identity ?? {}),
    ...(input.images.length > 0 ? { images: input.images } : {}),
  };
  return Object.keys(options).length > 0 ? await caller.prompt(input.text, options) : await caller.prompt(input.text);
}

function rememberAdmission(key: string, entry: AdmissionEntry): void {
  if (admissions.size >= MAX_REMEMBERED_ADMISSIONS) {
    const oldest = admissions.keys().next();
    if (!oldest.done) admissions.delete(oldest.value);
  }
  admissions.set(key, entry);
}

function admissionOf(
  input: ParsedInput,
  key: string,
  disposition: PromptDisposition,
): PublicInboxUser {
  const id = input.clientMessageId ?? `msg_${randomUUID()}`;
  return {
    id,
    sessionID: key,
    time: { created: new Date().toISOString() },
    type: "user",
    payload: {
      text: input.text,
      ...(input.files.length === 0 ? {} : { files: input.files }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
    delivery: input.delivery,
    disposition,
    state: dispositionState(disposition),
  };
}

export async function handleSessionCreate(request: Request, _url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const body = await readBody(request);
    const location = asRecord(body.location);
    const directory = location === undefined ? undefined : asTrimmed(location.directory);
    if (location !== undefined && directory === undefined) {
      throw invalidRequest("location.directory must be a non-empty string", "location");
    }

    const opened = await caller.openSession({
      cwd: directory ?? process.cwd(),
      retainOnDisconnect: true,
    });
    const title = asTrimmed(body.title);
    if (title !== undefined) {
      try {
        await caller.raw.request({ type: "set_session_name", name: title });
      } catch (error) {
        // The session exists either way; a refused name must not report the creation as failed.
        console.warn(`omo-bridge: session ${opened.sessionId} created but not named: ${messageOf(error)}`);
      }
    }

    const cwd = directory ?? process.cwd();
    const rows = await caller.listSessions().catch(() => [] as SenpiSessionSummary[]);
    const row = rows.find((candidate) => candidate.sessionId === opened.sessionId);
    const observedAt = new Date().toISOString();
    const record: SessionRecord = {
      key: row === undefined ? opened.sessionId : durableKeyOf(row),
      routingId: opened.sessionId,
      ...(row?.sessionPath === undefined ? {} : { sessionPath: row.sessionPath }),
      cwd: row?.cwd ?? cwd,
      ...((title ?? row?.name) === undefined ? {} : { name: title ?? row?.name }),
      projectID: projectFor(row?.cwd ?? cwd).id,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    };
    return jsonResponse(200, { data: toPublicSessionInfo(record) });
  });
}

export async function handleSessionPrompt(request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request);
    const input = parsePromptInput(body);
    const target = await resolveTarget(caller, sessionID);

    if (input.clientMessageId === undefined) {
      const disposition = await sendParsed(caller, target.row, input);
      return jsonResponse(200, { data: admissionOf(input, target.key, disposition) });
    }

    const key = `${target.key}\u0000${input.clientMessageId}`;
    const entry = admissions.get(key);
    if (entry?.admission !== undefined) return jsonResponse(200, { data: entry.admission });
    if (entry?.pending !== undefined) return jsonResponse(200, { data: await entry.pending });

    const pending = (async (): Promise<PublicInboxUser> => {
      const disposition = await sendParsed(caller, target.row, input);
      const admission = admissionOf(input, target.key, disposition);
      rememberAdmission(key, { admission });
      return admission;
    })();
    rememberAdmission(key, { pending });
    try {
      return jsonResponse(200, { data: await pending });
    } catch (error) {
      // A refused delivery admitted nothing, so the same id must stay retryable.
      admissions.delete(key);
      throw error;
    }
  });
}

export async function handleSessionSynthetic(request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request);
    const target = await resolveTarget(caller, sessionID);

    const text = asString(body.text);
    if (text === undefined || text.trim().length === 0) {
      throw invalidRequest("synthetic input needs a non-empty text", "text");
    }
    const description = asTrimmed(body.description);
    const metadata = asRecord(body.metadata);
    const delivery = parseDelivery(body.delivery);
    if (delivery === undefined) {
      throw invalidRequest(`delivery must be "steer" or "queue" (found ${JSON.stringify(body.delivery)})`, "delivery");
    }
    const candidate = asTrimmed(body.id) ?? asTrimmed(metadata?.clientMessageId);
    const input: ParsedInput = {
      text,
      images: [],
      files: [],
      delivery,
      ...(candidate === undefined ? {} : { clientMessageId: candidate }),
      ...(metadata === undefined ? {} : { metadata }),
    };
    const disposition = await sendParsed(caller, target.row, input);
    const row: PublicInboxSynthetic = {
      id: candidate ?? `msg_${randomUUID()}`,
      sessionID: target.key,
      time: { created: new Date().toISOString() },
      type: "synthetic",
      payload: {
        text,
        ...(description === undefined ? {} : { description }),
        ...(metadata === undefined ? {} : { metadata }),
      },
      delivery,
      disposition,
      state: dispositionState(disposition),
    };
    return jsonResponse(200, { data: row });
  });
}

// A host that cannot answer the command surface leaves the command unverified, so it is passed through.
async function commandNames(caller: SessionWriteTransport): Promise<Set<string> | undefined> {
  try {
    const answer = await caller.raw.request<{ commands?: Array<{ name?: unknown }> }>({ type: "get_commands" });
    const listed = answer.commands;
    if (!Array.isArray(listed)) return undefined;
    const names = new Set<string>();
    for (const command of listed) {
      const name = asTrimmed(command?.name);
      if (name !== undefined) names.add(name);
    }
    return names;
  } catch {
    return undefined;
  }
}

export async function handleSessionCommand(request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const sessionID = sessionIdFromPath(url);
    const body = await readBody(request);
    const rawName = asTrimmed(body.name);
    if (rawName === undefined) throw invalidRequest("command needs a name", "name");
    const name = rawName.replace(/^[/$]+/, "");
    if (name.length === 0) throw invalidRequest("command needs a name", "name");

    const target = await resolveTarget(caller, sessionID);
    const known = await commandNames(caller);
    if (known !== undefined && !known.has(name) && !known.has(`skill:${name}`)) {
      throw new HandlerProblem(400, "CommandNotFoundError", `command not found: ${name}`, { command: name });
    }

    const args = asString(body.arguments) ?? asString(body.text) ?? "";
    const trimmedArgs = args.trim();
    const message = trimmedArgs.length === 0 ? `/${name}` : `/${name} ${trimmedArgs}`;
    const delivery = parseDelivery(body.delivery);
    if (delivery === undefined) {
      throw invalidRequest(`delivery must be "steer" or "queue" (found ${JSON.stringify(body.delivery)})`, "delivery");
    }
    const images: NonNullable<SenpiImages> = [];
    const files = body.files;
    if (Array.isArray(files)) {
      for (const entry of files) {
        const file = asRecord(entry);
        if (file === undefined) continue;
        const uri = asTrimmed(file.url) ?? asTrimmed(file.uri);
        if (uri === undefined) continue;
        const image = imageOfDataUri(uri, asTrimmed(file.mime) ?? asTrimmed(file.mimeType));
        if (image !== undefined) images.push(image);
      }
    }
    const input: ParsedInput = { text: message, images, files: [], delivery };
    await sendParsed(caller, target.row, input);
    return new Response(null, { status: 204 });
  });
}
