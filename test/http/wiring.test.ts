import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config";
import { validateResponse } from "../../src/contract/validate";
import { setSessionReadTransport, type SessionReadTransport } from "../../src/http/handlers/sessions";
import { BASIC_USERNAME, createServer, type BridgeServer } from "../../src/http/server";
import type {
  SenpiEntriesResult,
  SenpiMessages,
  SenpiOpenSessionResult,
  SenpiSessionState,
  SenpiSessionSummary,
} from "../../src/senpi/transport";

const PASSWORD = "wiring-password";
const SESSION_ID = "durable-wiring-1";

// Necessary: the handlers read a module-level transport, so the fake substitutes for the RpcClient
// at the only seam the http layer exposes (setSessionReadTransport).
class FakeSenpiTransport implements SessionReadTransport {
  readonly sessionId = "rpc-wiring-1";
  readonly streaming = false;
  readonly rows: SenpiSessionSummary[];
  readonly state: SenpiSessionState;
  readonly entries: SenpiEntriesResult["entries"] = [];
  readonly messages: SenpiMessages = [];

  constructor(options: { rows: SenpiSessionSummary[]; state: SenpiSessionState }) {
    this.rows = options.rows;
    this.state = options.state;
  }

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return this.rows;
  }

  async getState(): Promise<SenpiSessionState> {
    return this.state;
  }

  async getEntries(): Promise<SenpiEntriesResult> {
    return { entries: this.entries, leafId: null };
  }

  async getMessages(): Promise<SenpiMessages> {
    return this.messages;
  }

  async openSession(): Promise<SenpiOpenSessionResult> {
    return { sessionId: this.sessionId } as SenpiOpenSessionResult;
  }
}

let server!: BridgeServer;
let base: string;
let workdir: string;
let transport: FakeSenpiTransport;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "omo-bridge-wiring-"));
  writeFileSync(join(workdir, "alpha.txt"), "alpha\n");
  transport = new FakeSenpiTransport({
    rows: [
      {
        sessionId: "rpc-wiring-1",
        durableSessionId: SESSION_ID,
        cwd: workdir,
        name: "Wiring session",
        status: "open",
      },
    ],
    state: { sessionId: "rpc-wiring-1", isStreaming: false } as SenpiSessionState,
  });
  setSessionReadTransport(transport);
  server = createServer(resolveConfig({ OMO_BRIDGE_PORT: "0", OMO_BRIDGE_PASSWORD: PASSWORD }));
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  setSessionReadTransport(undefined);
  rmSync(workdir, { recursive: true, force: true });
});

function auth(): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}`,
  };
}

function get(path: string, headers: Record<string, string> = auth()): Promise<Response> {
  return fetch(`${base}${path}`, { headers });
}

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as Record<string, unknown>;
}

describe("mounted fs/location handlers", () => {
  test("GET /api/fs/list lists a real directory with location and data", async () => {
    const response = await get(`/api/fs/list?location%5Bdirectory%5D=${encodeURIComponent(workdir)}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    const location = body.location as Record<string, unknown>;
    expect(location).toEqual({ directory: workdir });
    const data = body.data as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.map((entry) => entry.path)).toContain("alpha.txt");
    expect(validateResponse("fs.list", body)).toEqual({ ok: true });
  });

  test("GET /api/vcs answers a valid empty branch for a directory outside a repository", async () => {
    const response = await get(`/api/vcs?location%5Bdirectory%5D=${encodeURIComponent(workdir)}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.location).toBeDefined();
    expect(body.data).toEqual({ branch: {} });
  });

  test("GET /api/fs/list without credentials is rejected before routing", async () => {
    const response = await fetch(`${base}/api/fs/list`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Basic realm="opencode"');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body._tag).toBe("UnauthorizedError");
  });
});

describe("mounted session handlers", () => {
  test("GET /api/session returns the mapped session list with a cursor", async () => {
    const response = await get("/api/session");
    expect(response.status).toBe(200);
    const body = await json(response);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.map((session) => session.id)).toEqual([SESSION_ID]);
    expect(data[0]!.location).toEqual({ directory: workdir });
    expect("cursor" in body).toBe(true);
  });

  test("GET /api/session/active is not swallowed by the :sessionID route", async () => {
    const response = await get("/api/session/active");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.data).toEqual({});
  });

  test("GET /api/session/:sessionID returns one session", async () => {
    const response = await get(`/api/session/${SESSION_ID}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect((body.data as Record<string, unknown>).id).toBe(SESSION_ID);
  });

  test("GET /api/session/nope returns a 404 SessionNotFoundError", async () => {
    const response = await get("/api/session/nope");
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body._tag).toBe("SessionNotFoundError");
    expect(body.sessionID).toBe("nope");
  });

  test("POST /api/session/:sessionID/view records the idle timestamp", async () => {
    const response = await post(`/api/session/${SESSION_ID}/view`, { idle: 42 });
    expect(response.status).toBe(204);
  });
});
