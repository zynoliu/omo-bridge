import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEDIA_CAPABILITY,
  MEDIA_CAPABILITY_HEADER,
  mediaRoute,
  putMedia,
  readMedia,
  setMediaStateDir,
} from "../../src/http/handlers/media";
import {
  handleSessionInboxList,
  setSessionInboxTransport,
  type SessionInboxTransport,
} from "../../src/http/handlers/inbox";
import {
  handleSessionMessageGet,
  handleSessionMessages,
  setSessionReadTransport,
  type SessionReadTransport,
} from "../../src/http/handlers/sessions";
import { createRouter } from "../../src/http/router";
import type {
  SenpiAbortAnswer,
  SenpiEntriesResult,
  SenpiMessages,
  SenpiOpenSessionResult,
  SenpiSessionState,
  SenpiSessionSummary,
} from "../../src/senpi/transport";

const SESSION_ID = "durable-media-1";
const ROUTING_ID = "rpc-media-1";
const MESSAGE_ID = "entry-user-1";
const MIME = "image/png";
const RAW_IMAGE = Buffer.from("content-addressed-media-fixture", "utf8");
const BASE64_IMAGE = RAW_IMAGE.toString("base64");
const IMAGE_HASH = createHash("sha256").update(RAW_IMAGE).digest("hex");

class FakeTransport implements SessionReadTransport {
  readonly sessionId = ROUTING_ID;

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [
      { sessionId: ROUTING_ID, durableSessionId: SESSION_ID, cwd: "/work/project", status: "open" },
    ] as SenpiSessionSummary[];
  }

  async getState(): Promise<SenpiSessionState> {
    return { sessionId: ROUTING_ID, isStreaming: false } as SenpiSessionState;
  }

  async getEntries(): Promise<SenpiEntriesResult> {
    return { entries: entries(), leafId: null } as SenpiEntriesResult;
  }

  async getMessages(): Promise<SenpiMessages> {
    return [];
  }

  async openSession(): Promise<SenpiOpenSessionResult> {
    return { sessionId: ROUTING_ID } as SenpiOpenSessionResult;
  }
}

function entries(): SenpiEntriesResult["entries"] {
  return [
    {
      type: "message",
      id: MESSAGE_ID,
      parentId: null,
      timestamp: "2026-11-05T00:00:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: BASE64_IMAGE, mimeType: MIME },
        ],
        timestamp: Date.parse("2026-11-05T00:00:00.000Z"),
      },
    },
  ] as unknown as SenpiEntriesResult["entries"];
}

function handlerUrl(path: string): URL {
  return new URL(`http://bridge.test${path}`);
}

function request(path: string, capabilities?: string): Request {
  const headers = new Headers();
  if (capabilities !== undefined) headers.set(MEDIA_CAPABILITY_HEADER, capabilities);
  return new Request(handlerUrl(path), { headers });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function messageFiles(capabilities?: string): Promise<Array<Record<string, unknown>>> {
  const path = `/api/session/${SESSION_ID}/message`;
  const response = await handleSessionMessages(request(path, capabilities), handlerUrl(path));
  expect(response.status).toBe(200);
  const data = (await bodyOf(response)).data as Array<Record<string, unknown>>;
  const user = data.find((message) => message.type === "user");
  expect(user).toBeDefined();
  return (user?.files ?? []) as Array<Record<string, unknown>>;
}

let server: ReturnType<typeof Bun.serve>;
let mediaBase: string;
let stateRoot: string;

beforeAll(() => {
  const transport = new FakeTransport();
  setSessionReadTransport(transport);
  const inboxSeam: SessionInboxTransport = {
    sessionId: transport.sessionId,
    listSessions: () => transport.listSessions(),
    getState: () => transport.getState(),
    abort: async () => undefined as SenpiAbortAnswer,
    openSession: async () => ({ sessionId: transport.sessionId }) as SenpiOpenSessionResult,
    raw: { request: async <T>() => ({}) as T },
  };
  setSessionInboxTransport(inboxSeam);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createRouter([mediaRoute]),
  });
  mediaBase = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  setSessionReadTransport(undefined);
  setSessionInboxTransport(undefined);
});

afterEach(() => {
  setMediaStateDir(undefined);
  if (stateRoot !== undefined) rmSync(stateRoot, { recursive: true, force: true });
});

function freshStateDir(): string {
  stateRoot = mkdtempSync(join(tmpdir(), "bridge-media-"));
  setMediaStateDir(stateRoot);
  return stateRoot;
}

function fetchMedia(hash: string): Promise<Response> {
  return fetch(`${mediaBase}/api/experimental/media/${hash}`);
}

describe("content-addressed media store", () => {
  test("serves stored bytes under their sha256 with the recorded content type", async () => {
    freshStateDir();
    const hash = putMedia(RAW_IMAGE, MIME);
    expect(hash).toBe(IMAGE_HASH);

    const response = await fetchMedia(hash);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(MIME);
    expect(response.headers.get("etag")).toBe(`"${hash}"`);
    expect(response.headers.get("cache-control")).toContain("immutable");
    const served = Buffer.from(await response.arrayBuffer());
    expect(served.equals(RAW_IMAGE)).toBe(true);
    expect(createHash("sha256").update(served).digest("hex")).toBe(hash);
  });

  test("stores the same bytes once and keeps the first recorded content type", () => {
    const root = freshStateDir();
    const first = putMedia(RAW_IMAGE, MIME);
    const second = putMedia(RAW_IMAGE, "application/octet-stream");
    expect(second).toBe(first);
    expect(readMedia(first)).toEqual({ status: "found", bytes: RAW_IMAGE, mime: MIME });
    expect(existsSync(join(root, "media", `${first}.mime`))).toBe(true);
  });

  test("unknown hash answers 404 FileNotFoundError", async () => {
    freshStateDir();
    putMedia(RAW_IMAGE, MIME);
    const response = await fetchMedia("0".repeat(64));
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toMatchObject({ _tag: "FileNotFoundError" });
  });

  test("malformed hash answers 400 InvalidRequestError without touching the filesystem", async () => {
    const root = freshStateDir();
    const absent = join(root, "never-created");
    setMediaStateDir(absent);

    const malformed = ["abc", "A".repeat(64), "z".repeat(64), "0".repeat(63), "0".repeat(65)];
    for (const hash of malformed) {
      const response = await fetchMedia(hash);
      expect(response.status).toBe(400);
      expect(await bodyOf(response)).toMatchObject({ _tag: "InvalidRequestError", field: "hash" });
    }
    expect(existsSync(absent)).toBe(false);
  });

  test("a blob whose bytes no longer match its hash is not served", async () => {
    const root = freshStateDir();
    const hash = putMedia(RAW_IMAGE, MIME);
    writeFileSync(join(root, "media", hash), "tampered");

    const response = await fetchMedia(hash);
    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toMatchObject({ _tag: "FileNotFoundError" });
    expect(readMedia(hash)).toEqual({ status: "corrupt" });
  });
});

describe("media-uri capability negotiation on message reads", () => {
  test("with the capability, image data becomes a media ref and the bytes are fetchable", async () => {
    freshStateDir();
    const files = await messageFiles(MEDIA_CAPABILITY);
    expect(files).toHaveLength(1);
    const file = files[0]!;
    expect(file.uri).toBe(`media:${IMAGE_HASH}`);
    expect(file.data).toBeUndefined();
    expect(file.mime).toBe(MIME);
    expect(file.bytes).toBe(RAW_IMAGE.byteLength);
    expect(file.source).toEqual({ type: "inline" });

    const response = await fetchMedia(IMAGE_HASH);
    expect(response.status).toBe(200);
    const served = Buffer.from(await response.arrayBuffer());
    expect(createHash("sha256").update(served).digest("hex")).toBe(IMAGE_HASH);
  });

  test("the capability is read from a comma-separated header list", async () => {
    freshStateDir();
    const files = await messageFiles(`interactive_user, ${MEDIA_CAPABILITY}`);
    expect(files[0]?.uri).toBe(`media:${IMAGE_HASH}`);
  });

  test("without the capability, image data stays inline and nothing is stored", async () => {
    const root = freshStateDir();
    const files = await messageFiles();
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({ data: BASE64_IMAGE, mime: MIME, source: { type: "inline" } });
    expect(files[0]?.uri).toBeUndefined();
    expect(existsSync(join(root, "media"))).toBe(false);
  });

  test("session.message.get negotiates the same way", async () => {
    freshStateDir();
    const path = `/api/session/${SESSION_ID}/message/${MESSAGE_ID}`;
    const withCapability = await handleSessionMessageGet(request(path, MEDIA_CAPABILITY), handlerUrl(path));
    expect(withCapability.status).toBe(200);
    const refMessage = (await bodyOf(withCapability)).data as Record<string, unknown>;
    expect((refMessage.files as Array<Record<string, unknown>>)[0]?.uri).toBe(`media:${IMAGE_HASH}`);

    const inline = await handleSessionMessageGet(request(path), handlerUrl(path));
    const inlineMessage = (await bodyOf(inline)).data as Record<string, unknown>;
    expect((inlineMessage.files as Array<Record<string, unknown>>)[0]?.data).toBe(BASE64_IMAGE);
  });

  test("inbox.list accepts the capability header", async () => {
    freshStateDir();
    const path = `/api/session/${SESSION_ID}/inbox`;
    const response = await handleSessionInboxList(request(path, MEDIA_CAPABILITY), handlerUrl(path));
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ data: [] });
  });
});
