import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertErrorEnvelope, validateResponse } from "../../src/contract/validate";
import { createEventBus, type BridgeEvent, type EventBus, type EventSubscription } from "../../src/http/events";
import {
  formFrameStats,
  handleFormCancel,
  handleFormCreate,
  handleFormList,
  handleFormReply,
  handleSessionFormList,
  listPendingForms,
  onDialogFrame,
  onQuestionFrame,
  resetForms,
  setFormEventBus,
  setFormTransport,
  type FormInfo,
  type FormTransport,
  type PendingForm,
} from "../../src/http/handlers/form";
import type { SenpiExtensionUIResponse } from "../../src/senpi/transport";

const SESSION_ONE = "ses_one";
const SESSION_TWO = "ses_two";
const CONTRACT_EVENTS = join(import.meta.dir, "..", "..", "contracts", "senpi", "events.jsonl");

class FakeFormTransport implements FormTransport {
  readonly responses: SenpiExtensionUIResponse[] = [];
  sessionId: string | undefined;

  async sendExtensionUIResponse(response: SenpiExtensionUIResponse): Promise<void> {
    this.responses.push(response);
  }
}

type RecordedFrame = { frame: Record<string, unknown> };

function recordedUiRequest(method: string): Record<string, unknown> {
  const lines = readFileSync(CONTRACT_EVENTS, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const { frame } = JSON.parse(line) as RecordedFrame;
    if (frame.type === "extension_ui_request" && frame.method === method) return frame;
  }
  throw new Error(`no recorded extension_ui_request with method ${method}`);
}

function questionFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id: "uuid-q2",
    method: "question",
    requestId: "ask-user-2",
    toolCallId: "call-q2",
    waitForAnswer: true,
    questions: [
      {
        id: "db",
        header: "Database",
        question: "Which database should I use?",
        options: [
          { label: "PostgreSQL", description: "Relational" },
          { label: "SQLite", description: "Embedded" },
        ],
        multiSelect: false,
      },
      {
        id: "features",
        header: "Features",
        question: "Which features do you need?",
        options: [{ label: "Indexes" }, { label: "WAL" }],
        multiSelect: true,
      },
    ],
    ...overrides,
  };
}

function dialogFrame(method: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "extension_ui_request", id: `uuid-${method}`, method, ...overrides };
}

function urlOf(path: string): URL {
  return new URL(`http://bridge.test${path}`);
}

function createForm(sessionID: string, body: unknown): Promise<Response> {
  const path = `/api/session/${sessionID}/form`;
  return handleFormCreate(
    new Request(urlOf(path), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    urlOf(path),
  );
}

function listSessionForms(sessionID = SESSION_ONE): Promise<Response> {
  const path = `/api/session/${sessionID}/form`;
  return handleSessionFormList(new Request(urlOf(path)), urlOf(path));
}

function listForms(query = ""): Promise<Response> {
  const path = `/api/form${query}`;
  return handleFormList(new Request(urlOf(path)), urlOf(path));
}

function replyForm(formID: string, body: unknown, sessionID = SESSION_ONE): Promise<Response> {
  const path = `/api/session/${sessionID}/form/${formID}/reply`;
  return handleFormReply(
    new Request(urlOf(path), {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
    urlOf(path),
  );
}

function cancelForm(formID: string, sessionID = SESSION_ONE): Promise<Response> {
  const path = `/api/session/${sessionID}/form/${formID}`;
  return handleFormCancel(new Request(urlOf(path), { method: "DELETE" }), urlOf(path));
}

async function listed(sessionID = SESSION_ONE): Promise<FormInfo[]> {
  const response = await listSessionForms(sessionID);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: FormInfo[] }).data;
}

async function createdID(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: FormInfo }).data.id;
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

function formEventBus(): EventBus {
  const bus = createEventBus({ capacity: 32 });
  setFormEventBus(bus);
  return bus;
}

function assertFormContract(form: unknown): void {
  expect(validateResponse("form.info", form)).toEqual({ ok: true });
}

async function fileQuestion(frame: unknown = questionFrame(), transport = new FakeFormTransport()): Promise<PendingForm> {
  setFormTransport(transport);
  const filed = onQuestionFrame(frame, SESSION_ONE);
  if (filed === undefined) throw new Error("the question frame was not filed");
  return filed;
}

beforeEach(() => {
  resetForms();
  setFormTransport(undefined);
  setFormEventBus(undefined);
});

afterEach(() => {
  resetForms();
  setFormTransport(undefined);
  setFormEventBus(undefined);
});

describe("form injection endpoint", () => {
  test("create files a pending form and publishes form.created", async () => {
    const bus = formEventBus();
    const subscription = bus.subscribe({ types: ["form.created"] });

    const response = await createForm(SESSION_ONE, {
      title: "Attention",
      fields: [
        { key: "name", type: "string", title: "Name", required: true },
        { key: "tags", type: "multiselect", options: [{ value: "a", label: "A" }] },
      ],
    });
    expect(response.status).toBe(200);
    const info = ((await response.json()) as { data: FormInfo }).data;
    expect(info.id.startsWith("frm_")).toBe(true);
    expect(info.sessionID).toBe(SESSION_ONE);
    expect(info.title).toBe("Attention");
    assertFormContract(info);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.type).toBe("form.created");
    expect(event!.data).toEqual({ form: info });
    expect(await listed()).toEqual([info]);

    const global = await listForms();
    expect(global.status).toBe(200);
    const body = (await global.json()) as { location: { directory: string }; data: FormInfo[] };
    expect(body.location.directory).toBe(process.cwd());
    expect(body.data).toEqual([info]);
  });

  test("create rejects a payload without a title, without fields, or with an unknown field type", async () => {
    const noTitle = await createForm(SESSION_ONE, { fields: [{ key: "a", type: "string" }] });
    expect(noTitle.status).toBe(400);
    expect(((await noTitle.json()) as { _tag: string })._tag).toBe("InvalidRequestError");

    const noFields = await createForm(SESSION_ONE, { title: "T", fields: [] });
    expect(noFields.status).toBe(400);
    expect(((await noFields.json()) as { _tag: string })._tag).toBe("InvalidRequestError");

    const badType = await createForm(SESSION_ONE, { title: "T", fields: [{ key: "a", type: "date" }] });
    expect(badType.status).toBe(400);

    const duplicateKeys = await createForm(SESSION_ONE, {
      title: "T",
      fields: [
        { key: "a", type: "string" },
        { key: "a", type: "boolean" },
      ],
    });
    expect(duplicateKeys.status).toBe(400);

    expect(await listed()).toEqual([]);
  });

  test("the session list is scoped and the global list keeps insertion order", async () => {
    const first = await createdID(await createForm(SESSION_ONE, { title: "One", fields: [{ key: "a", type: "string" }] }));
    const second = await createdID(await createForm(SESSION_ONE, { title: "Two", fields: [{ key: "b", type: "boolean" }] }));
    await createForm(SESSION_TWO, { title: "Other", fields: [{ key: "c", type: "number" }] });
    const third = (await (await listForms()).json() as { data: FormInfo[] }).data.find((form) => form.title === "Other")!.id;

    expect((await listed(SESSION_ONE)).map((form) => form.id)).toEqual([first, second]);
    expect((await listed(SESSION_TWO)).map((form) => form.title)).toEqual(["Other"]);

    const body = (await (await listForms()).json()) as { data: FormInfo[] };
    expect(body.data.map((form) => form.id)).toEqual([first, second, third]);
  });

  test("a reply to an injected form sends nothing on the wire but publishes form.replied", async () => {
    const bus = formEventBus();
    const transport = new FakeFormTransport();
    setFormTransport(transport);
    const formID = await createdID(await createForm(SESSION_ONE, { title: "T", fields: [{ key: "name", type: "string" }] }));
    const subscription = bus.subscribe({ types: ["form.replied"] });

    const response = await replyForm(formID, { answer: { name: "Ada" } });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([]);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.data).toEqual({ id: formID, sessionID: SESSION_ONE, answer: { name: "Ada" } });
    expect(await listed()).toEqual([]);

    const repeat = await replyForm(formID, { answer: { name: "Ada" } });
    expect(repeat.status).toBe(409);
    const body = (await repeat.json()) as { _tag: string; id: string; message: string };
    assertErrorEnvelope(body);
    expect(body._tag).toBe("FormAlreadySettledError");
    expect(body.id).toBe(formID);
  });
});

describe("real question frames", () => {
  test("the recorded question dialog becomes a form mirroring questions[]", async () => {
    const bus = formEventBus();
    const subscription = bus.subscribe({ types: ["form.created"] });
    const transport = new FakeFormTransport();
    const filed = await fileQuestion(recordedUiRequest("question"), transport);

    expect(filed.uiRequestId).toBe("uuid-q1");
    expect(filed.method).toBe("question");
    expect(filed.fields).toEqual([
      {
        key: "q0",
        title: "Database",
        description: "Which database should I use?",
        type: "string",
        options: [
          { value: "PostgreSQL", label: "PostgreSQL", description: "Relational" },
          { value: "SQLite", label: "SQLite", description: "Embedded" },
        ],
        custom: true,
      },
    ]);
    expect(filed.metadata).toEqual({ kind: "question", requestId: "ask-user-1", toolCallId: "call_abc123" });

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.data).toEqual({ form: expect.objectContaining({ id: filed.id }) });
    const info = (event!.data as { form: FormInfo }).form;
    assertFormContract(info);
    expect(await listed()).toEqual([info]);
    expect(transport.responses).toEqual([]);
  });

  test("a multi-question reply maps back positionally onto questions[].id", async () => {
    const bus = formEventBus();
    const transport = new FakeFormTransport();
    const filed = await fileQuestion(questionFrame(), transport);
    expect(filed.fields.map((field) => field.key)).toEqual(["q0", "q1"]);
    expect(filed.fields.map((field) => field.type)).toEqual(["string", "multiselect"]);
    const subscription = bus.subscribe({ types: ["form.replied"] });

    const answer = { q1: ["Indexes", "WAL"], q0: "PostgreSQL" };
    const response = await replyForm(filed.id, { answer });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([
      {
        type: "extension_ui_response",
        id: "uuid-q2",
        uiRequestId: "uuid-q2",
        answers: {
          db: { selected: ["PostgreSQL"] },
          features: { selected: ["Indexes", "WAL"] },
        },
      },
    ]);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.data).toEqual({ id: filed.id, sessionID: SESSION_ONE, answer });
    expect(await listed()).toEqual([]);
  });

  test("a partial answer maps only the questions it answers", async () => {
    const transport = new FakeFormTransport();
    const filed = await fileQuestion(questionFrame(), transport);

    const response = await replyForm(filed.id, { answer: { q1: ["WAL"] } });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([
      {
        type: "extension_ui_response",
        id: "uuid-q2",
        uiRequestId: "uuid-q2",
        answers: { features: { selected: ["WAL"] } },
      },
    ]);
  });

  test("an answer that leaves every question unanswered is refused and keeps the form pending", async () => {
    const transport = new FakeFormTransport();
    const filed = await fileQuestion(questionFrame(), transport);

    const response = await replyForm(filed.id, { answer: {} });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { _tag: string; id: string; message: string };
    assertErrorEnvelope(body);
    expect(body._tag).toBe("FormInvalidAnswerError");
    expect(body.id).toBe(filed.id);
    expect(transport.responses).toEqual([]);
    expect((await listed()).map((form) => form.id)).toEqual([filed.id]);
  });
});

describe("dialog frames", () => {
  test("an input frame becomes a one-field string form and answers with value", async () => {
    const transport = new FakeFormTransport();
    setFormTransport(transport);
    const filed = onDialogFrame(
      dialogFrame("input", { title: "Feedback", placeholder: "Why?" }),
      SESSION_ONE,
    );
    expect(filed).toBeDefined();
    expect(filed!.fields).toEqual([{ key: "value", type: "string", title: "Feedback", placeholder: "Why?" }]);

    const response = await replyForm(filed!.id, { answer: { value: "because" } });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([
      { type: "extension_ui_response", id: "uuid-input", uiRequestId: "uuid-input", value: "because" },
    ]);
  });

  test("a confirm frame answers with confirmed", async () => {
    const transport = new FakeFormTransport();
    setFormTransport(transport);
    const filed = onDialogFrame(dialogFrame("confirm", { title: "Run it?", message: "This writes a file" }), SESSION_ONE);
    expect(filed).toBeDefined();
    expect(filed!.fields).toEqual([
      { key: "confirmed", type: "boolean", title: "Run it?", description: "This writes a file" },
    ]);

    const response = await replyForm(filed!.id, { answer: { confirmed: false } });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([
      { type: "extension_ui_response", id: "uuid-confirm", uiRequestId: "uuid-confirm", confirmed: false },
    ]);
  });

  test("a select frame carries its options and answers with value", async () => {
    const transport = new FakeFormTransport();
    setFormTransport(transport);
    const filed = onDialogFrame(dialogFrame("select", { title: "Pick a colour", options: ["red", "blue"] }), SESSION_ONE);
    expect(filed).toBeDefined();
    expect(filed!.fields).toEqual([
      {
        key: "value",
        type: "string",
        title: "Pick a colour",
        options: [
          { value: "red", label: "red" },
          { value: "blue", label: "blue" },
        ],
        custom: true,
      },
    ]);

    const response = await replyForm(filed!.id, { answer: { value: "blue" } });
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([
      { type: "extension_ui_response", id: "uuid-select", uiRequestId: "uuid-select", value: "blue" },
    ]);
  });

  test("a permission prompt is not filed as a form and an answer type mismatch is refused", async () => {
    setFormTransport(new FakeFormTransport());
    expect(onDialogFrame(recordedUiRequest("select"), SESSION_ONE)).toBeUndefined();
    expect(onQuestionFrame(recordedUiRequest("select"), SESSION_ONE)).toBeUndefined();
    expect(formFrameStats()).toEqual({ filed: 0, droppedStatus: 0 });

    const filed = onDialogFrame(dialogFrame("confirm", { title: "Sure?" }), SESSION_ONE);
    const response = await replyForm(filed!.id, { answer: { confirmed: "yes" } });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { _tag: string })._tag).toBe("FormInvalidAnswerError");
    expect((await listed()).map((form) => form.id)).toEqual([filed!.id]);
  });
});

describe("form cancel", () => {
  test("cancel answers the frame with cancelled:true and publishes form.cancelled", async () => {
    const bus = formEventBus();
    const transport = new FakeFormTransport();
    const filed = await fileQuestion(questionFrame(), transport);
    const subscription = bus.subscribe({ types: ["form.cancelled"] });

    const response = await cancelForm(filed.id);
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([
      {
        type: "extension_ui_response",
        id: "uuid-q2",
        uiRequestId: "uuid-q2",
        cancelled: true,
      },
    ]);

    const [event] = await readEvents(subscription, 1);
    subscription.close();
    expect(event!.type).toBe("form.cancelled");
    expect(event!.data).toEqual({ id: filed.id, sessionID: SESSION_ONE });
    expect(await listed()).toEqual([]);

    const repeat = await cancelForm(filed.id);
    expect(repeat.status).toBe(409);
    expect(((await repeat.json()) as { _tag: string })._tag).toBe("FormAlreadySettledError");
  });

  test("cancelling an injected form sends nothing and still settles it", async () => {
    const transport = new FakeFormTransport();
    setFormTransport(transport);
    const formID = await createdID(await createForm(SESSION_ONE, { title: "T", fields: [{ key: "a", type: "string" }] }));

    const response = await cancelForm(formID);
    expect(response.status).toBe(204);
    expect(transport.responses).toEqual([]);
    expect(await listed()).toEqual([]);
  });

  test("an unknown form id answers 404 FormNotFoundError", async () => {
    const response = await cancelForm("frm_missing");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { _tag: string; id: string; message: string };
    assertErrorEnvelope(body);
    expect(body._tag).toBe("FormNotFoundError");
    expect(body.id).toBe("frm_missing");
  });
});

describe("status frames and failures", () => {
  test("status frames are dropped and counted", async () => {
    const frames = [
      { type: "extension_ui_request", id: "n", method: "notify", message: "hi" },
      { type: "extension_ui_request", id: "s", method: "setStatus", statusKey: "k", statusText: "v" },
      { type: "extension_ui_request", id: "w", method: "setWidget", widgetKey: "k", widgetLines: [] },
      { type: "extension_ui_request", id: "t", method: "setTitle", title: "T" },
    ];
    for (const frame of frames) {
      expect(onQuestionFrame(frame, SESSION_ONE)).toBeUndefined();
      expect(onDialogFrame(frame, SESSION_ONE)).toBeUndefined();
    }
    expect(formFrameStats()).toEqual({ filed: 0, droppedStatus: 8 });
    expect(await listed()).toEqual([]);
    expect(listPendingForms()).toEqual([]);
  });

  test("a question frame with no questions is not filed", async () => {
    setFormTransport(new FakeFormTransport());
    expect(onQuestionFrame(questionFrame({ questions: [] }), SESSION_ONE)).toBeUndefined();
    expect(onQuestionFrame(questionFrame({ questions: [{ id: "" }] }), SESSION_ONE)).toBeUndefined();
    expect(await listed()).toEqual([]);
  });

  test("a frame without an id or a session is not filed", async () => {
    setFormTransport(new FakeFormTransport());
    expect(onQuestionFrame(questionFrame({ id: undefined }), SESSION_ONE)).toBeUndefined();
    expect(onQuestionFrame(questionFrame())).toBeUndefined();
    expect(onDialogFrame(dialogFrame("input", { id: undefined, title: "T" }), SESSION_ONE)).toBeUndefined();
    expect(await listed()).toEqual([]);
  });

  test("a form filed by another session is not answerable", async () => {
    const transport = new FakeFormTransport();
    const filed = await fileQuestion(questionFrame(), transport);

    const response = await replyForm(filed.id, { answer: { q0: "SQLite" } }, SESSION_TWO);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { _tag: string })._tag).toBe("FormNotFoundError");
    expect(transport.responses).toEqual([]);
    expect((await listed()).map((form) => form.id)).toEqual([filed.id]);
  });

  test("replying without a transport answers 503 and keeps the frame-backed form pending", async () => {
    const filed = await fileQuestion(questionFrame(), new FakeFormTransport());
    setFormTransport(undefined);

    const response = await replyForm(filed.id, { answer: { q0: "SQLite" } });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { _tag: string })._tag).toBe("ServiceUnavailableError");
    expect((await listed()).map((form) => form.id)).toEqual([filed.id]);
  });

  test("an answer naming an unknown field is refused and keeps the form pending", async () => {
    const transport = new FakeFormTransport();
    const filed = await fileQuestion(questionFrame(), transport);

    const response = await replyForm(filed.id, { answer: { q9: "x" } });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { _tag: string; message: string };
    expect(body._tag).toBe("FormInvalidAnswerError");
    expect(body.message).toBe("Unknown form field: q9");
    expect(transport.responses).toEqual([]);
  });
});
