import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config";
import { validateResponse } from "../../src/contract/validate";
import { createEventBus, type BridgeEvent, type EventBus, type EventSubscription } from "../../src/http/events";
import { setCatalogTransport } from "../../src/http/handlers/catalogs";
import {
  resetSessionInboxState,
  setSessionInboxTransport,
  type InboxCommand,
  type InboxCommandChannel,
  type QueueEntry,
  type SessionInboxTransport,
} from "../../src/http/handlers/inbox";
import { resetForms, setFormEventBus, setFormTransport } from "../../src/http/handlers/form";
import { putMedia, setMediaStateDir } from "../../src/http/handlers/media";
import { resetPermissions, setPermissionEventBus, setPermissionTransport } from "../../src/http/handlers/permission";
import { sessionManagementStore, setSessionManagementStore, setSessionManagementTransport } from "../../src/http/handlers/session-write";
import { setSessionReadTransport } from "../../src/http/handlers/sessions";
import { resetShells, setShellEventBus, setShellTransport } from "../../src/http/handlers/shell";
import { BASIC_USERNAME, createServer, type BridgeServer } from "../../src/http/server";
import { SessionMap } from "../../src/model/session-map";
import { createFrameDispatch } from "../../src/runtime";
import type {
  SenpiAbortAnswer,
  SenpiAbortOptions,
  SenpiEntriesResult,
  SenpiMessages,
  SenpiModelInfo,
  SenpiOpenSessionResult,
  SenpiSessionState,
  SenpiSessionSummary,
  SenpiSelectedModel,
} from "../../src/senpi/transport";

const PASSWORD = "mount-password";
const SESSION_ID = "ses_mount_1";
const SESSION_FORK = "ses_mount_fork";
const SESSION_DELETE = "ses_mount_delete";
const ROUTING_ID = "rpc-mount-1";

const MODEL: SenpiModelInfo = { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000, reasoning: true };

class FakeSenpi {
  readonly sessionId = ROUTING_ID;
  readonly streaming = false;
  readonly responses: Array<Record<string, unknown>> = [];
  readonly selectedModels: Array<{ provider: string; id: string }> = [];
  rows: SenpiSessionSummary[];
  readonly state: SenpiSessionState;

  constructor(rows: SenpiSessionSummary[], workdir: string) {
    this.rows = rows;
    this.state = { sessionId: ROUTING_ID, isStreaming: false } as SenpiSessionState;
    this.workdir = workdir;
  }

  private readonly workdir: string;

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [...this.rows];
  }

  async getState(): Promise<SenpiSessionState> {
    return this.state;
  }

  async getEntries(): Promise<SenpiEntriesResult> {
    return { entries: [], leafId: null };
  }

  async getMessages(): Promise<SenpiMessages> {
    return [];
  }

  async sendExtensionUIResponse(response: unknown): Promise<void> {
    this.responses.push(response as Record<string, unknown>);
  }

  async setSessionName(name: string): Promise<void> {
    this.responses.push({ type: "set_session_name", name });
  }

  async openSession(): Promise<SenpiOpenSessionResult> {
    return { sessionId: ROUTING_ID } as SenpiOpenSessionResult;
  }

  async unloadSession(options: unknown): Promise<void> {
    this.responses.push({ type: "unload_session", options });
  }

  async closeSession(): Promise<void> {
    this.responses.push({ type: "close_session" });
  }

  async compact(): Promise<unknown> {
    return { compacted: true };
  }

  async fork(entryId: string): Promise<{ cancelled?: boolean; text?: string }> {
    this.responses.push({ type: "fork", entryId });
    return { cancelled: false };
  }

  async clone(): Promise<{ cancelled?: boolean }> {
    this.rows = [
      ...this.rows,
      {
        sessionId: "rpc-mount-cloned",
        durableSessionId: "ses_mount_cloned",
        cwd: this.workdir,
        name: "Cloned",
        status: "open",
        sessionPath: join(this.workdir, "cloned.jsonl"),
      },
    ];
    return { cancelled: false };
  }

  async revertStage(options: { messageID: string; files?: boolean }): Promise<{ data: Record<string, unknown> }> {
    return { data: { messageID: options.messageID, staged: true } };
  }

  async revertClear(): Promise<void> {
    this.responses.push({ type: "revert_clear" });
  }

  async revertCommit(): Promise<void> {
    this.responses.push({ type: "revert_commit" });
  }

  async getAvailableModels(): Promise<SenpiModelInfo[]> {
    return [MODEL];
  }

  async setModel(provider: string, id: string): Promise<SenpiSelectedModel> {
    this.selectedModels.push({ provider, id });
    return { provider, id } as SenpiSelectedModel;
  }

  async getCommands(): Promise<readonly { name: string; description?: string }[]> {
    return [];
  }
}

let server!: BridgeServer;
let base!: string;
let root!: string;
let workdir!: string;
let fake!: FakeSenpi;
let inbox!: FakeInbox;

/**
 * The inbox family reads its own transport seam. This fake keeps its queue and abort log separate
 * from FakeSenpi so the mounted routes can be exercised without changing the read projections.
 */
class FakeInbox implements SessionInboxTransport {
  readonly sessionId = ROUTING_ID;
  ordered: QueueEntry[] = [];
  pending: unknown[] = [];
  readonly aborts: Array<SenpiAbortOptions | undefined> = [];
  readonly commands: InboxCommand[] = [];
  readonly raw: InboxCommandChannel = {
    request: async <T>(command: InboxCommand): Promise<T> => {
      this.commands.push(structuredClone(command));
      return { status: "removed" } as T;
    },
  };

  async abort(options?: SenpiAbortOptions): Promise<SenpiAbortAnswer> {
    this.aborts.push(options);
    return undefined as SenpiAbortAnswer;
  }

  async getState(): Promise<SenpiSessionState> {
    return {
      sessionId: ROUTING_ID,
      isStreaming: false,
      ordered: this.ordered,
    } as unknown as SenpiSessionState;
  }

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [
      {
        sessionId: ROUTING_ID,
        durableSessionId: SESSION_ID,
        cwd: workdir,
        status: "open",
        sessionPath: join(workdir, "mount.jsonl"),
      } as SenpiSessionSummary,
    ];
  }

  async openSession(): Promise<SenpiOpenSessionResult> {
    return { sessionId: ROUTING_ID } as SenpiOpenSessionResult;
  }

  async getPendingInputs(): Promise<unknown> {
    return { inputs: this.pending };
  }
}

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: auth() });
}

function send(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...auth(), "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as Record<string, unknown>;
}

function assertNotRouter404(response: Response, body: Record<string, unknown>): void {
  expect(`${response.status} ${String(body._tag)}`).not.toBe("404 NotFoundError");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-mount-"));
  workdir = join(root, "work");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "note.txt"), "mount\n");

  const map = SessionMap.open({ stateDir: join(root, "state"), agentDir: join(root, "agent") });
  const rows: SenpiSessionSummary[] = [
    {
      sessionId: ROUTING_ID,
      durableSessionId: SESSION_ID,
      cwd: workdir,
      name: "Mount session",
      status: "open",
      sessionPath: join(workdir, "mount.jsonl"),
    },
    {
      sessionId: "rpc-mount-fork",
      durableSessionId: SESSION_FORK,
      cwd: workdir,
      name: "Fork session",
      status: "open",
      sessionPath: join(workdir, "fork.jsonl"),
    },
    {
      sessionId: "rpc-mount-delete",
      durableSessionId: SESSION_DELETE,
      cwd: workdir,
      name: "Delete session",
      status: "open",
      sessionPath: join(workdir, "delete.jsonl"),
    },
  ];
  for (const row of rows) map.upsert(row);
  map.flush();

  fake = new FakeSenpi(rows, workdir);
  inbox = new FakeInbox();
  resetSessionInboxState();
  setSessionInboxTransport(inbox);
  setSessionReadTransport(fake);
  setSessionManagementTransport(fake);
  setSessionManagementStore(sessionManagementStore(map));
  setPermissionTransport(fake);
  setPermissionEventBus(undefined);
  setFormTransport(fake);
  setFormEventBus(undefined);
  setCatalogTransport(fake);
  setShellTransport({
    bash: async (command: string) => ({ output: `${command}\nmount-output\n`, exitCode: 0 }),
  });
  setShellEventBus(undefined);
  setMediaStateDir(join(root, "media"));

  server = createServer(
    resolveConfig({ OMO_BRIDGE_PORT: "0", OMO_BRIDGE_PASSWORD: PASSWORD, OMO_BRIDGE_STATE_DIR: join(root, "state") }),
  );
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  setSessionInboxTransport(undefined);
  resetSessionInboxState();
  setSessionReadTransport(undefined);
  setSessionManagementTransport(undefined);
  setSessionManagementStore(undefined);
  setPermissionTransport(undefined);
  setPermissionEventBus(undefined);
  setFormTransport(undefined);
  setFormEventBus(undefined);
  setCatalogTransport(undefined);
  setShellTransport(undefined);
  setShellEventBus(undefined);
  setMediaStateDir(undefined);
  resetPermissions();
  resetForms();
  resetShells();
  rmSync(root, { recursive: true, force: true });
});

describe("mounted permission routes", () => {
  test("create, list and reply over real HTTP", async () => {
    const created = await send("POST", `/api/session/${SESSION_ID}/permission`, {
      action: "read",
      resources: ["/tmp/mount/a.txt"],
      save: ["/tmp/mount/*"],
    });
    expect(created.status).toBe(200);
    const createdBody = await json(created);
    const requestID = (createdBody.data as Record<string, unknown>).id;
    expect(typeof requestID).toBe("string");

    const listed = await get(`/api/session/${SESSION_ID}/permission`);
    expect(listed.status).toBe(200);
    const listedBody = await json(listed);
    expect((listedBody.data as Array<Record<string, unknown>>).map((row) => row.id)).toContain(requestID);

    const replied = await send("POST", `/api/session/${SESSION_ID}/permission/${requestID as string}/reply`, {
      decision: "once",
    });
    expect(replied.status).toBe(204);
  });

  test("replying to an unknown request answers the handler's 404, not the router's", async () => {
    const response = await send("POST", `/api/session/${SESSION_ID}/permission/req_missing/reply`, {
      decision: "once",
    });
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body._tag).toBe("PermissionNotFoundError");
    assertNotRouter404(response, body);
  });
});

describe("mounted form routes", () => {
  test("create, list, reply and cancel over real HTTP", async () => {
    const created = await send("POST", `/api/session/${SESSION_ID}/form`, {
      title: "Mount form",
      fields: [{ key: "name", type: "string", title: "Name", required: true }],
    });
    expect(created.status).toBe(200);
    const formID = ((await json(created)).data as Record<string, unknown>).id;
    expect(typeof formID).toBe("string");

    const sessionList = await get(`/api/session/${SESSION_ID}/form`);
    expect(sessionList.status).toBe(200);
    const sessionBody = await json(sessionList);
    expect((sessionBody.data as Array<Record<string, unknown>>).map((row) => row.id)).toContain(formID);

    const globalList = await get(`/api/form?location%5Bdirectory%5D=${encodeURIComponent(workdir)}`);
    expect(globalList.status).toBe(200);
    const globalBody = await json(globalList);
    expect((globalBody.data as Array<Record<string, unknown>>).map((row) => row.id)).toContain(formID);

    const replied = await send("POST", `/api/session/${SESSION_ID}/form/${formID as string}/reply`, {
      answer: { name: "mount" },
    });
    expect(replied.status).toBe(204);

    const second = await send("POST", `/api/session/${SESSION_ID}/form`, {
      title: "Cancel me",
      fields: [{ key: "ok", type: "boolean" }],
    });
    const secondID = ((await json(second)).data as Record<string, unknown>).id;
    const cancelled = await send("DELETE", `/api/session/${SESSION_ID}/form/${secondID as string}`);
    expect(cancelled.status).toBe(204);
  });
});

describe("mounted session inbox routes", () => {
  test("interrupt, background, list, cancel and delivery update answer over HTTP", async () => {
    inbox.pending = [{ id: "msg_mount_pending", text: "queued over HTTP", delivery: "steer" }];
    inbox.ordered = [
      { queuedId: "q_mount_1", text: "move me", mode: "followUp", enqueueOrder: 1, revision: 1 },
    ];

    const interrupted = await send("POST", `/api/session/${SESSION_ID}/interrupt`, {});
    expect(interrupted.status).toBe(200);
    expect(await json(interrupted)).toEqual({ interrupted: true });
    expect(inbox.aborts).toEqual([{ intent: "stop" }]);

    const background = await send("POST", `/api/session/${SESSION_ID}/background`);
    expect(background.status).toBe(204);

    const listed = await get(`/api/session/${SESSION_ID}/inbox`);
    expect(listed.status).toBe(200);
    const items = (await json(listed)).data as Array<Record<string, unknown>>;
    expect(items.map((item) => [item.id, item.text, item.delivery])).toEqual([
      ["msg_mount_pending", "queued over HTTP", "steer"],
    ]);

    const cancelled = await send("DELETE", `/api/session/${SESSION_ID}/inbox/q_mount_1`);
    expect(cancelled.status).toBe(204);
    expect(inbox.commands).toEqual([{ type: "dequeue_message", queuedId: "q_mount_1" }]);

    inbox.ordered = [
      { queuedId: "q_mount_2", text: "move me too", mode: "followUp", enqueueOrder: 2, revision: 1 },
    ];
    const updated = await send("PATCH", `/api/session/${SESSION_ID}/inbox/q_mount_2`, { delivery: "steer" });
    expect(updated.status).toBe(204);
    expect(inbox.commands.at(-1)).toEqual({ type: "steer", message: "move me too", enqueueOrder: 2 });
  });
});

describe("mounted session management routes", () => {
  test("PATCH renames and DELETE removes", async () => {
    const renamed = await send("PATCH", `/api/session/${SESSION_ID}`, { title: "Renamed over HTTP" });
    expect(renamed.status).toBe(204);

    const removed = await send("DELETE", `/api/session/${SESSION_DELETE}`);
    expect(removed.status).toBe(204);

    const gone = await send("PATCH", `/api/session/${SESSION_DELETE}`, { title: "After delete" });
    expect(gone.status).toBe(404);
    expect((await json(gone))._tag).toBe("SessionNotFoundError");
  });

  test("fork, move, compact, revert and environment answer their declared statuses", async () => {
    const forked = await send("POST", `/api/session/${SESSION_FORK}/fork`, {});
    expect(forked.status).toBe(200);
    expect(typeof ((await json(forked)).data as Record<string, unknown>).id).toBe("string");

    const moved = await send("POST", `/api/session/${SESSION_ID}/move`, {
      location: { directory: workdir },
      delivery: "steer",
    });
    expect(moved.status).toBe(204);

    const compacted = await send("POST", `/api/session/${SESSION_ID}/compact`, {});
    expect(compacted.status).toBe(200);
    const compaction = (await json(compacted)).data as Record<string, unknown>;
    expect(compaction.type).toBe("compaction");
    expect(compaction.sessionID).toBe(SESSION_ID);
    expect(typeof compaction.id).toBe("string");

    const staged = await send("POST", `/api/session/${SESSION_ID}/revert/stage`, { messageID: "msg_1" });
    expect(staged.status).toBe(200);
    expect((await json(staged)).data).toEqual({ messageID: "msg_1", staged: true });

    const cleared = await send("DELETE", `/api/session/${SESSION_ID}/revert`);
    expect(cleared.status).toBe(204);

    const committed = await send("POST", `/api/session/${SESSION_ID}/revert/commit`);
    expect(committed.status).toBe(204);

    const environment = await send("PUT", `/api/session/${SESSION_ID}/environment`, {
      variables: { MOUNT_FLAG: "1" },
    });
    expect(environment.status).toBe(204);
  });

  test("GET /api/session/active still wins over the :sessionID pattern", async () => {
    const response = await get("/api/session/active");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.data).toBeDefined();
  });
});

describe("mounted shell routes", () => {
  test("session.shell records a command that list, get, output and remove serve", async () => {
    const location = `location%5Bdirectory%5D=${encodeURIComponent(workdir)}`;
    const ran = await send("POST", `/api/session/${SESSION_ID}/shell?${location}`, { command: "echo mount" });
    expect(ran.status).toBe(204);

    const listed = await get(`/api/shell?${location}`);
    expect(listed.status).toBe(200);
    const rows = (await json(listed)).data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const shellID = rows[0]!.id as string;

    const one = await get(`/api/shell/${shellID}?${location}`);
    expect(one.status).toBe(200);

    const output = await get(`/api/shell/${shellID}/output?${location}`);
    expect(output.status).toBe(200);
    const outputBody = await json(output);
    expect(String((outputBody.data as Record<string, unknown>).output)).toContain("mount");

    const removed = await send("DELETE", `/api/shell/${shellID}?${location}`);
    expect(removed.status).toBe(204);
  });
});

describe("mounted catalog routes", () => {
  test("the model catalog, empty families and switches answer over HTTP", async () => {
    const location = `location%5Bdirectory%5D=${encodeURIComponent(workdir)}`;
    const model = await get(`/api/model?${location}`);
    expect(model.status).toBe(200);
    const modelBody = await json(model);
    expect((modelBody.data as Array<Record<string, unknown>>).map((row) => row.modelID)).toEqual(["claude-sonnet-4"]);

    for (const path of [
      "/api/provider",
      "/api/agent",
      "/api/command",
      "/api/skill",
      "/api/reference",
      "/api/mcp",
      "/api/mcp/resource",
      "/api/integration",
      "/api/websearch/provider",
      "/api/permission/saved",
      "/api/plugin",
    ]) {
      const response = await get(`${path}?${location}`);
      expect(response.status).toBe(200);
      const body = await json(response);
      assertNotRouter404(response, body);
    }

    const switchedModel = await send("POST", `/api/session/${SESSION_ID}/model`, {
      model: { provider: "anthropic", id: "claude-sonnet-4" },
    });
    expect(switchedModel.status).toBe(204);

    const switchedAgent = await send("POST", `/api/session/${SESSION_ID}/agent`, { agent: "omo" });
    expect(switchedAgent.status).toBe(204);
  });
});

describe("mounted location and plugin routes", () => {
  const location = () => `location%5Bdirectory%5D=${encodeURIComponent(workdir)}`;

  test("GET /api/location answers a bare Location.PublicInfo, not a location envelope", async () => {
    const response = await get(`/api/location?${location()}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.directory).toBe(workdir);
    expect(body).not.toHaveProperty("location");
    expect(validateResponse("location.get", body)).toEqual({ ok: true });
  });

  test("GET /api/plugin answers the empty location envelope the TUI reads", async () => {
    const response = await get(`/api/plugin?${location()}`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.data).toEqual([]);
    expect(validateResponse("plugin.list", body)).toEqual({ ok: true });
  });
});

describe("mounted media route", () => {
  test("a stored blob is served by hash and an unknown hash is a handler 404", async () => {
    const bytes = new TextEncoder().encode("mount-media-bytes");
    const hash = putMedia(bytes, "text/plain");

    const found = await get(`/api/experimental/media/${hash}`);
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toBe("text/plain");

    const missing = await get(`/api/experimental/media/${"0".repeat(64)}`);
    expect(missing.status).toBe(404);
    const body = await json(missing);
    expect(body._tag).toBe("FileNotFoundError");
    assertNotRouter404(missing, body);
  });
});

describe("mounted degradation routes", () => {
  const cases: Array<{ method: string; path: string; status: number; tag?: string }> = [
    { method: "GET", path: "/api/worktree?projectID=x", status: 200 },
    { method: "POST", path: "/api/worktree/refresh", status: 204 },
    { method: "POST", path: "/api/worktree", status: 400, tag: "WorktreeError" },
    { method: "GET", path: `/api/experimental/session/${SESSION_ID}/terminal`, status: 200 },
    { method: "POST", path: `/api/experimental/session/${SESSION_ID}/terminal`, status: 400, tag: "InvalidRequestError" },
    { method: "GET", path: "/api/experimental/persistent-pty/pty_1/snapshot", status: 404, tag: "PtyNotFoundError" },
    { method: "GET", path: "/api/experimental/persistent-pty/x/connect", status: 404, tag: "PtyNotFoundError" },
    { method: "POST", path: "/api/experimental/persistent-pty/pty_1/connect-token", status: 404, tag: "PtyNotFoundError" },
    { method: "GET", path: "/api/experimental/migration/v1", status: 200 },
    { method: "POST", path: "/api/integration/int_1/connect/key", status: 404, tag: "IntegrationNotFoundError" },
    { method: "POST", path: "/api/integration/int_1/connect/external", status: 404, tag: "IntegrationNotFoundError" },
    { method: "POST", path: "/api/integration/int_1/connect/oauth", status: 404, tag: "IntegrationAttemptNotFoundError" },
    { method: "GET", path: "/api/integration/int_1/connect/oauth/att_1", status: 404, tag: "IntegrationAttemptNotFoundError" },
    { method: "POST", path: "/api/integration/int_1/connect/oauth/att_1/complete", status: 404, tag: "IntegrationAttemptNotFoundError" },
    { method: "DELETE", path: "/api/integration/int_1/connect/oauth/att_1", status: 204 },
    { method: "POST", path: "/api/integration/int_1/connect/command", status: 404, tag: "IntegrationAttemptNotFoundError" },
    { method: "GET", path: "/api/integration/int_1/connect/command/att_1", status: 404, tag: "IntegrationAttemptNotFoundError" },
    { method: "DELETE", path: "/api/integration/int_1/connect/command/att_1", status: 404, tag: "IntegrationAttemptNotFoundError" },
    { method: "POST", path: "/api/credential/cred_1/activate", status: 400, tag: "InvalidRequestError" },
    { method: "PATCH", path: "/api/credential/cred_1", status: 400, tag: "InvalidRequestError" },
    { method: "DELETE", path: "/api/credential/cred_1", status: 400, tag: "InvalidRequestError" },
    { method: "POST", path: "/api/pair", status: 400, tag: "InvalidRequestError" },
    { method: "GET", path: "/api/experimental/usage/limits?location%5Bdirectory%5D=$WORKDIR", status: 200 },
    { method: "POST", path: "/api/experimental/mcp/demo/connect", status: 204 },
    { method: "POST", path: "/api/experimental/mcp/demo/disconnect", status: 204 },
  ];

  for (const testCase of cases) {
    test(`${testCase.method} ${testCase.path.split("?")[0]} answers ${testCase.status}`, async () => {
      const path = testCase.path.replace("$WORKDIR", encodeURIComponent(workdir));
      const response = await send(testCase.method, path);
      expect(response.status).toBe(testCase.status);
      expect(response.status).toBeLessThan(500);
      if (response.status === 204) return;
      const body = await json(response);
      assertNotRouter404(response, body);
      if (testCase.tag !== undefined) expect(body._tag).toBe(testCase.tag);
    });
  }

  test("GET /api/worktree returns a bare empty array", async () => {
    expect(await (await get("/api/worktree?projectID=x")).json()).toEqual([]);
  });

  test("GET /api/experimental/migration/v1 reports completed", async () => {
    expect(await (await get("/api/experimental/migration/v1")).json()).toEqual({ status: "completed" });
  });

  test("GET /api/experimental/persistent-pty/:ptyID/connect answers the PtyNotFoundError envelope", async () => {
    const response = await get("/api/experimental/persistent-pty/x/connect");
    expect(response.status).toBe(404);
    const body = await json(response);
    expect(body._tag).toBe("PtyNotFoundError");
    expect(body.ptyID).toBe("x");
    assertNotRouter404(response, body);
  });
});

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(label)), ms);
    }),
  ]);
}

async function readEvents(subscription: EventSubscription, count: number): Promise<BridgeEvent[]> {
  const reader = subscription.stream.getReader();
  const events: BridgeEvent[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const result = await withTimeout(reader.read(), 2000, `timed out waiting for event ${index + 1}`);
      if (result.done || result.value === undefined) throw new Error(`event stream closed after ${index} events`);
      events.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

const permissionFrame = {
  type: "extension_ui_request",
  id: "uuid-mount-permission",
  method: "select",
  title: "Permission required: read\n\nPath: /project/a.txt",
  options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
  toolCallId: "call-mount",
};

const questionFrame = {
  type: "extension_ui_request",
  id: "uuid-mount-question",
  method: "question",
  requestId: "ask-mount",
  toolCallId: "call-question",
  waitForAnswer: true,
  questions: [
    {
      id: "db",
      header: "Database",
      question: "Which database?",
      options: [{ label: "SQLite" }],
      multiSelect: false,
    },
  ],
};

describe("runtime frame dispatch", () => {
  test("permission, question and translated frames reach the shared event bus", async () => {
    const bus = createEventBus({ capacity: 32 });
    setPermissionEventBus(bus);
    setFormEventBus(bus);
    setPermissionTransport(fake);
    setFormTransport(fake);
    const dispatch = createFrameDispatch({
      bus,
      defaultSessionID: () => "ses_frame_dispatch",
      resolveSessionID: (routing) => routing,
    });

    const askedSubscription = bus.subscribe({ types: ["permission.asked"] });
    dispatch.handle(permissionFrame);
    const [asked] = await readEvents(askedSubscription, 1);
    askedSubscription.close();
    expect(asked!.type).toBe("permission.asked");
    expect((asked!.data as Record<string, unknown>).sessionID).toBe("ses_frame_dispatch");

    const formSubscription = bus.subscribe({ types: ["form.created"] });
    dispatch.handle(questionFrame);
    const [created] = await readEvents(formSubscription, 1);
    formSubscription.close();
    expect(created!.type).toBe("form.created");
    expect(((created!.data as Record<string, unknown>).form as Record<string, unknown>).sessionID).toBe(
      "ses_frame_dispatch",
    );

    const executionSubscription = bus.subscribe({ types: ["session.execution.started"] });
    dispatch.handle({ type: "agent_start", runId: "run_mount" });
    const [started] = await readEvents(executionSubscription, 1);
    executionSubscription.close();
    expect(started!.type).toBe("session.execution.started");
    expect((started!.data as Record<string, unknown>).sessionID).toBe("ses_frame_dispatch");

    setPermissionEventBus(undefined);
    setFormEventBus(undefined);
  });

  test("streams the step under a provisional id and re-keys it when the durable entry lands", async () => {
    const bus = createEventBus({ capacity: 32 });
    const dispatch = createFrameDispatch({ bus, defaultSessionID: () => "ses_frame_dispatch" });
    const subscription = bus.subscribe({ types: ["session.step.started", "session.tool.input.started"] });

    dispatch.handle({
      type: "message_start",
      message: { role: "assistant", content: [], provider: "anthropic", model: "claude-sonnet-4", timestamp: 1 },
    });
    dispatch.handle({
      type: "message_update",
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call_mount", toolName: "bash" },
    });
    dispatch.handle({
      type: "entry_appended",
      entry: { type: "message", id: "4aac42d6", message: { role: "assistant", content: [] } },
    });
    const [liveStep, tool, rekeyedStep] = await readEvents(subscription, 3);
    subscription.close();

    // The step opens under the provisional id the bridge minted, so the deltas can stream now.
    expect(liveStep?.type).toBe("session.step.started");
    expect(liveStep?.data.assistantMessageID).toBe("msg_live_1");
    expect(liveStep?.data.replaces).toBeUndefined();
    // The tool frame precedes the entry, so it answers under the provisional id too.
    expect(tool?.type).toBe("session.tool.input.started");
    expect(tool?.data.assistantMessageID).toBe("msg_live_1");
    // The entry re-keys that step to the durable id, naming the id it replaces.
    expect(rekeyedStep?.type).toBe("session.step.started");
    expect(rekeyedStep?.data.assistantMessageID).toBe("4aac42d6");
    expect(rekeyedStep?.data.replaces).toBe(tool?.data.assistantMessageID);
  });

  test("a projector error is reported and the subscription keeps consuming frames", () => {
    const warnings: string[] = [];
    const throwingBus: EventBus = {
      publish: () => {
        throw new Error("sink down");
      },
      subscribe: () => {
        throw new Error("subscribe is not used by the dispatcher");
      },
      serverConnectedEvent: () => {
        throw new Error("serverConnectedEvent is not used by the dispatcher");
      },
    };
    const dispatch = createFrameDispatch({
      bus: throwingBus,
      warn: (message) => warnings.push(message),
      defaultSessionID: () => "ses_frame_dispatch",
    });

    expect(() => dispatch.handle({ type: "turn_start" })).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("lifecycle projector failed");

    expect(() => dispatch.handle({ type: "turn_start" })).not.toThrow();
    expect(warnings).toHaveLength(2);
  });
});
