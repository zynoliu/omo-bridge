import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponse } from "../../src/contract/validate";
import {
  SESSION_WAIT_TIMEOUT_MS,
  handleSessionActive,
  handleSessionDiff,
  handleSessionGet,
  handleSessionList,
  handleSessionLog,
  handleSessionMessageGet,
  handleSessionMessages,
  handleSessionView,
  handleSessionWait,
  setSessionReadTransport,
  setSessionWaitTimeoutMs,
  viewedAtFor,
  type SessionReadTransport,
} from "../../src/http/handlers/sessions";
import {
  handleSessionInboxList,
  setSessionInboxTransport,
  type SessionInboxTransport,
} from "../../src/http/handlers/inbox";
import { sessionManagementStore, setSessionManagementStore } from "../../src/http/handlers/session-write";
import { SessionMap } from "../../src/model/session-map";
import type {
  SenpiAbortAnswer,
  SenpiEntriesResult,
  SenpiMessages,
  SenpiOpenSessionResult,
  SenpiSessionState,
  SenpiSessionSummary,
} from "../../src/senpi/transport";

type Entries = SenpiEntriesResult["entries"];
type Messages = SenpiMessages;

interface FakeOptions {
  sessions?: SenpiSessionSummary[];
  states?: Map<string, SenpiSessionState>;
  entries?: Entries;
  messages?: Messages;
  entriesError?: Error;
  waitForIdle?: (timeout?: number) => Promise<void>;
}

class FakeTransport implements SessionReadTransport {
  readonly sessionId = "rpc-1";
  readonly sessions: SenpiSessionSummary[];
  readonly entries: Entries;
  readonly messages: Messages;
  readonly entriesError: Error | undefined;
  readonly waitForIdle: ((timeout?: number) => Promise<void>) | undefined;
  readonly waitTimeouts: number[] = [];
  readonly states: Map<string, SenpiSessionState>;
  listCalls = 0;
  stateCalls = 0;

  constructor(options: FakeOptions = {}) {
    this.sessions = options.sessions ?? [];
    this.entries = options.entries ?? [];
    this.messages = options.messages ?? [];
    this.entriesError = options.entriesError;
    this.states = options.states ?? new Map();
    const wait = options.waitForIdle;
    this.waitForIdle =
      wait === undefined
        ? undefined
        : async (timeout?: number) => {
            this.waitTimeouts.push(timeout ?? -1);
            await wait(timeout);
          };
  }

  async listSessions(): Promise<SenpiSessionSummary[]> {
    this.listCalls += 1;
    return this.sessions;
  }

  async getState(): Promise<SenpiSessionState> {
    this.stateCalls += 1;
    const state = this.states.get(this.sessionId);
    if (state === undefined) throw new Error("no state for this session");
    return state;
  }

  async getEntries(): Promise<SenpiEntriesResult> {
    if (this.entriesError !== undefined) throw this.entriesError;
    return { entries: this.entries, leafId: null };
  }

  async getMessages(): Promise<Messages> {
    return this.messages;
  }
}

function session(overrides: Record<string, unknown>): SenpiSessionSummary {
  return { sessionId: "rpc-1", cwd: "/work/project", status: "open", ...overrides } as SenpiSessionSummary;
}

function state(overrides: Record<string, unknown>): SenpiSessionState {
  return { sessionId: "rpc-1", ...overrides } as SenpiSessionState;
}

function userEntry(id: string, timestamp: string, text: string): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "user", content: text, timestamp: Date.parse(timestamp) },
  };
}

function assistantEntry(id: string, timestamp: string, content: unknown[]): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "assistant",
      content,
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude-sonnet-4",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
      stopReason: "stop",
      timestamp: Date.parse(timestamp),
    },
  };
}

function toolResultEntry(id: string, timestamp: string, toolCallId: string, text: string, isError: boolean): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text }],
      isError,
      timestamp: Date.parse(timestamp),
    },
  };
}

function extensionsEntry(id: string, timestamp: string, provider: string, modelId: string): unknown {
  return { type: "model_change", id, parentId: null, timestamp, provider, modelId };
}

function entriesOf(values: unknown[]): Entries {
  return values as unknown as Entries;
}

function url(path: string): URL {
  return new URL(`http://bridge.test${path}`);
}

function get(path: string): Request {
  return new Request(`http://bridge.test${path}`);
}

function post(path: string, body: unknown): Request {
  return new Request(`http://bridge.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "session-read-"));
});

afterEach(() => {
  setSessionReadTransport(undefined);
  setSessionInboxTransport(undefined);
  setSessionManagementStore(undefined);
  setSessionWaitTimeoutMs(SESSION_WAIT_TIMEOUT_MS);
  rmSync(workDir, { recursive: true, force: true });
});

describe("GET /api/session", () => {
  test("maps list rows onto the opencode public session shape", async () => {
    const sessionPath = join(workDir, "alpha.jsonl");
    writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: "alpha" })}\n`);
    const transport = new FakeTransport({
      sessions: [
        session({ sessionId: "rpc-1", durableSessionId: "durable-1", sessionPath, cwd: "/work/alpha", name: "Alpha" }),
        session({ sessionId: "rpc-2", cwd: "/work/beta" }),
        session({ sessionId: "rpc-3", durableSessionId: "durable-3", cwd: "/work/gamma" }),
      ],
    });
    setSessionReadTransport(transport);

    const response = await handleSessionList(get("/api/session"), url("/api/session"));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data).toHaveLength(3);

    for (const item of data) expect(validateResponse("session.publicInfo", item)).toEqual({ ok: true });

    const byId = new Map(data.map((item) => [item.id as string, item]));
    expect([...byId.keys()].sort()).toEqual(["durable-1", "durable-3", "rpc-2"]);

    const alpha = byId.get("durable-1")!;
    expect(alpha.title).toBe("Alpha");
    expect(alpha.location).toEqual({ directory: "/work/alpha" });
    expect(alpha.projectID).toMatch(/^[0-9a-f]{64}$/);
    const alphaTime = alpha.time as { created: number; updated: number };
    expect(Number.isInteger(alphaTime.created)).toBe(true);
    expect(Number.isInteger(alphaTime.updated)).toBe(true);
    expect(alphaTime.created).toBeGreaterThan(0);
    expect(alphaTime.created <= alphaTime.updated).toBe(true);

    const beta = byId.get("rpc-2")!;
    expect(beta.title).toBe("beta");
    expect(beta.location).toEqual({ directory: "/work/beta" });

    expect(body.cursor).toEqual({});
  });

  test("keeps projectID stable across calls for the same directory", async () => {
    const transport = new FakeTransport({ sessions: [session({ cwd: "/work/alpha" })] });
    setSessionReadTransport(transport);

    const first = (await (await handleSessionList(get("/api/session"), url("/api/session"))).json()) as {
      data: Array<Record<string, unknown>>;
    };
    const second = (await (await handleSessionList(get("/api/session"), url("/api/session"))).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(first.data[0]!.projectID).toBe(second.data[0]!.projectID);
    expect(first.data[0]!.location).toEqual(second.data[0]!.location);
  });

  test("returns an empty list with an empty cursor", async () => {
    setSessionReadTransport(new FakeTransport());
    const response = await handleSessionList(get("/api/session"), url("/api/session"));
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ data: [], cursor: {} });
  });

  test("pages with limit and an opaque cursor", async () => {
    setSessionReadTransport(
      new FakeTransport({
        sessions: [
          session({ sessionId: "rpc-1", durableSessionId: "durable-1", cwd: "/work/one" }),
          session({ sessionId: "rpc-2", durableSessionId: "durable-2", cwd: "/work/two" }),
          session({ sessionId: "rpc-3", durableSessionId: "durable-3", cwd: "/work/three" }),
        ],
      }),
    );

    const first = await bodyOf(await handleSessionList(get("/api/session?limit=2"), url("/api/session?limit=2")));
    const firstData = first.data as Array<Record<string, unknown>>;
    const firstCursor = first.cursor as Record<string, string>;
    expect(firstData).toHaveLength(2);
    expect(firstCursor.previous).toBeUndefined();
    expect(typeof firstCursor.next).toBe("string");

    const nextUrl = url(`/api/session?limit=2&cursor=${encodeURIComponent(firstCursor.next!)}`);
    const second = await bodyOf(await handleSessionList(get(nextUrl.pathname + nextUrl.search), nextUrl));
    const secondData = second.data as Array<Record<string, unknown>>;
    const secondCursor = second.cursor as Record<string, string>;
    expect(secondData).toHaveLength(1);
    expect(secondCursor.next).toBeUndefined();
    expect(typeof secondCursor.previous).toBe("string");

    const ids = new Set([...firstData, ...secondData].map((item) => item.id as string));
    expect([...ids].sort()).toEqual(["durable-1", "durable-2", "durable-3"]);
  });

  test("rejects a limit that is not a positive integer", async () => {
    setSessionReadTransport(new FakeTransport());
    const response = await handleSessionList(get("/api/session?limit=0"), url("/api/session?limit=0"));
    expect(response.status).toBe(400);
    expect((await bodyOf(response))._tag).toBe("InvalidRequestError");
  });

  test("rejects a cursor it did not issue", async () => {
    setSessionReadTransport(new FakeTransport());
    const response = await handleSessionList(get("/api/session?cursor=nope"), url("/api/session?cursor=nope"));
    expect(response.status).toBe(400);
    expect((await bodyOf(response))._tag).toBe("InvalidCursorError");
  });
  test("serves epoch-millis time.archived and filters by the archived query", async () => {
    const sessionPath = join(workDir, "archived.jsonl");
    writeFileSync(sessionPath, `${JSON.stringify({ type: "session", id: "durable-archived" })}\n`);
    const row = session({
      sessionId: "rpc-archived",
      durableSessionId: "durable-archived",
      sessionPath,
      cwd: "/work/archived",
      name: "Archived",
    });
    const map = SessionMap.open({ stateDir: join(workDir, "state"), agentDir: join(workDir, "agent") });
    map.upsert(row);
    map.archive("durable-archived");
    setSessionManagementStore(sessionManagementStore(map));
    setSessionReadTransport(new FakeTransport({ sessions: [row] }));

    const archivedBody = await bodyOf(
      await handleSessionList(get("/api/session?archived=true"), url("/api/session?archived=true")),
    );
    const archivedRows = archivedBody.data as Array<Record<string, unknown>>;
    expect(archivedRows).toHaveLength(1);
    expect(validateResponse("session.publicInfo", archivedRows[0])).toEqual({ ok: true });
    const time = archivedRows[0]!.time as { created: number; updated: number; archived?: number };
    expect(Number.isInteger(time.created)).toBe(true);
    expect(Number.isInteger(time.archived)).toBe(true);

    const activeBody = await bodyOf(
      await handleSessionList(get("/api/session?archived=false"), url("/api/session?archived=false")),
    );
    expect(activeBody.data).toEqual([]);

    const single = await handleSessionGet(
      get("/api/session/durable-archived"),
      url("/api/session/durable-archived"),
    );
    expect((await bodyOf(single)).data).toMatchObject({ time: { archived: time.archived } });
  });
});

describe("GET /api/session/active", () => {
  test("reports streaming sessions and skips ones whose state cannot be read", async () => {
    const states = new Map<string, SenpiSessionState>([
      ["rpc-1", state({ isStreaming: true })],
      ["rpc-2", state({ sessionId: "rpc-other", isStreaming: true })],
      ["rpc-3", state({ sessionId: "rpc-3", isStreaming: false })],
    ]);
    const transport = new FakeTransport({
      sessions: [
        session({ sessionId: "rpc-1", durableSessionId: "durable-1" }),
        session({ sessionId: "rpc-2", durableSessionId: "durable-2" }),
        session({ sessionId: "rpc-3", durableSessionId: "durable-3" }),
        session({ sessionId: "rpc-4", durableSessionId: "durable-4" }),
      ],
      states,
    });
    setSessionReadTransport(transport);

    const response = await handleSessionActive(get("/api/session/active"), url("/api/session/active"));
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ data: { "durable-1": { type: "running" } } });
  });

  test("returns an empty record when the transport holds no state", async () => {
    setSessionReadTransport(new FakeTransport({ sessions: [session({})] }));
    expect(await bodyOf(await handleSessionActive(get("/api/session/active"), url("/api/session/active")))).toEqual({
      data: {},
    });
  });
});

describe("GET /api/session/:id", () => {
  test("returns the mapped session for a durable id and for the routing id", async () => {
    setSessionReadTransport(
      new FakeTransport({ sessions: [session({ sessionId: "rpc-1", durableSessionId: "durable-1", name: "Alpha" })] }),
    );

    const durable = await handleSessionGet(get("/api/session/durable-1"), url("/api/session/durable-1"));
    expect(durable.status).toBe(200);
    const durableBody = await bodyOf(durable);
    expect(validateResponse("session.publicInfo", durableBody.data)).toEqual({ ok: true });
    expect((durableBody.data as Record<string, unknown>).id).toBe("durable-1");

    const routed = await handleSessionGet(get("/api/session/rpc-1"), url("/api/session/rpc-1"));
    expect(routed.status).toBe(200);
    expect((await bodyOf(routed)).data).toEqual(durableBody.data);
  });

  test("unknown id returns 404 SessionNotFoundError", async () => {
    setSessionReadTransport(new FakeTransport({ sessions: [session({})] }));
    const response = await handleSessionGet(get("/api/session/nope"), url("/api/session/nope"));
    expect(response.status).toBe(404);
    const body = await bodyOf(response);
    expect(body._tag).toBe("SessionNotFoundError");
    expect(body.sessionID).toBe("nope");
    expect(typeof body.message).toBe("string");
  });
});

describe("session messages", () => {
  function messageEntries(): Entries {
    return entriesOf([
      userEntry("e1", "2026-11-05T00:00:00.000Z", "hello"),
      assistantEntry("e2", "2026-11-05T00:00:01.000Z", [
        { type: "text", text: "hi" },
        { type: "thinking", thinking: "pondering" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "ls" } },
      ]),
      toolResultEntry("e3", "2026-11-05T00:00:02.000Z", "call-1", "out", false),
      extensionsEntry("e4", "2026-11-05T00:00:03.000Z", "anthropic", "claude-sonnet-4"),
    ]);
  }

  test("maps user, assistant and tool parts with stable entry ids", async () => {
    setSessionReadTransport(
      new FakeTransport({
        sessions: [session({ durableSessionId: "durable-1" })],
        entries: messageEntries(),
      }),
    );

    const response = await handleSessionMessages(
      get("/api/session/durable-1/message"),
      url("/api/session/durable-1/message"),
    );
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    const data = body.data as Array<Record<string, unknown>>;
    expect(data.map((message) => message.id)).toEqual(["e1", "e2", "e4"]);
    expect(body.cursor).toEqual({});

    const user = data[0]!;
    expect(user.type).toBe("user");
    expect(user.text).toBe("hello");
    expect(user.time).toEqual({ created: Date.parse("2026-11-05T00:00:00.000Z") });

    const assistant = data[1]!;
    expect(assistant.type).toBe("assistant");
    expect(assistant.agent).toBe("build");
    expect(assistant.model).toEqual({ id: "claude-sonnet-4", providerID: "anthropic" });
    const content = assistant.content as Array<Record<string, unknown>>;
    expect(content.map((part) => part.type)).toEqual(["text", "reasoning", "tool"]);
    expect(content[0]).toEqual({ type: "text", text: "hi" });
    expect(content[1]).toEqual({ type: "reasoning", text: "pondering" });
    expect(content[2]).toMatchObject({
      type: "tool",
      id: "call-1",
      name: "bash",
      state: { status: "completed", input: { cmd: "ls" }, content: [{ type: "text", text: "out" }] },
    });

    expect(data[2]).toMatchObject({ type: "model-switched", model: { id: "claude-sonnet-4", providerID: "anthropic" } });

    const again = await bodyOf(
      await handleSessionMessages(get("/api/session/durable-1/message"), url("/api/session/durable-1/message")),
    );
    expect((again.data as Array<Record<string, unknown>>).map((message) => message.id)).toEqual(["e1", "e2", "e4"]);
  });

  test("marks a tool call without a result as running", async () => {
    setSessionReadTransport(
      new FakeTransport({
        sessions: [session({ durableSessionId: "durable-1" })],
        entries: entriesOf([
          assistantEntry("e1", "2026-11-05T00:00:00.000Z", [
            { type: "toolCall", id: "call-9", name: "read", arguments: { path: "a" } },
          ]),
        ]),
      }),
    );

    const body = await bodyOf(
      await handleSessionMessages(get("/api/session/durable-1/message"), url("/api/session/durable-1/message")),
    );
    const content = (body.data as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]!.state).toEqual({ status: "running", input: { path: "a" }, metadata: {} });
  });

  test("falls back to projected messages when the host refuses entries", async () => {
    setSessionReadTransport(
      new FakeTransport({
        sessions: [session({ durableSessionId: "durable-1" })],
        entriesError: new Error("response_too_large"),
        messages: [
          { role: "user", content: "hello", timestamp: Date.parse("2026-11-05T00:00:00.000Z") },
          {
            role: "assistant",
            content: [{ type: "text", text: "hi" }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-sonnet-4",
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
            stopReason: "stop",
            timestamp: Date.parse("2026-11-05T00:00:01.000Z"),
          },
        ] as unknown as Messages,
      }),
    );

    const body = await bodyOf(
      await handleSessionMessages(get("/api/session/durable-1/message"), url("/api/session/durable-1/message")),
    );
    expect((body.data as Array<Record<string, unknown>>).map((message) => message.id)).toEqual([
      "message-0",
      "message-1",
    ]);
  });

  test("pages messages and rejects an unknown session", async () => {
    setSessionReadTransport(
      new FakeTransport({ sessions: [session({ durableSessionId: "durable-1" })], entries: messageEntries() }),
    );

    const pageUrl = url("/api/session/durable-1/message?limit=1");
    const first = await bodyOf(await handleSessionMessages(get(pageUrl.pathname + pageUrl.search), pageUrl));
    expect((first.data as unknown[]).length).toBe(1);
    expect(typeof (first.cursor as Record<string, string>).next).toBe("string");

    const missing = await handleSessionMessages(get("/api/session/nope/message"), url("/api/session/nope/message"));
    expect(missing.status).toBe(404);
    expect((await bodyOf(missing))._tag).toBe("SessionNotFoundError");
  });

  test("GET /api/session/:id/message/:messageID returns one message or 404", async () => {
    setSessionReadTransport(
      new FakeTransport({ sessions: [session({ durableSessionId: "durable-1" })], entries: messageEntries() }),
    );

    const found = await handleSessionMessageGet(
      get("/api/session/durable-1/message/e2"),
      url("/api/session/durable-1/message/e2"),
    );
    expect(found.status).toBe(200);
    expect(((await bodyOf(found)).data as Record<string, unknown>).id).toBe("e2");

    const missing = await handleSessionMessageGet(
      get("/api/session/durable-1/message/e9"),
      url("/api/session/durable-1/message/e9"),
    );
    expect(missing.status).toBe(404);
    const body = await bodyOf(missing);
    expect(body._tag).toBe("MessageNotFoundError");
    expect(body.messageID).toBe("e9");
  });
});

/**
 * The inbox handlers read their own seam; this adapter exposes the same fake through it so the
 * empty-read and unknown-session assertions keep exercising the mounted handler.
 */
function inboxSeam(fake: FakeTransport): SessionInboxTransport {
  return {
    sessionId: fake.sessionId,
    listSessions: () => fake.listSessions(),
    getState: () => fake.getState(),
    abort: async () => undefined as SenpiAbortAnswer,
    openSession: async () => ({ sessionId: fake.sessionId }) as SenpiOpenSessionResult,
    raw: { request: async <T>() => ({}) as T },
  };
}

describe("empty read clusters", () => {
  test("inbox and diff return empty arrays for a known session", async () => {
    const fake = new FakeTransport({ sessions: [session({ durableSessionId: "durable-1" })] });
    setSessionReadTransport(fake);
    setSessionInboxTransport(inboxSeam(fake));

    const inbox = await handleSessionInboxList(
      get("/api/session/durable-1/inbox"),
      url("/api/session/durable-1/inbox"),
    );
    expect(inbox.status).toBe(200);
    expect(await bodyOf(inbox)).toEqual({ data: [] });

    const diff = await handleSessionDiff(get("/api/session/durable-1/diff"), url("/api/session/durable-1/diff"));
    expect(diff.status).toBe(200);
    expect(await bodyOf(diff)).toEqual({ data: [] });
  });

  test("unknown session still 404s on inbox and diff", async () => {
    const fake = new FakeTransport();
    setSessionReadTransport(fake);
    setSessionInboxTransport(inboxSeam(fake));
    const inbox = await handleSessionInboxList(get("/api/session/nope/inbox"), url("/api/session/nope/inbox"));
    expect(inbox.status).toBe(404);
    expect((await bodyOf(inbox))._tag).toBe("SessionNotFoundError");
  });
});

describe("POST session wait, view and log", () => {
  test("wait returns 204 immediately when the transport cannot wait", async () => {
    setSessionReadTransport(new FakeTransport({ sessions: [session({ durableSessionId: "durable-1" })] }));
    const response = await handleSessionWait(
      post("/api/experimental/session/durable-1/wait", {}),
      url("/api/experimental/session/durable-1/wait"),
    );
    expect(response.status).toBe(204);
  });

  test("wait passes a bounded timeout and returns 204 once idle", async () => {
    const transport = new FakeTransport({
      sessions: [session({ durableSessionId: "durable-1" })],
      waitForIdle: async () => {},
    });
    setSessionReadTransport(transport);

    const response = await handleSessionWait(
      post("/api/experimental/session/durable-1/wait", {}),
      url("/api/experimental/session/durable-1/wait"),
    );
    expect(response.status).toBe(204);
    expect(transport.waitTimeouts).toEqual([SESSION_WAIT_TIMEOUT_MS]);
  });

  test(
    "wait never outlives its deadline when the transport never settles",
    async () => {
      setSessionWaitTimeoutMs(50);
      setSessionReadTransport(
        new FakeTransport({
          sessions: [session({ durableSessionId: "durable-1" })],
          waitForIdle: () => new Promise<void>(() => {}),
        }),
      );

      const started = Date.now();
      const response = await handleSessionWait(
        post("/api/experimental/session/durable-1/wait", {}),
        url("/api/experimental/session/durable-1/wait"),
      );
      const elapsed = Date.now() - started;
      expect(response.status).toBe(204);
      expect(elapsed).toBeLessThan(500);
    },
    { timeout: 15_000 },
  );

  test("wait 404s for an unknown session", async () => {
    setSessionReadTransport(new FakeTransport());
    const response = await handleSessionWait(
      post("/api/experimental/session/nope/wait", {}),
      url("/api/experimental/session/nope/wait"),
    );
    expect(response.status).toBe(404);
    expect((await bodyOf(response))._tag).toBe("SessionNotFoundError");
  });

  test("view records the idle timestamp and returns 204", async () => {
    setSessionReadTransport(new FakeTransport({ sessions: [session({ durableSessionId: "durable-1" })] }));
    const response = await handleSessionView(
      post("/api/session/durable-1/view", { idle: 1762300800000 }),
      url("/api/session/durable-1/view"),
    );
    expect(response.status).toBe(204);
    expect(viewedAtFor("durable-1")).toBe(1762300800000);
  });

  test("view rejects a payload without an idle timestamp", async () => {
    setSessionReadTransport(new FakeTransport({ sessions: [session({ durableSessionId: "durable-1" })] }));
    const response = await handleSessionView(
      post("/api/session/durable-1/view", {}),
      url("/api/session/durable-1/view"),
    );
    expect(response.status).toBe(400);
    expect((await bodyOf(response))._tag).toBe("InvalidRequestError");
  });

  test("log serves a minimal SSE stream that closes", async () => {
    setSessionReadTransport(new FakeTransport({ sessions: [session({ durableSessionId: "durable-1" })] }));
    const response = await handleSessionLog(
      get("/api/experimental/session/durable-1/log"),
      url("/api/experimental/session/durable-1/log"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text.startsWith(":")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
  });
});

describe("transport wiring", () => {
  test("answers 503 ServiceUnavailableError when no transport is wired", async () => {
    setSessionReadTransport(undefined);
    const response = await handleSessionList(get("/api/session"), url("/api/session"));
    expect(response.status).toBe(503);
    expect((await bodyOf(response))._tag).toBe("ServiceUnavailableError");
  });
});
