import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  backgroundedSessionIDs,
  resetSessionInboxState,
  setSessionInboxTransport,
  snapshotQueue,
  translateQueueUpdate,
  type InboxCommand,
  type InboxCommandChannel,
  type QueueEntry,
  type SessionInboxTransport,
} from "../../src/http/handlers/inbox";
import { createRouter } from "../../src/http/router";
import { routes } from "../../src/http/routes";
import type {
  SenpiAbortAnswer,
  SenpiAbortOptions,
  SenpiOpenSessionOptions,
  SenpiOpenSessionResult,
  SenpiSessionState,
  SenpiSessionSummary,
  SenpiTransport,
} from "../../src/senpi/transport";

const seamAcceptsRealTransport: SessionInboxTransport | undefined =
  undefined as unknown as SenpiTransport | undefined;
void seamAcceptsRealTransport;

class CapturingChannel implements InboxCommandChannel {
  readonly commands: InboxCommand[] = [];
  answers = new Map<string, unknown>();
  refusal: Error | undefined;

  async request<T>(command: InboxCommand): Promise<T> {
    this.commands.push(structuredClone(command));
    if (this.refusal !== undefined) throw this.refusal;
    return (this.answers.get(command.type) ?? {}) as T;
  }
}

class FakeTransport implements SessionInboxTransport {
  sessionId: string | undefined = "rpc-1";
  rows: SenpiSessionSummary[] = [];
  ordered: QueueEntry[] = [];
  pendingAnswer: unknown = undefined;
  providePending = false;
  abortError: Error | undefined;
  readonly aborts: Array<SenpiAbortOptions | undefined> = [];
  readonly opens: SenpiOpenSessionOptions[] = [];
  readonly raw = new CapturingChannel();

  async abort(options?: SenpiAbortOptions): Promise<SenpiAbortAnswer> {
    this.aborts.push(options);
    if (this.abortError !== undefined) throw this.abortError;
    return undefined as SenpiAbortAnswer;
  }

  async getState(): Promise<SenpiSessionState> {
    return {
      sessionId: this.sessionId,
      isStreaming: false,
      ordered: this.ordered,
    } as unknown as SenpiSessionState;
  }

  async listSessions(): Promise<SenpiSessionSummary[]> {
    return [...this.rows];
  }

  async openSession(options: SenpiOpenSessionOptions = {}): Promise<SenpiOpenSessionResult> {
    this.opens.push(options);
    if (options.sessionPath !== undefined) {
      const existing = this.rows.find((row) => row.sessionPath === options.sessionPath);
      if (existing !== undefined) this.sessionId = existing.sessionId;
    }
    return { sessionId: this.sessionId ?? "rpc-1" } as SenpiOpenSessionResult;
  }

  getPendingInputs?: (knownClientMessageIds?: readonly string[]) => Promise<unknown>;

  constructor() {
    const answer = (): Promise<unknown> => Promise.resolve(this.pendingAnswer);
    Object.defineProperty(this, "getPendingInputs", {
      configurable: true,
      get: () => (this.providePending ? answer : undefined),
    });
  }
}

function row(overrides: Record<string, unknown> = {}): SenpiSessionSummary {
  return {
    sessionId: "rpc-1",
    durableSessionId: "durable-1",
    sessionPath: "/tmp/durable-1.jsonl",
    cwd: "/tmp",
    status: "open",
    ...overrides,
  } as SenpiSessionSummary;
}

// Requests go through the mounted route table, so a missing mount (a router 404) or the old
// `{data: []}` stub fails these tests the same way it would fail the TUI.
const router = createRouter(routes);

function dispatch(request: Request): Promise<Response> {
  return router(request);
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(`http://bridge.test${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function queued(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    queuedId: "q_1",
    text: "first",
    mode: "steer",
    enqueueOrder: 1,
    revision: 1,
    ...overrides,
  };
}

let transport: FakeTransport;

beforeEach(() => {
  transport = new FakeTransport();
  transport.rows = [row()];
  setSessionInboxTransport(transport);
  resetSessionInboxState();
});

afterEach(() => {
  setSessionInboxTransport(undefined);
  resetSessionInboxState();
});

describe("POST /api/session/:sessionID/interrupt", () => {
  test("sends abort with intent stop, never a bare abort", async () => {
    const response = await dispatch(request("POST", "/api/session/durable-1/interrupt", {}));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ interrupted: true });
    expect(transport.aborts).toEqual([{ intent: "stop" }]);
    expect(transport.raw.commands).toEqual([]);
  });

  test("accepts an absent body and a resume query", async () => {
    const response = await dispatch(request("POST", "/api/session/durable-1/interrupt?resume=true"));

    expect(response.status).toBe(200);
    expect(transport.raw.commands).toEqual([{ type: "resume_session", mode: "continue" }]);
  });

  test("resumes when the body asks for it", async () => {
    const response = await dispatch(request("POST", "/api/session/durable-1/interrupt", { resume: true }));

    expect(response.status).toBe(200);
    expect(transport.raw.commands).toEqual([{ type: "resume_session", mode: "continue" }]);
  });

  test("maps a refused user Stop to 409", async () => {
    transport.abortError = Object.assign(
      new Error("stop_requires_interactive_client: declare interactive_user with set_client_info first"),
      { code: "stop_requires_interactive_client" },
    );

    const response = await dispatch(request("POST", "/api/session/durable-1/interrupt", {}));

    expect(response.status).toBe(409);
    const body = await bodyOf(response);
    expect(body._tag).toBe("ConflictError");
    expect(body.message).toBe(
      "stop_requires_interactive_client: declare interactive_user with set_client_info first",
    );
    expect(transport.raw.commands).toEqual([]);
  });

  test("404s an unknown session before touching the host", async () => {
    const response = await dispatch(request("POST", "/api/session/nope/interrupt", {}));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))._tag).toBe("SessionNotFoundError");
    expect(transport.aborts).toEqual([]);
  });

  test("400s a malformed body", async () => {
    const response = await dispatch(
      new Request("http://bridge.test/api/session/durable-1/interrupt", { method: "POST", body: "{" }),
    );

    expect(response.status).toBe(400);
    expect(transport.aborts).toEqual([]);
  });
});

describe("POST /api/session/:sessionID/background", () => {
  test("marks the session and leaves the turn alone", async () => {
    const response = await dispatch(request("POST", "/api/session/durable-1/background"));

    expect(response.status).toBe(204);
    expect(backgroundedSessionIDs()).toEqual(["durable-1"]);
    expect(transport.aborts).toEqual([]);
    expect(transport.raw.commands).toEqual([]);
  });

  test("404s an unknown session", async () => {
    const response = await dispatch(request("POST", "/api/session/nope/background"));

    expect(response.status).toBe(404);
    expect(backgroundedSessionIDs()).toEqual([]);
  });
});

describe("GET /api/session/:sessionID/inbox", () => {
  test("answers an empty list when the transport has no pending-input ledger", async () => {
    const response = await dispatch(request("GET", "/api/session/durable-1/inbox"));

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ data: [] });
  });

  test("normalizes the host pending-input snapshot", async () => {
    transport.providePending = true;
    transport.pendingAnswer = {
      inputs: [
        { clientMessageId: "c-7", text: "also run the tests", requestedMode: "followUp", state: "queued" },
        { clientMessageId: "c-8", text: "look at the diff", requestedMode: "steer", state: "queued" },
      ],
    };

    const response = await dispatch(request("GET", "/api/session/durable-1/inbox"));

    expect(response.status).toBe(200);
    const data = (await bodyOf(response)).data as Array<Record<string, unknown>>;
    expect(data.map((item) => [item.id, item.sessionID, item.type, item.text, item.delivery])).toEqual([
      ["c-7", "durable-1", "user", "also run the tests", "queue"],
      ["c-8", "durable-1", "user", "look at the diff", "steer"],
    ]);
    expect(typeof (data[0]?.time as Record<string, unknown>).created).toBe("string");
  });

  test("keeps the first-seen creation time across reads", async () => {
    transport.providePending = true;
    transport.pendingAnswer = [{ id: "msg_1", text: "hello", delivery: "steer" }];

    const first = await dispatch(request("GET", "/api/session/durable-1/inbox"));
    const second = await dispatch(request("GET", "/api/session/durable-1/inbox"));

    const createdFirst = ((await bodyOf(first)).data as Array<{ time: { created: string } }>)[0]?.time.created;
    const createdSecond = ((await bodyOf(second)).data as Array<{ time: { created: string } }>)[0]?.time.created;
    expect(createdFirst).toBeDefined();
    expect(createdSecond).toBe(createdFirst);
  });
});

describe("DELETE /api/session/:sessionID/inbox/:inboxID", () => {
  test("dequeues exactly the addressed entry by its queued id", async () => {
    transport.ordered = [queued({ queuedId: "q_3" }), queued({ queuedId: "q_4", text: "second" })];
    transport.raw.answers.set("dequeue_message", { queuedId: "q_3", status: "removed" });

    const response = await dispatch(request("DELETE", "/api/session/durable-1/inbox/q_3"));

    expect(response.status).toBe(204);
    expect(transport.raw.commands).toEqual([{ type: "dequeue_message", queuedId: "q_3" }]);
    expect(snapshotQueue("durable-1")?.map((entry) => entry.queuedId)).toEqual(["q_4"]);
  });

  test("resolves a client message id to the host queued id", async () => {
    transport.ordered = [queued({ queuedId: "q_7", clientMessageId: "msg_7" })];
    transport.raw.answers.set("dequeue_message", { queuedId: "q_7", status: "removed" });

    const response = await dispatch(request("DELETE", "/api/session/durable-1/inbox/msg_7"));

    expect(response.status).toBe(204);
    expect(transport.raw.commands).toEqual([{ type: "dequeue_message", queuedId: "q_7" }]);
  });

  test("404s an id the host queue does not hold, without sending clear_queue", async () => {
    transport.ordered = [queued({ queuedId: "q_3" })];

    const response = await dispatch(request("DELETE", "/api/session/durable-1/inbox/q_9"));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))._tag).toBe("NotFoundError");
    expect(transport.raw.commands).toEqual([]);
  });

  test("404s when the host says the entry was already delivered", async () => {
    transport.ordered = [queued({ queuedId: "q_3" })];
    transport.raw.answers.set("dequeue_message", { queuedId: "q_3", status: "already_delivered" });

    const response = await dispatch(request("DELETE", "/api/session/durable-1/inbox/q_3"));

    expect(response.status).toBe(404);
    expect((await bodyOf(response))._tag).toBe("NotFoundError");
    expect(transport.raw.commands.map((command) => command.type)).toEqual(["dequeue_message"]);
  });
});

describe("PATCH /api/session/:sessionID/inbox/:inboxID", () => {
  test("moves a queued input to steer by dequeue plus re-enqueue in place", async () => {
    transport.ordered = [queued({ queuedId: "q_3", text: "focus on errors", mode: "followUp", enqueueOrder: 2 })];
    transport.raw.answers.set("dequeue_message", { queuedId: "q_3", status: "removed" });
    transport.raw.answers.set("steer", { disposition: "queued" });

    const response = await dispatch(
      request("PATCH", "/api/session/durable-1/inbox/q_3", { delivery: "steer" }),
    );

    expect(response.status).toBe(204);
    expect(transport.raw.commands).toEqual([
      { type: "dequeue_message", queuedId: "q_3" },
      { type: "steer", message: "focus on errors", enqueueOrder: 2 },
    ]);
    expect(JSON.stringify(transport.raw.commands)).not.toContain("clear_queue");
    expect(snapshotQueue("durable-1")).toEqual([]);
  });

  test("moves a steered input back to the queue", async () => {
    transport.ordered = [queued({ queuedId: "q_4", text: "later", mode: "steer" })];
    transport.raw.answers.set("dequeue_message", { queuedId: "q_4", status: "removed" });

    const response = await dispatch(
      request("PATCH", "/api/session/durable-1/inbox/q_4", { delivery: "queue" }),
    );

    expect(response.status).toBe(204);
    expect(transport.raw.commands).toEqual([
      { type: "dequeue_message", queuedId: "q_4" },
      { type: "follow_up", message: "later", enqueueOrder: 1 },
    ]);
  });

  test("is a no-op when the input already has that delivery", async () => {
    transport.ordered = [queued({ queuedId: "q_5", mode: "steer" })];

    const response = await dispatch(
      request("PATCH", "/api/session/durable-1/inbox/q_5", { delivery: "steer" }),
    );

    expect(response.status).toBe(204);
    expect(transport.raw.commands).toEqual([]);
  });

  test("404s an unknown input and 400s an unknown delivery", async () => {
    transport.ordered = [queued({ queuedId: "q_5" })];

    const missing = await dispatch(
      request("PATCH", "/api/session/durable-1/inbox/q_6", { delivery: "queue" }),
    );
    expect(missing.status).toBe(404);
    expect((await bodyOf(missing))._tag).toBe("NotFoundError");

    const invalid = await dispatch(
      request("PATCH", "/api/session/durable-1/inbox/q_5", { delivery: "later" }),
    );
    expect(invalid.status).toBe(400);
    expect((await bodyOf(invalid))._tag).toBe("InvalidRequestError");
    expect(transport.raw.commands).toEqual([]);
  });

  test("reports a lost input when the re-enqueue is refused", async () => {
    transport.ordered = [queued({ queuedId: "q_8", mode: "followUp", text: "keep me" })];
    const channel = transport.raw;
    let call = 0;
    channel.request = async <T>(command: InboxCommand): Promise<T> => {
      call += 1;
      channel.commands.push(structuredClone(command));
      if (call === 1) return { status: "removed" } as T;
      throw new Error("session is gone");
    };

    const response = await dispatch(
      request("PATCH", "/api/session/durable-1/inbox/q_8", { delivery: "steer" }),
    );

    expect(response.status).toBe(503);
    const body = await bodyOf(response);
    expect(body._tag).toBe("ServiceUnavailableError");
    expect(body.message).toContain("was removed but could not be re-queued as steer");
    expect(channel.commands.map((command) => command.type)).toEqual(["dequeue_message", "steer"]);
  });
});

describe("mounted session inbox routes", () => {
  test("the router reaches all five routes and the list is the real projection, not the stub", async () => {
    transport.providePending = true;
    transport.pendingAnswer = [{ id: "msg_mount", text: "pending over the router", delivery: "steer" }];
    transport.ordered = [queued({ queuedId: "q_mount", text: "move me", mode: "followUp" })];

    const interrupted = await dispatch(request("POST", "/api/session/durable-1/interrupt", {}));
    expect(interrupted.status).toBe(200);

    const background = await dispatch(request("POST", "/api/session/durable-1/background"));
    expect(background.status).toBe(204);

    const listed = await dispatch(request("GET", "/api/session/durable-1/inbox"));
    expect(listed.status).toBe(200);
    const items = (await bodyOf(listed)).data as Array<Record<string, unknown>>;
    expect(items.map((item) => [item.id, item.text, item.delivery])).toEqual([
      ["msg_mount", "pending over the router", "steer"],
    ]);

    const cancelled = await dispatch(request("DELETE", "/api/session/durable-1/inbox/q_mount"));
    expect(cancelled.status).toBe(204);
    expect(transport.raw.commands).toEqual([{ type: "dequeue_message", queuedId: "q_mount" }]);

    transport.ordered = [queued({ queuedId: "q_move", text: "move me", mode: "followUp" })];
    const updated = await dispatch(
      request("PATCH", "/api/session/durable-1/inbox/q_move", { delivery: "steer" }),
    );
    expect(updated.status).toBe(204);
    expect(transport.raw.commands.at(-1)).toEqual({ type: "steer", message: "move me", enqueueOrder: 1 });
  });
});

describe("translateQueueUpdate", () => {
  test("emits enqueued, delivery.changed and cancelled by diffing the last queue", () => {
    const sessionID = "durable-1";
    const now = 1_760_000_000_000;

    expect(
      translateQueueUpdate(
        {
          type: "queue_update",
          steering: [],
          followUp: [],
          ordered: [queued({ queuedId: "q_1", text: "one", mode: "steer" })],
        },
        sessionID,
        { now: () => now },
      ),
    ).toEqual([
      {
        type: "session.inbox.enqueued",
        created: now,
        data: {
          sessionID,
          inboxID: "q_1",
          item: { type: "user", payload: { text: "one" }, delivery: "steer" },
        },
      },
    ]);

    const second = translateQueueUpdate(
      {
        type: "queue_update",
        steering: [],
        followUp: [],
        ordered: [
          queued({ queuedId: "q_1", text: "one", mode: "followUp" }),
          queued({ queuedId: "q_2", text: "two", mode: "steer", enqueueOrder: 2 }),
        ],
      },
      sessionID,
      { now: () => now },
    );
    expect(second).toEqual([
      {
        type: "session.inbox.delivery.changed",
        created: now,
        data: { sessionID, inboxID: "q_1", delivery: "queue" },
      },
      {
        type: "session.inbox.enqueued",
        created: now,
        data: {
          sessionID,
          inboxID: "q_2",
          item: { type: "user", payload: { text: "two" }, delivery: "steer" },
        },
      },
    ]);

    const third = translateQueueUpdate(
      { type: "queue_update", steering: [], followUp: [], ordered: [] },
      sessionID,
      { now: () => now },
    );
    expect(third).toEqual([
      { type: "session.inbox.cancelled", created: now, data: { sessionID, inboxID: "q_1" } },
      { type: "session.inbox.cancelled", created: now, data: { sessionID, inboxID: "q_2" } },
    ]);
  });

  test("streams events to the emit sink and ignores frames without an ordered list", () => {
    const seen: string[] = [];
    const events = translateQueueUpdate(
      { type: "queue_update", steering: ["focus"], followUp: [] },
      "durable-1",
      { emit: (event) => seen.push(`${event.type}:${event.data.inboxID}`), now: () => 1 },
    );

    expect(events).toEqual([]);
    expect(seen).toEqual([]);
    expect(snapshotQueue("durable-1")).toBeUndefined();
  });

  test("drops malformed entries instead of emitting half-read events", () => {
    const events = translateQueueUpdate(
      { type: "queue_update", ordered: [{ queuedId: "", text: "x", mode: "steer" }, { queuedId: "q_1" }] },
      "durable-1",
      { now: () => 5 },
    );

    expect(events).toEqual([]);
    expect(snapshotQueue("durable-1")).toEqual([]);
  });
});
