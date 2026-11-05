import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PERMISSION_TITLE_PREFIX,
  classifyUiRequest,
  type PermissionUiRequest,
  type QuestionUiRequest,
} from "../../src/bridge/ui-requests";

const CONTRACT_EVENTS = join(import.meta.dir, "..", "..", "contracts", "senpi", "events.jsonl");

type RecordedFrame = { frame: Record<string, unknown> };

function recordedFrames(): Record<string, unknown>[] {
  return readFileSync(CONTRACT_EVENTS, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as RecordedFrame).frame);
}

function recordedUiRequest(method: string): Record<string, unknown> {
  const frame = recordedFrames().find(
    (candidate) => candidate.type === "extension_ui_request" && candidate.method === method,
  );
  if (frame === undefined) throw new Error(`no recorded extension_ui_request with method ${method}`);
  return frame;
}

function selectFrame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id: "uuid-sel",
    method: "select",
    title: "Pick a colour",
    options: ["red", "blue"],
    ...overrides,
  };
}

describe("classifyUiRequest permissions", () => {
  test("the recorded permission prompt classifies as a permission", () => {
    const result = classifyUiRequest(recordedUiRequest("select"));
    expect(result.kind).toBe("permission");
    if (result.kind !== "permission") throw new Error("unreachable");
    const permission = result.permission as PermissionUiRequest;
    expect(permission.title.startsWith(PERMISSION_TITLE_PREFIX)).toBe(true);
    expect(permission.toolCallId).toBe("call-a");
    expect(permission.options).toEqual(["Allow once", "Allow always", "Deny", "Deny with feedback"]);
  });

  test("the title decides, so a permission prompt without a tool call id stays a permission", () => {
    const result = classifyUiRequest(
      selectFrame({ title: `${PERMISSION_TITLE_PREFIX} bash\n\nCommand: $ rm -rf /tmp/x` }),
    );
    expect(result.kind).toBe("permission");
  });

  test("a select whose title merely mentions the prefix later is a form", () => {
    const result = classifyUiRequest(selectFrame({ title: `Allow the ${PERMISSION_TITLE_PREFIX} dialog?` }));
    expect(result.kind).toBe("form");
  });

  test("a select with a non-string title is still a form", () => {
    expect(classifyUiRequest(selectFrame({ title: 42 })).kind).toBe("form");
    expect(classifyUiRequest(selectFrame({ title: undefined })).kind).toBe("form");
  });
});

describe("classifyUiRequest question", () => {
  test("the recorded question dialog classifies as a question", () => {
    const result = classifyUiRequest(recordedUiRequest("question"));
    expect(result.kind).toBe("question");
    if (result.kind !== "question") throw new Error("unreachable");
    const question = result.question as QuestionUiRequest;
    expect(question.requestId).toBe("ask-user-1");
    expect(question.toolCallId).toBe("call_abc123");
    expect(question.questions).toHaveLength(1);
  });

  test("a question without a request id or a questions array is not a question", () => {
    expect(classifyUiRequest({ method: "question", questions: [] }).kind).toBe("status");
    expect(classifyUiRequest({ method: "question", requestId: "q1" }).kind).toBe("status");
    expect(classifyUiRequest({ method: "question", requestId: "", questions: [] }).kind).toBe("status");
  });
});

describe("classifyUiRequest forms", () => {
  test("input, confirm and editor are forms", () => {
    for (const method of ["input", "confirm", "editor"] as const) {
      const result = classifyUiRequest({ type: "extension_ui_request", id: "uuid-f", method, title: "T" });
      expect(result.kind).toBe("form");
      if (result.kind === "form") expect(result.form.method).toBe(method);
    }
  });

  test("a question-shaped dialog stays a form when its method is select", () => {
    expect(
      classifyUiRequest({ method: "select", title: "Which database?", options: [{ label: "PostgreSQL" }] }).kind,
    ).toBe("form");
  });
});

describe("classifyUiRequest status", () => {
  test("every fire-and-forget method is status", () => {
    for (const method of [
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
      "setSubagentCost",
      "custom_unsupported",
      "something_the_host_added_later",
    ]) {
      expect(classifyUiRequest({ type: "extension_ui_request", id: "uuid-s", method }).kind).toBe("status");
    }
  });

  test("a permission-shaped select under another frame type is status", () => {
    expect(
      classifyUiRequest({ type: "tool_execution_start", method: "select", title: `${PERMISSION_TITLE_PREFIX} read` })
        .kind,
    ).toBe("status");
  });

  test("shapes that carry no usable method are status and never throw", () => {
    const shapes: unknown[] = [
      null,
      undefined,
      0,
      "",
      true,
      [],
      [selectFrame()],
      {},
      { method: 42 },
      { method: null },
      { type: "extension_ui_request" },
      Object.create(null),
    ];
    for (const shape of shapes) expect(() => classifyUiRequest(shape)).not.toThrow();
    for (const shape of shapes) expect(classifyUiRequest(shape).kind).toBe("status");
  });
});
