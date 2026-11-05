import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertErrorEnvelope, validateResponse } from "../../src/contract/validate";
import { createEventBus, type BridgeEvent, type EventBus, type EventSubscription } from "../../src/http/events";
import {
  DEFAULT_PERMISSION_OPTIONS,
  handlePermissionCreate,
  handlePermissionList,
  handlePermissionReply,
  listSavedPermissions,
  onUiRequest,
  resetPermissions,
  setPermissionEventBus,
  setPermissionTransport,
  type PendingPermission,
  type PermissionRequest,
  type PermissionTransport,
} from "../../src/http/handlers/permission";
import type { SenpiExtensionUIResponse } from "../../src/senpi/transport";

const SESSION_ONE = "ses_one";
const SESSION_TWO = "ses_two";
const CONTRACT_EVENTS = join(import.meta.dir, "..", "..", "contracts", "senpi", "events.jsonl");

class FakePermissionTransport implements PermissionTransport {
  readonly responses: SenpiExtensionUIResponse[] = [];
  sessionId: string | undefined;

  async sendExtensionUIResponse(response: SenpiExtensionUIResponse): Promise<void> {
    this.responses.push(response);
  }
}

function noTransport(): PermissionTransport {
  return {};
}

function recordedPermissionFrame(): Record<string, unknown> {
  const lines = readFileSync(CONTRACT_EVENTS, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const { frame } = JSON.parse(line) as { frame: Record<string, unknown> };
    if (frame.type === "extension_ui_request" && frame.method === "select") return frame;
  }
  throw new Error("no recorded permission frame");
}

function feedbackFrame(toolCallId = "call-a"): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id: "uuid-feedback",
    method: "input",
    title: "Feedback",
    placeholder: "Why are you denying this permission? (optional)",
    toolCallId,
  };
}

function urlOf(path: string): URL {
  return new URL(`http://bridge.test${path}`);
}

function createPermission(sessionID: string, body: unknown): Promise<Response> {
  const path = `/api/session/${sessionID}/permission`;
  return handlePermissionCreate(
    new Request(urlOf(path), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    urlOf(path),
  );
}

function listPermissions(sessionID = SESSION_ONE): Promise<Response> {
  const path = `/api/session/${sessionID}/permission`;
  return handlePermissionList(new Request(urlOf(path)), urlOf(path));
}

function replyPermission(sessionID: string, requestID: string, body: unknown): Promise<Response> {
  const path = `/api/session/${sessionID}/permission/${requestID}/reply`;
  return handlePermissionReply(
    new Request(urlOf(path), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    urlOf(path),
  );
}

async function listed(sessionID = SESSION_ONE): Promise<PermissionRequest[]> {
  const response = await listPermissions(sessionID);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: PermissionRequest[] }).data;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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

async function readEvents(subscription: EventSubscription, count: number): Promise<BridgeEvent[]> {
  const reader = subscription.stream.getReader();
  const events: BridgeEvent[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const result = await withTimeout(reader.read(), 1000, `timed out waiting for event ${index + 1}`);
      if (result.done || result.value === undefined) throw new Error(`event stream closed after ${index} events`);
      events.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return events;
}

function permissionEventBus(): EventBus {
  const bus = createEventBus({ capacity: 32 });
  setPermissionEventBus(bus);
  return bus;
}

async function fileFrame(transport: FakePermissionTransport, sessionID = SESSION_ONE): Promise<PendingPermission> {
  setPermissionTransport(transport);
  const filed = await onUiRequest(recordedPermissionFrame(), sessionID);
  if (filed === undefined) throw new Error("the recorded permission frame was not filed");
  return filed;
}

function assertPermissionContract(row: unknown): void {
  expect(validateResponse("permission.request", row)).toEqual({ ok: true });
}

beforeEach(() => {
  resetPermissions();
  setPermissionTransport(undefined);
  setPermissionEventBus(undefined);
});

afterEach(() => {
  resetPermissions();
  setPermissionTransport(undefined);
  setPermissionEventBus(undefined);
});

describe("permission injection endpoint", () => {
  test("create files a pending request and publishes permission.asked", async () => {
    const bus = permissionEventBus();
    const subscription = bus.subscribe({ types: ["permission.asked"] });

    const response = await createPermission(SESSION_ONE, {
      action: "ulw.review",
      resources: ["/tmp/project/README.md"],
      save: ["/tmp/project/*"],
      metadata: { origin: "qa" },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string; effect: string } };
    expect(body.data.effect).toBe("ask");
    expect(body.data.id.startsWith("per_")).toBe(true);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.type).toBe("permission.asked");
    const asked = event!.data as PermissionRequest;
    expect(asked).toEqual({
      id: body.data.id,
      sessionID: SESSION_ONE,
      action: "ulw.review",
      resources: ["/tmp/project/README.md"],
      save: ["/tmp/project/*"],
      metadata: { origin: "qa" },
    });
    assertPermissionContract(asked);
    expect(await listed()).toEqual([asked]);
  });

  test("create rejects a payload without an action or with non-string resources", async () => {
    const missingAction = await createPermission(SESSION_ONE, { resources: [] });
    expect(missingAction.status).toBe(400);
    expect(((await missingAction.json()) as { _tag: string })._tag).toBe("InvalidRequestError");

    const badResources = await createPermission(SESSION_ONE, { action: "read", resources: [1] });
    expect(badResources.status).toBe(400);
    expect(((await badResources.json()) as { _tag: string })._tag).toBe("InvalidRequestError");

    expect(await listed()).toEqual([]);
  });

  test("the list is scoped to the session and keeps insertion order", async () => {
    const first = await createPermission(SESSION_ONE, { action: "read", resources: ["/a"] });
    const second = await createPermission(SESSION_ONE, { action: "edit", resources: ["/b"] });
    await createPermission(SESSION_TWO, { action: "bash", resources: ["ls"] });
    const firstID = ((await first.json()) as { data: { id: string } }).data.id;
    const secondID = ((await second.json()) as { data: { id: string } }).data.id;

    expect((await listed(SESSION_ONE)).map((row) => row.id)).toEqual([firstID, secondID]);
    expect((await listed(SESSION_TWO)).map((row) => row.action)).toEqual(["bash"]);
  });

  test("a reply to an injected request sends nothing on the wire but publishes permission.replied", async () => {
    const bus = permissionEventBus();
    const transport = new FakePermissionTransport();
    setPermissionTransport(transport);
    const created = (await (
      await createPermission(SESSION_ONE, { action: "read", resources: ["/a"], save: ["/a"] })
    ).json()) as { data: { id: string } };
    const subscription = bus.subscribe({ types: ["permission.replied"] });

    const response = await replyPermission(SESSION_ONE, created.data.id, { decision: "always" });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([]);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.data).toEqual({ sessionID: SESSION_ONE, requestID: created.data.id, reply: "always" });
    expect(await listed()).toEqual([]);
    expect(listSavedPermissions(SESSION_ONE)).toEqual([
      {
        sessionID: SESSION_ONE,
        action: "read",
        resource: "/a",
        savedAt: expect.any(Number) as unknown as number,
      },
    ]);
  });
});

describe("real permission frames", () => {
  test("a recorded frame is filed with its call id and prompt options", async () => {
    const bus = permissionEventBus();
    const subscription = bus.subscribe({ types: ["permission.asked"] });
    const transport = new FakePermissionTransport();
    setPermissionTransport(transport);
    const filed = await onUiRequest(recordedPermissionFrame(), SESSION_ONE);
    expect(filed).toBeDefined();
    expect(filed!.uiRequestId).toBe("uuid-3");
    expect(filed!.toolCallId).toBe("call-a");
    expect(filed!.action).toBe("read");
    expect(filed!.resources).toEqual(["/project/a.txt"]);
    expect(filed!.options).toEqual([...DEFAULT_PERMISSION_OPTIONS]);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.type).toBe("permission.asked");
    const asked = event!.data as PermissionRequest;
    expect(asked).toEqual({
      id: filed!.id,
      sessionID: SESSION_ONE,
      action: "read",
      resources: ["/project/a.txt"],
    });
    assertPermissionContract(asked);

    const rows = await listed();
    expect(rows).toEqual([asked]);
    expect(transport.responses).toEqual([]);
  });

  test("a routed frame may name its own session", async () => {
    setPermissionTransport(new FakePermissionTransport());
    const filed = await onUiRequest({ ...recordedPermissionFrame(), sessionId: SESSION_TWO });
    expect(filed?.sessionID).toBe(SESSION_TWO);
    expect((await listed(SESSION_TWO)).map((row) => row.id)).toEqual([filed!.id]);
    expect(await listed(SESSION_ONE)).toEqual([]);
  });

  test("a frame without a session or a frame id is ignored, and non-permission frames never file", async () => {
    setPermissionTransport(new FakePermissionTransport());
    const withoutId = { ...recordedPermissionFrame() };
    delete withoutId.id;
    expect(await onUiRequest(withoutId, SESSION_ONE)).toBeUndefined();
    expect(await onUiRequest(recordedPermissionFrame())).toBeUndefined();
    expect(await onUiRequest({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi" })).toBeUndefined();
    expect(await onUiRequest({ type: "extension_ui_request", id: "q1", method: "question", requestId: "r1", questions: [] })).toBeUndefined();
    expect(await listed()).toEqual([]);
  });

  test("once answers the prompt's first option", async () => {
    const bus = permissionEventBus();
    const transport = new FakePermissionTransport();
    const filed = await fileFrame(transport);
    const subscription = bus.subscribe({ types: ["permission.replied"] });

    const response = await replyPermission(SESSION_ONE, filed.id, { decision: "once" });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([{ type: "extension_ui_response", id: "uuid-3", value: "Allow once" }]);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.data).toEqual({ sessionID: SESSION_ONE, requestID: filed.id, reply: "once" });
    expect(await listed()).toEqual([]);
    expect(listSavedPermissions(SESSION_ONE)).toEqual([]);
  });

  test("always answers the prompt's second option and records the saved patterns", async () => {
    const transport = new FakePermissionTransport();
    const filed = await fileFrame(transport);

    const response = await replyPermission(SESSION_ONE, filed.id, { decision: "always" });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([{ type: "extension_ui_response", id: "uuid-3", value: "Allow always" }]);
    expect(listSavedPermissions(SESSION_ONE).map((entry) => entry.resource)).toEqual(["/project/a.txt"]);
    expect(await listed()).toEqual([]);
  });

  test("reject answers Deny and parks no feedback", async () => {
    const transport = new FakePermissionTransport();
    const filed = await fileFrame(transport);

    const response = await replyPermission(SESSION_ONE, filed.id, { decision: "reject" });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([{ type: "extension_ui_response", id: "uuid-3", value: "Deny" }]);

    await onUiRequest(feedbackFrame(), SESSION_ONE);
    expect(transport.responses).toHaveLength(1);
  });

  test("reject with a message answers the deny branch, then the feedback input carries the text", async () => {
    const transport = new FakePermissionTransport();
    const filed = await fileFrame(transport);

    const response = await replyPermission(SESSION_ONE, filed.id, {
      decision: "reject",
      message: "  do not touch that file  ",
    });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([
      { type: "extension_ui_response", id: "uuid-3", value: "Deny with feedback" },
    ]);

    await onUiRequest(feedbackFrame("call-a"), SESSION_ONE);
    expect(transport.responses).toEqual([
      { type: "extension_ui_response", id: "uuid-3", value: "Deny with feedback" },
      { type: "extension_ui_response", id: "uuid-feedback", value: "do not touch that file" },
    ]);

    await onUiRequest(feedbackFrame("call-a"), SESSION_ONE);
    expect(transport.responses).toHaveLength(2);
  });

  test("a feedback input for another tool call is left alone", async () => {
    const transport = new FakePermissionTransport();
    const filed = await fileFrame(transport);
    await replyPermission(SESSION_ONE, filed.id, { decision: "reject", message: "no" });

    await onUiRequest(feedbackFrame("call-other"), SESSION_ONE);
    expect(transport.responses).toHaveLength(1);
  });
});

describe("reply failures", () => {
  test("an unknown request id answers 404 PermissionNotFoundError", async () => {
    const transport = new FakePermissionTransport();
    setPermissionTransport(transport);
    const response = await replyPermission(SESSION_ONE, "per_missing", { decision: "once" });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { _tag: string; requestID: string; message: string };
    assertErrorEnvelope(body);
    expect(body._tag).toBe("PermissionNotFoundError");
    expect(body.requestID).toBe("per_missing");
    expect(transport.responses).toEqual([]);
  });

  test("a request filed by another session is not answerable", async () => {
    const transport = new FakePermissionTransport();
    const filed = await fileFrame(transport);
    const response = await replyPermission(SESSION_TWO, filed.id, { decision: "once" });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { _tag: string })._tag).toBe("PermissionNotFoundError");
    expect(transport.responses).toEqual([]);
    expect(await listed()).toHaveLength(1);
  });

  test("an unknown decision answers 400 and keeps the request pending", async () => {
    const transport = new FakePermissionTransport();
    const filed = await fileFrame(transport);
    const response = await replyPermission(SESSION_ONE, filed.id, { decision: "maybe" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { _tag: string })._tag).toBe("InvalidRequestError");
    expect(transport.responses).toEqual([]);
    expect((await listed()).map((row) => row.id)).toEqual([filed.id]);
  });

  test("replying without a transport answers 503 and keeps the request pending", async () => {
    setPermissionTransport(noTransport());
    const filed = (await onUiRequest(recordedPermissionFrame(), SESSION_ONE))!;
    const response = await replyPermission(SESSION_ONE, filed.id, { decision: "once" });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { _tag: string })._tag).toBe("ServiceUnavailableError");
    expect((await listed()).map((row) => row.id)).toEqual([filed.id]);
  });
});
