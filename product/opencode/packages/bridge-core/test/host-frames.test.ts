import { describe, expect, test } from "bun:test";

import { decodeHostFrame, encodeHostResponseFrame } from "../src/host-frames.ts";

const permissionPrompt = {
  type: "extension_ui_request",
  id: "ui-permission-1",
  method: "select",
  title: "Permission required: read\n\nPath: /workspace/a.txt\n\nPatterns:\n  - /workspace/a.txt",
  options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
  toolCallId: "call-a",
};

const questionPrompt = {
  type: "extension_ui_request",
  id: "ui-question-1",
  method: "question",
  requestId: "ask-user-1",
  toolCallId: "ask-user-1",
  waitForAnswer: true,
  questions: [
    {
      id: "q1",
      header: "Database",
      question: "Which database should I use?",
      options: [
        { label: "PostgreSQL", description: "Relational" },
        { label: "SQLite" },
      ],
      multiSelect: false,
    },
  ],
  raisedBy: "socket-1",
  timeout: 1800000,
  askedAtMs: 1718000000000,
  deadlineAtMs: 1718001800000,
  remainingMs: 1799500,
};

const questionResolved = {
  type: "question_resolved",
  id: "ui-question-1",
  requestId: "ask-user-1",
  toolCallId: "ask-user-1",
  outcome: "answered",
  resolvedBy: "rpc_connection",
  answers: { q1: { selected: ["PostgreSQL"] } },
  comment: "",
  unanswered: [],
};

function decoded(frame: unknown) {
  const result = decodeHostFrame(frame);
  if (!result.ok) throw new Error("expected a decoded frame, got: " + result.reason);
  return result.frame;
}

function rejected(frame: unknown) {
  const result = decodeHostFrame(frame);
  if (result.ok) throw new Error("expected a rejection, got a decoded " + result.frame.type);
  return result.reason;
}

describe("decodeHostFrame: permission lifecycle", () => {
  test("decodes the select prompt a permission ask writes, keeping the ids the dialog carries", () => {
    const frame = decoded(JSON.parse(JSON.stringify(permissionPrompt)));
    if (frame.type !== "extension_ui_request" || frame.method !== "select")
      throw new Error("lost the select discriminator");
    expect(frame.title).toBe(permissionPrompt.title);
    expect([...frame.options]).toEqual(permissionPrompt.options);
    expect(frame.toolCallId).toBe("call-a");
    expect(frame.id).toBe("ui-permission-1");
  });

  test("decodes the value answer a client echoes and keeps both correlation ids", () => {
    const frame = decoded({
      type: "extension_ui_response",
      id: "answer-1",
      uiRequestId: "ui-permission-1",
      value: "Allow once",
    });
    if (frame.type !== "extension_ui_response" || !("value" in frame))
      throw new Error("expected a value response");
    expect(frame.value).toBe("Allow once");
    expect(frame.uiRequestId).toBe("ui-permission-1");
    expect(frame.id).toBe("answer-1");
  });

  test("decodes the short-form value answer whose id is the request id", () => {
    const frame = decoded({ type: "extension_ui_response", id: "ui-permission-1", value: "Deny" });
    if (frame.type !== "extension_ui_response" || !("value" in frame)) throw new Error("expected a value response");
    expect(frame.id).toBe("ui-permission-1");
    expect(frame.value).toBe("Deny");
  });

  test("decodes a cancelled dialog", () => {
    const frame = decoded({ type: "extension_ui_response", id: "ui-permission-1", cancelled: true });
    if (frame.type !== "extension_ui_response" || !("cancelled" in frame)) throw new Error("expected a cancellation");
    expect(frame.cancelled).toBe(true);
    expect(frame.id).toBe("ui-permission-1");
  });
});

describe("decodeHostFrame: question lifecycle", () => {
  test("decodes a structured question with its option descriptions", () => {
    const frame = decoded(JSON.parse(JSON.stringify(questionPrompt)));
    if (frame.type !== "extension_ui_request" || frame.method !== "question") throw new Error("lost the question");
    expect(frame.requestId).toBe("ask-user-1");
    expect(frame.questions.length).toBe(1);
    expect(frame.questions[0].options[0].description).toBe("Relational");
    expect(frame.deadlineAtMs).toBe(1718001800000);
  });

  test("decodes the answers frame that settles a question", () => {
    const frame = decoded({
      type: "extension_ui_response",
      id: "ui-question-1",
      answers: { q1: { selected: ["PostgreSQL"] } },
      comment: "",
    });
    if (frame.type !== "extension_ui_response" || !("answers" in frame)) throw new Error("expected answers");
    expect([...frame.answers.q1.selected]).toEqual(["PostgreSQL"]);
    expect(frame.comment).toBe("");
  });

  test("decodes the comment-only form of a question answer", () => {
    const frame = decoded({ type: "extension_ui_response", id: "ui-question-1", answers: {}, comment: "prefer sqlite" });
    if (frame.type !== "extension_ui_response" || !("answers" in frame)) throw new Error("expected answers");
    expect(frame.comment).toBe("prefer sqlite");
  });

  test("decodes the question_resolved broadcast with its outcome and unanswered list", () => {
    const frame = decoded(JSON.parse(JSON.stringify(questionResolved)));
    if (frame.type !== "question_resolved") throw new Error("lost the question_resolved type");
    expect(frame.outcome).toBe("answered");
    expect(frame.resolvedBy).toBe("rpc_connection");
    expect([...frame.unanswered]).toEqual([]);
  });

  test("keeps the routing sessionId a multi-session host adds", () => {
    const frame = decoded({ ...permissionPrompt, sessionId: "session-1" });
    expect(frame.sessionId).toBe("session-1");
  });
});

describe("decodeHostFrame: rejection", () => {
  test("rejects the OpenCode permission event by name instead of decoding it", () => {
    const reason = rejected({
      id: "evt_1",
      created: 1731990000000,
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_1" },
    });
    expect(reason).toBe("unknown host frame type: permission.asked");
  });

  test("rejects an OpenCode form event by name", () => {
    expect(rejected({ type: "form.created", data: { form: {} } })).toBe("unknown host frame type: form.created");
  });

  test("rejects a fire-and-forget method without guessing its payload", () => {
    expect(rejected({ type: "extension_ui_request", id: "ui-1", method: "notify", message: "hi" })).toBe(
      "extension_ui_request method not decoded: notify",
    );
  });

  test("rejects a select prompt missing its options", () => {
    const reason = rejected({ type: "extension_ui_request", id: "ui-1", method: "select", title: "Permission required" });
    expect(reason).toContain("options");
  });

  test("rejects a select prompt whose title is not a string", () => {
    expect(rejected({ ...permissionPrompt, title: 42 })).toContain("Expected string");
  });

  test("rejects a question whose questions array is absent", () => {
    const { questions: _questions, ...withoutQuestions } = questionPrompt;
    expect(rejected(withoutQuestions)).toContain("questions");
  });

  test("rejects a cancellation that is not true", () => {
    expect(rejected({ type: "extension_ui_response", id: "ui-1", cancelled: false })).toContain("Expected true");
  });

  test("rejects a question answer whose selected list is not an array", () => {
    const reason = rejected({
      type: "extension_ui_response",
      id: "ui-question-1",
      answers: { q1: { selected: "PostgreSQL" } },
    });
    expect(reason).toContain("selected");
  });

  test("rejects a response carrying none of value, answers or cancelled", () => {
    expect(rejected({ type: "extension_ui_response", id: "ui-1" })).toBe(
      "extension_ui_response has none of value, answers or cancelled",
    );
  });

  test("rejects a question_resolved with an outcome the host never writes", () => {
    expect(rejected({ ...questionResolved, outcome: "deferred" })).toContain("outcome");
  });

  test("rejects a frame that is not an object and never throws", () => {
    expect(() => decodeHostFrame(JSON.parse('"permission.asked"'))).not.toThrow();
    expect(rejected(JSON.parse('"permission.asked"'))).toBe("host frame has no string type");
  });

  test("decodes the confirm, input and editor request frames", () => {
    const confirm = decodeHostFrame({ type: "extension_ui_request", id: "ui-c", method: "confirm", title: "Confirm", message: "Proceed?" });
    expect(confirm.ok).toBe(true);
    const input = decodeHostFrame({ type: "extension_ui_request", id: "ui-i", method: "input", title: "Name", placeholder: "type here", secret: false });
    expect(input.ok).toBe(true);
    const editor = decodeHostFrame({ type: "extension_ui_request", id: "ui-e", method: "editor", title: "Edit", prefill: "text" });
    expect(editor.ok).toBe(true);
    if (editor.ok && editor.frame.method === "editor") expect(editor.frame.prefill).toBe("text");
  });

  test("rejects a confirm frame without its message rather than inventing one", () => {
    const result = decodeHostFrame({ type: "extension_ui_request", id: "ui-c", method: "confirm", title: "Confirm" });
    expect(result.ok).toBe(false);
  });

  test("decodes and encodes the confirmed response", () => {
    const decoded = decodeHostFrame({ type: "extension_ui_response", id: "r1", uiRequestId: "ui-c", confirmed: true });
    expect(decoded.ok).toBe(true);
    const encoded = encodeHostResponseFrame({ id: "r2", uiRequestId: "ui-c", answer: { kind: "confirmed", confirmed: false } });
    expect(encoded.ok).toBe(true);
    if (encoded.ok) expect(encoded.frame).toEqual({ type: "extension_ui_response", id: "r2", uiRequestId: "ui-c", confirmed: false });
  });

  test("an answer to a routed dialog carries the session tag the host scopes it by", () => {
    const encoded = encodeHostResponseFrame({
      id: "r3",
      uiRequestId: "ui-c",
      sessionId: "rpc-1",
      answer: { kind: "value", value: "Allow once" },
    });
    expect(encoded.ok).toBe(true);
    if (encoded.ok)
      expect(encoded.frame).toEqual({
        type: "extension_ui_response",
        id: "r3",
        uiRequestId: "ui-c",
        sessionId: "rpc-1",
        value: "Allow once",
      });
  });
});
