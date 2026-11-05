import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Route } from "../router";

// Content-addressed media store. A message read whose request opts into the experimental media-uri
// capability returns `media:<sha256>` refs instead of inline base64; this module owns the bytes those
// refs name. Blobs live at `<stateDir>/media/<sha256>` and their content type in a sibling
// `<sha256>.mime` file, so a stored hash is the only address and a read re-hashes the bytes before
// serving them.

export const MEDIA_CAPABILITY = "experimental-media-uri";
export const MEDIA_CAPABILITY_HEADER = "x-opencode-capabilities";
export const MEDIA_URI_PREFIX = "media:";
export const MEDIA_PATH = "/api/experimental/media/:hash";

const MEDIA_DIRNAME = "media";
const MIME_SUFFIX = ".mime";
const DEFAULT_STATE_DIR = "./state";
const DEFAULT_MIME = "application/octet-stream";
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const JSON_CONTENT_TYPE = "application/json";
const CACHE_CONTROL = "public, max-age=31536000, immutable";

let stateDirOverride: string | undefined;

/** Pins the store for tests; `undefined` restores the `OMO_BRIDGE_STATE_DIR` lookup. */
export function setMediaStateDir(dir: string | undefined): void {
  stateDirOverride = dir;
}

function mediaStateDir(): string {
  const configured = stateDirOverride ?? process.env.OMO_BRIDGE_STATE_DIR?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_STATE_DIR;
}

function mediaRoot(): string {
  return join(mediaStateDir(), MEDIA_DIRNAME);
}

export function isMediaHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

export function mediaHashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeAtomically(path: string, contents: Uint8Array | string): void {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

/** Stores bytes under their SHA-256 and returns the hash; an existing blob is left untouched. */
export function putMedia(bytes: Uint8Array, mimeType: string): string {
  const hash = mediaHashOf(bytes);
  const root = mediaRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const blobPath = join(root, hash);
  if (!existsSync(blobPath)) writeAtomically(blobPath, bytes);
  const mimePath = join(root, `${hash}${MIME_SUFFIX}`);
  if (!existsSync(mimePath)) writeAtomically(mimePath, mimeType);
  return hash;
}

/** Stores bytes and returns the ref a message read hands the client: `media:<sha256>`. */
export function mediaUriFor(bytes: Uint8Array, mimeType: string): string {
  return `${MEDIA_URI_PREFIX}${putMedia(bytes, mimeType)}`;
}

export type MediaLookup =
  | { status: "found"; bytes: Uint8Array; mime: string }
  | { status: "missing" }
  | { status: "corrupt" };

function recordedMime(hash: string): string {
  try {
    const mime = readFileSync(join(mediaRoot(), `${hash}${MIME_SUFFIX}`), "utf8").trim();
    return mime.length > 0 ? mime : DEFAULT_MIME;
  } catch (error) {
    if (isMissingFile(error)) return DEFAULT_MIME;
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Reads a blob and re-hashes it: a hash names its bytes, so a mismatch is not served as that hash. */
export function readMedia(hash: string): MediaLookup {
  if (!isMediaHash(hash)) return { status: "missing" };
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(join(mediaRoot(), hash));
  } catch (error) {
    if (isMissingFile(error)) return { status: "missing" };
    throw error;
  }
  if (mediaHashOf(bytes) !== hash) return { status: "corrupt" };
  return { status: "found", bytes, mime: recordedMime(hash) };
}

/** True when the request opts into `media:<sha256>` refs instead of inline file data. */
export function wantsMediaRefs(request: Request): boolean {
  const raw = request.headers.get(MEDIA_CAPABILITY_HEADER);
  if (raw === null) return false;
  return raw.split(",").some((value) => value.trim() === MEDIA_CAPABILITY);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE, ...headers },
  });
}

function invalidHash(hash: string): Response {
  return jsonResponse(400, {
    _tag: "InvalidRequestError",
    message: `media hash must be 64 lowercase hex characters (found ${JSON.stringify(hash)})`,
    field: "hash",
  });
}

function mediaNotFound(hash: string, message: string): Response {
  return jsonResponse(404, { _tag: "FileNotFoundError", message, hash });
}

function hashFromPath(url: URL): string | undefined {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  const raw = segments[segments.length - 1];
  if (raw === undefined) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * `GET /api/experimental/media/:hash`. A malformed hash is rejected before the filesystem is read;
 * an unknown or corrupted blob answers 404 `FileNotFoundError`.
 */
export function handleMediaGet(_request: Request, url: URL): Response {
  const hash = hashFromPath(url);
  if (hash === undefined || !isMediaHash(hash)) return invalidHash(hash ?? "");
  const blob = readMedia(hash);
  if (blob.status === "missing") return mediaNotFound(hash, `media not found: ${hash}`);
  if (blob.status === "corrupt") {
    return mediaNotFound(hash, `media blob does not match its hash: ${hash}`);
  }
  const body = blob.bytes.buffer.slice(blob.bytes.byteOffset, blob.bytes.byteOffset + blob.bytes.byteLength) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": blob.mime,
      "content-length": String(blob.bytes.byteLength),
      "cache-control": CACHE_CONTROL,
      etag: `"${hash}"`,
      "x-content-type-options": "nosniff",
    },
  });
}

/** Mounting contract for the route table; the http layer owns registration. */
export const mediaRoute: Route = {
  method: "GET",
  path: MEDIA_PATH,
  handler: (context) => handleMediaGet(context.request, context.url),
};
