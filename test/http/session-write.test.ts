import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventBus, type BridgeEvent } from "../../src/http/events";
import {
  handleSessionCompact,
  handleSessionEnvironment,
  handleSessionFork,
  handleSessionMove,
  handleSessionRemove,
  handleSessionRevertClear,
  handleSessionRevertCommit,
  handleSessionRevertStage,
  handleSessionUpdate,
  resetSessionManagementState,
  sessionManagementStore,
  setSessionManagementStore,
  setSessionManagementTransport,
  type SessionManagementTransport,
} from "../../src/http/handlers/session-write";
import { projectFor, SessionMap } from "../../src/model/session-map";
import type { SenpiSessionSummary } from "../../src/senpi/transport";

const SESSION_ID = "durable-1";
const ROUTING_ID = "rpc-1";
const CHILD_ID = "durable-child";

type SessionRow = SenpiSessionSummary;

function row(overrides: Partial<SessionRow> & { cwd: string }): SessionRow {
  return { sessionId: ROUTING_ID, status: "open", ...overrides } as SessionRow;
}

class FakeManagementTransport implements SessionManagementTransport {
  readonly sessionId = ROUTING_ID;
  rows: SessionRow[];
  readonly renamed: string[] = [];
  readonly compactions: Array<string | undefined> = [];
  readonly forks: Array<{ entryId: string; position: "before" | "at" | undefined }> = [];
  readonly unloads: Array<{ sessionId?: string; force?: boolean }> = [];
  readonly closes: Array<string | undefined> = [];
  forkCancelled = false;
  cloneCalls = 0;
  failRename: Error | undefined;

  constructor(rows: SessionRow[]) {
    this.rows = rows;
  }

  async listSessions(): Promise<SessionRow[]> {
    return this.rows;
  }

  async setSessionName(name: string): Promise<void> {
    if (this.failRename !== undefined) throw this.failRename;
    this.renamed.push(name);
    this.rows = this.rows.map((entry) => (entry.sessionId === this.sessionId ? { ...entry, name } : entry));
  }

  async compact(customInstructions?: string): Promise<unknown> {
    this.compactions.push(customInstructions);
    return undefined;
  }

  fork(entryId: string, options?: { position?: "before" | "at" }): Promise<{ cancelled: boolean; text: string }> {
    this.forks.push({ entryId, position: options?.position });
    return this.spawnFork(this.forkCancelled);
  }

  clone(): Promise<{ cancelled: boolean }> {
    this.cloneCalls += 1;
    return this.spawnFork(false);
  }

  async unloadSession(options: { sessionId?: string; force?: boolean }): Promise<unknown> {
    this.unloads.push({ ...options });
    return { outcome: "unloaded" };
  }

  async closeSession(sessionId?: string): Promise<void> {
    this.closes.push(sessionId);
  }

  private async spawnFork(cancelled: boolean): Promise<{ cancelled: boolean; text: string }> {
    if (!cancelled) {
      this.rows = [
        ...this.rows,
        row({
          sessionId: "rpc-child",
          durableSessionId: CHILD_ID,
          sessionPath: join(agentDir, "sessions", "child.jsonl"),
          cwd: workdir,
          name: "forked",
        }),
      ];
    }
    return { cancelled, text: "the original prompt" };
  }
}

let root: string;
let stateDir: string;
let agentDir: string;
let workdir: string;
let map: SessionMap;
let transport: FakeManagementTransport;

function url(path: string): URL {
  return new URL(`http://127.0.0.1:4319${path}`);
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:4319${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as Record<string, unknown>;
}

function withDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Subscribes before `action` runs, so a publish inside it can never be missed. */
async function captureEvent(
  type: string,
  action: () => Promise<Response>,
): Promise<{ response: Response; event: BridgeEvent }> {
  const subscription = eventBus.subscribe({ types: [type] });
  const reader = subscription.stream.getReader();
  try {
    const response = await action();
    const read = await withDeadline(reader.read(), `${type} event`);
    if (read.value === undefined) throw new Error(`no ${type} event was published`);
    return { response, event: read.value };
  } finally {
    void reader.cancel();
    subscription.close();
  }
}

function persisted(id: string): Record<string, unknown> | undefined {
  const state = JSON.parse(readFileSync(map.file, "utf8")) as {
    sessions: Array<Record<string, unknown>>;
  };
  return state.sessions.find((record) => record.key === id);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-write-"));
  stateDir = join(root, "state");
  agentDir = join(root, "agent");
  workdir = join(root, "work");
  map = SessionMap.open({ stateDir, agentDir, warn: () => undefined });
  const initial: SessionRow = row({
    durableSessionId: SESSION_ID,
    sessionPath: join(agentDir, "sessions", "alpha.jsonl"),
    cwd: workdir,
    name: "alpha",
  });
  map.upsert(initial);
  transport = new FakeManagementTransport([initial]);
  setSessionManagementStore(sessionManagementStore(map));
  setSessionManagementTransport(transport);
  resetSessionManagementState();
});

afterEach(() => {
  setSessionManagementTransport(undefined);
  setSessionManagementStore(undefined);
  resetSessionManagementState();
  rmSync(root, { recursive: true, force: true });
});

describe("PATCH /api/session/:sessionID", () => {
  test("rename calls setSessionName, publishes session.renamed and persists the title", async () => {
    const { response, event } = await captureEvent("session.renamed", () =>
      handleSessionUpdate(request("PATCH", `/api/session/${SESSION_ID}`, { title: "Renamed" }), url(`/api/session/${SESSION_ID}`)),
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(transport.renamed).toEqual(["Renamed"]);
    expect(event.type).toBe("session.renamed");
    expect(typeof event.id).toBe("string");
    expect(typeof event.created).toBe("number");
    expect(event.data).toEqual({ sessionID: SESSION_ID, title: "Renamed" });
    expect(map.get(SESSION_ID)?.name).toBe("Renamed");
    expect(persisted(SESSION_ID)?.name).toBe("Renamed");
  });

  test("rename re-attaches the target session when the transport holds another one", async () => {
    transport.rows = [
      ...transport.rows,
      row({ sessionId: "rpc-other", durableSessionId: "durable-other", sessionPath: join(agentDir, "other.jsonl"), cwd: workdir }),
    ];
    const opened: Array<Record<string, unknown>> = [];
    Object.assign(transport, {
      sessionId: "rpc-other",
      openSession: async (options: Record<string, unknown>) => {
        opened.push(options);
        return { sessionId: ROUTING_ID };
      },
    });

    const response = await handleSessionUpdate(
      request("PATCH", `/api/session/${SESSION_ID}`, { title: "Reattached" }),
      url(`/api/session/${SESSION_ID}`),
    );

    expect(response.status).toBe(204);
    expect(opened).toEqual([{ sessionPath: join(agentDir, "sessions", "alpha.jsonl"), retainOnDisconnect: true }]);
    expect(map.get(SESSION_ID)?.name).toBe("Reattached");
  });

  test("archive publishes session.archived and restore publishes session.unarchived", async () => {
    const archived = await captureEvent("session.archived", () =>
      handleSessionUpdate(request("PATCH", `/api/session/${SESSION_ID}`, { archived: true }), url(`/api/session/${SESSION_ID}`)),
    );
    expect(archived.response.status).toBe(204);
    expect(archived.event.data).toEqual({ sessionID: SESSION_ID });
    expect(map.get(SESSION_ID)?.archived).toBe(true);
    expect(persisted(SESSION_ID)?.archived).toBe(true);

    const repeated = await handleSessionUpdate(
      request("PATCH", `/api/session/${SESSION_ID}`, { archived: true }),
      url(`/api/session/${SESSION_ID}`),
    );
    expect(repeated.status).toBe(204);
    expect(map.get(SESSION_ID)?.archived).toBe(true);

    const restored = await captureEvent("session.unarchived", () =>
      handleSessionUpdate(request("PATCH", `/api/session/${SESSION_ID}`, { archived: false }), url(`/api/session/${SESSION_ID}`)),
    );
    expect(restored.response.status).toBe(204);
    expect(restored.event.data).toEqual({ sessionID: SESSION_ID });
    expect(map.get(SESSION_ID)?.archived).toBeUndefined();
  });

  test("metadata and permissions are stored bridge-side and published", async () => {
    const metadata = await captureEvent("session.metadata.updated", () =>
      handleSessionUpdate(
        request("PATCH", `/api/session/${SESSION_ID}`, { metadata: { owner: "bridge" } }),
        url(`/api/session/${SESSION_ID}`),
      ),
    );
    expect(metadata.response.status).toBe(204);
    expect(metadata.event.data).toEqual({ sessionID: SESSION_ID, metadata: { owner: "bridge" } });
    expect(map.get(SESSION_ID)?.metadata).toEqual({ owner: "bridge" });
    expect(persisted(SESSION_ID)?.metadata).toEqual({ owner: "bridge" });

    const permissions = [{ action: "read", resource: "src/**", effect: "allow" as const }];
    const published = await captureEvent("session.permissions", () =>
      handleSessionUpdate(
        request("PATCH", `/api/session/${SESSION_ID}`, { permissions }),
        url(`/api/session/${SESSION_ID}`),
      ),
    );
    expect(published.event.data).toEqual({ sessionID: SESSION_ID, permissions });
    expect(map.get(SESSION_ID)?.permissions).toEqual(permissions);
  });

  test("a malformed patch is refused before anything is written", async () => {
    const response = await handleSessionUpdate(
      request("PATCH", `/api/session/${SESSION_ID}`, { permissions: [{ action: "read" }] }),
      url(`/api/session/${SESSION_ID}`),
    );
    const body = await jsonBody(response);
    expect(response.status).toBe(400);
    expect(body._tag).toBe("InvalidRequestError");
    expect(map.get(SESSION_ID)?.permissions).toBeUndefined();
  });

  test("an unknown session answers 404 SessionNotFoundError", async () => {
    const response = await handleSessionUpdate(
      request("PATCH", "/api/session/nope", { archived: true }),
      url("/api/session/nope"),
    );
    const body = await jsonBody(response);
    expect(response.status).toBe(404);
    expect(body._tag).toBe("SessionNotFoundError");
    expect(body.sessionID).toBe("nope");
  });

  test("a transport that cannot rename answers 501 rather than a fake 204", async () => {
    setSessionManagementTransport({ listSessions: async () => transport.rows });
    const response = await handleSessionUpdate(
      request("PATCH", `/api/session/${SESSION_ID}`, { title: "Nope" }),
      url(`/api/session/${SESSION_ID}`),
    );
    const body = await jsonBody(response);
    expect(response.status).toBe(501);
    expect(body._tag).toBe("InvalidRequestError");
    expect(map.get(SESSION_ID)?.name).toBe("alpha");
  });
});

describe("DELETE /api/session/:sessionID", () => {
  test("unloads, removes the record, publishes session.deleted and 404s afterwards", async () => {
    const { response, event } = await captureEvent("session.deleted", () =>
      handleSessionRemove(request("DELETE", `/api/session/${SESSION_ID}`), url(`/api/session/${SESSION_ID}`)),
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(transport.unloads).toEqual([{ sessionId: ROUTING_ID, force: true }]);
    expect(map.has(SESSION_ID)).toBe(false);
    expect(persisted(SESSION_ID)).toBeUndefined();
    expect(event.data).toEqual({ sessionID: SESSION_ID });

    const again = await handleSessionUpdate(
      request("PATCH", `/api/session/${SESSION_ID}`, { archived: true }),
      url(`/api/session/${SESSION_ID}`),
    );
    const body = await jsonBody(again);
    expect(again.status).toBe(404);
    expect(body._tag).toBe("SessionNotFoundError");
    expect(map.has(SESSION_ID)).toBe(false);
  });

  test("delete of an unknown session answers 404", async () => {
    const response = await handleSessionRemove(request("DELETE", "/api/session/nope"), url("/api/session/nope"));
    expect(response.status).toBe(404);
    expect((await jsonBody(response))._tag).toBe("SessionNotFoundError");
  });
});

describe("POST /api/session/:sessionID/move", () => {
  test("updates the map cwd, persists it and publishes session.moved", async () => {
    const moved = join(root, "elsewhere");
    const { response, event } = await captureEvent("session.moved", () =>
      handleSessionMove(
        request("POST", `/api/session/${SESSION_ID}/move`, { location: { directory: moved } }),
        url(`/api/session/${SESSION_ID}/move`),
      ),
    );

    expect(response.status).toBe(204);
    expect(map.get(SESSION_ID)?.cwd).toBe(moved);
    expect(persisted(SESSION_ID)?.cwd).toBe(moved);
    expect(event.type).toBe("session.moved");
    expect(event.data).toEqual({
      sessionID: SESSION_ID,
      location: { directory: moved },
      projectID: projectFor(moved).id,
    });
  });

  test("a relative directory is refused", async () => {
    const response = await handleSessionMove(
      request("POST", `/api/session/${SESSION_ID}/move`, { location: { directory: "relative/dir" } }),
      url(`/api/session/${SESSION_ID}/move`),
    );
    expect(response.status).toBe(400);
    expect((await jsonBody(response))._tag).toBe("InvalidRequestError");
    expect(map.get(SESSION_ID)?.cwd).toBe(workdir);
  });
});

describe("POST /api/session/:sessionID/compact", () => {
  test("drives the transport and answers 204", async () => {
    const response = await handleSessionCompact(
      request("POST", `/api/session/${SESSION_ID}/compact`),
      url(`/api/session/${SESSION_ID}/compact`),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(transport.compactions).toHaveLength(1);
  });

  test("a transport without compact answers 501", async () => {
    setSessionManagementTransport({ listSessions: async () => transport.rows });
    const response = await handleSessionCompact(
      request("POST", `/api/session/${SESSION_ID}/compact`),
      url(`/api/session/${SESSION_ID}/compact`),
    );
    expect(response.status).toBe(501);
    expect((await jsonBody(response))._tag).toBe("InvalidRequestError");
  });
});

describe("POST /api/session/:sessionID/fork", () => {
  test("forks before a message and returns the new PublicSessionInfo", async () => {
    const response = await handleSessionFork(
      request("POST", `/api/session/${SESSION_ID}/fork`, { before: "entry-1" }),
      url(`/api/session/${SESSION_ID}/fork`),
    );
    const body = await jsonBody(response);
    expect(response.status).toBe(200);
    expect(transport.forks).toEqual([{ entryId: "entry-1", position: "before" }]);
    const data = body.data as Record<string, unknown>;
    expect(data.id).toBe(CHILD_ID);
    expect(data.location).toEqual({ directory: workdir });
    expect(map.get(CHILD_ID)?.name).toBe("forked");
  });

  test("a full-history fork uses clone", async () => {
    const response = await handleSessionFork(
      request("POST", `/api/session/${SESSION_ID}/fork`, {}),
      url(`/api/session/${SESSION_ID}/fork`),
    );
    expect(response.status).toBe(200);
    expect(transport.cloneCalls).toBe(1);
    expect(((await jsonBody(response)).data as Record<string, unknown>).id).toBe(CHILD_ID);
  });

  test("a cancelled fork answers 409 ConflictError", async () => {
    transport.forkCancelled = true;
    const response = await handleSessionFork(
      request("POST", `/api/session/${SESSION_ID}/fork`, { before: "entry-1" }),
      url(`/api/session/${SESSION_ID}/fork`),
    );
    const body = await jsonBody(response);
    expect(response.status).toBe(409);
    expect(body._tag).toBe("ConflictError");
  });

  test("a transport without fork answers 501", async () => {
    setSessionManagementTransport({ listSessions: async () => transport.rows });
    const response = await handleSessionFork(
      request("POST", `/api/session/${SESSION_ID}/fork`, { before: "entry-1" }),
      url(`/api/session/${SESSION_ID}/fork`),
    );
    const body = await jsonBody(response);
    expect(response.status).toBe(501);
    expect(body._tag).toBe("InvalidRequestError");
  });
});

describe("session revert", () => {
  test("stage, clear and commit report the declared InvalidRequestError when unsupported", async () => {
    const staged = await handleSessionRevertStage(
      request("POST", `/api/session/${SESSION_ID}/revert/stage`, { messageID: "entry-1" }),
      url(`/api/session/${SESSION_ID}/revert/stage`),
    );
    const stagedBody = await jsonBody(staged);
    expect(staged.status).toBe(400);
    expect(stagedBody._tag).toBe("InvalidRequestError");
    expect(stagedBody.kind).toBe("unsupported");

    const cleared = await handleSessionRevertClear(
      request("DELETE", `/api/session/${SESSION_ID}/revert`),
      url(`/api/session/${SESSION_ID}/revert`),
    );
    expect(cleared.status).toBe(400);
    expect((await jsonBody(cleared))._tag).toBe("InvalidRequestError");

    const committed = await handleSessionRevertCommit(
      request("POST", `/api/session/${SESSION_ID}/revert/commit`),
      url(`/api/session/${SESSION_ID}/revert/commit`),
    );
    expect(committed.status).toBe(400);
    expect((await jsonBody(committed))._tag).toBe("InvalidRequestError");
  });

  test("stage returns {data} when the transport can express it", async () => {
    Object.assign(transport, {
      revertStage: async (options: { messageID: string }) => ({
        data: { messageID: options.messageID, snapshot: "snap-1" },
      }),
    });
    const response = await handleSessionRevertStage(
      request("POST", `/api/session/${SESSION_ID}/revert/stage`, { messageID: "entry-1" }),
      url(`/api/session/${SESSION_ID}/revert/stage`),
    );
    expect(response.status).toBe(200);
    expect((await jsonBody(response)).data).toEqual({ messageID: "entry-1", snapshot: "snap-1" });
  });
});

describe("PUT /api/session/:sessionID/environment", () => {
  test("stores the variables in the session map metadata", async () => {
    const response = await handleSessionEnvironment(
      request("PUT", `/api/session/${SESSION_ID}/environment`, { variables: { FOO: "bar", PATH: "/usr/bin" } }),
      url(`/api/session/${SESSION_ID}/environment`),
    );
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(map.get(SESSION_ID)?.metadata).toEqual({ environment: { FOO: "bar", PATH: "/usr/bin" } });
    expect(persisted(SESSION_ID)?.metadata).toEqual({ environment: { FOO: "bar", PATH: "/usr/bin" } });
  });

  test("rejects a non-string value and a non-shell name", async () => {
    const notString = await handleSessionEnvironment(
      request("PUT", `/api/session/${SESSION_ID}/environment`, { variables: { FOO: 1 } }),
      url(`/api/session/${SESSION_ID}/environment`),
    );
    expect(notString.status).toBe(400);

    const notShell = await handleSessionEnvironment(
      request("PUT", `/api/session/${SESSION_ID}/environment`, { variables: { "BAD-NAME": "x" } }),
      url(`/api/session/${SESSION_ID}/environment`),
    );
    expect(notShell.status).toBe(400);
    expect(map.get(SESSION_ID)?.metadata).toBeUndefined();
  });
});
