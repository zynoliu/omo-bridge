import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createToolProjector } from "../../src/translate/tools";
import type { OpenCodeEvent } from "../../src/translate/types";

const FIXTURE_DIR = join(import.meta.dir, "..", "..", "contracts", "senpi");
const SESSION_ID = "ses_tools";
const START = 1_718_000_000_000;

type Fixture = { frame: Record<string, unknown>; role: string; endpoint: string; source: string };

function fixtures(name: string): Fixture[] {
  return readFileSync(join(FIXTURE_DIR, name), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Fixture);
}

function startFrame(id: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      role: "assistant",
      id,
      content: [],
      provider: "anthropic",
      model: "claude-sonnet-4",
      usage: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { total: 0 } },
      stopReason: "pending",
      timestamp: START,
    },
  };
}

function isToolFrame(frame: Record<string, unknown>): boolean {
  const type = frame.type;
  if (type === "tool_execution_start" || type === "tool_execution_update" || type === "tool_execution_end") {
    return true;
  }
  if (type !== "message_update") return false;
  const kind = (frame.assistantMessageEvent as { type?: unknown } | undefined)?.type;
  return typeof kind === "string" && kind.startsWith("toolcall_");
}

function replay(frames: unknown[]) {
  const emitted: OpenCodeEvent[] = [];
  let sequence = 0;
  let clock = START;
  const projector = createToolProjector(
    { sessionID: SESSION_ID, nextID: () => `evt_${++sequence}`, now: () => clock++ },
    (event) => emitted.push(event),
  );
  for (const frame of frames) projector.handle(frame);
  return { emitted, projector };
}

const eventsToolFrames = fixtures("events.jsonl")
  .map((record) => record.frame)
  .filter(isToolFrame);
const toolsFrames = fixtures("tools.jsonl").map((record) => record.frame);

describe("tool projector", () => {
  test("projects one bash tool call from the derived event fixtures", () => {
    const { emitted, projector } = replay([startFrame("msg_events_1"), ...eventsToolFrames]);

    expect(emitted.map(({ type, data }) => ({ type, data }))).toEqual([
      {
        type: "session.tool.input.started",
        data: { sessionID: SESSION_ID, assistantMessageID: "msg_events_1", id: "call_abc123", name: "bash" },
      },
      {
        type: "session.tool.input.delta",
        data: { sessionID: SESSION_ID, assistantMessageID: "msg_events_1", id: "call_abc123", delta: '{"command":' },
      },
      {
        type: "session.tool.input.ended",
        data: {
          sessionID: SESSION_ID,
          assistantMessageID: "msg_events_1",
          id: "call_abc123",
          text: '{"command":"ls -la"}',
        },
      },
      {
        type: "session.tool.called",
        data: {
          sessionID: SESSION_ID,
          assistantMessageID: "msg_events_1",
          id: "call_abc123",
          input: { command: "ls -la" },
          executed: true,
        },
      },
      {
        type: "session.tool.progress",
        data: {
          sessionID: SESSION_ID,
          assistantMessageID: "msg_events_1",
          id: "call_abc123",
          metadata: {
            content: [{ type: "text", text: "partial output so far..." }],
            details: { truncation: null, fullOutputPath: null },
          },
        },
      },
      {
        type: "session.tool.success",
        data: {
          sessionID: SESSION_ID,
          assistantMessageID: "msg_events_1",
          id: "call_abc123",
          content: [{ type: "text", text: "total 48\n..." }],
          metadata: { truncation: null, fullOutputPath: null },
          executed: true,
        },
      },
    ]);
    expect(emitted.map((event) => event.id)).toEqual(emitted.map((_, index) => `evt_${index + 1}`));
    expect(emitted.map((event) => event.created)).toEqual(emitted.map((_, index) => START + index));
    expect(projector.stats.ignored).toBe(0);
  });

  test("keeps execution frames on the assistant message that ended before them", () => {
    const { emitted, projector } = replay(toolsFrames);
    expect(emitted.map((event) => event.type)).toEqual([
      "session.tool.input.started",
      "session.tool.input.delta",
      "session.tool.input.delta",
      "session.tool.input.ended",
      "session.tool.called",
      "session.tool.progress",
      "session.tool.progress",
      "session.tool.success",
      "session.tool.input.started",
      "session.tool.input.delta",
      "session.tool.input.ended",
      "session.tool.called",
      "session.tool.failed",
    ]);
    expect(emitted.every((event) => event.data.assistantMessageID === "msg_tools_1")).toBe(true);
    expect(projector.stats.ignored).toBe(0);
  });

  test("forwards the cumulative progress snapshot unchanged", () => {
    const { emitted } = replay(toolsFrames);
    const progress = emitted.filter((event) => event.type === "session.tool.progress").map((event) => event.data.metadata);
    expect(progress).toEqual([
      { content: [{ type: "text", text: "hello\n" }], details: { exitCode: null } },
      { content: [{ type: "text", text: "hello\nworld\n" }], details: { exitCode: null, running: true } },
    ]);
    expect((progress[1] as { content: { text: string }[] }).content[0]?.text).toBe("hello\nworld\n");
  });

  test("routes a successful execution to tool.success with content and details", () => {
    const { emitted } = replay(toolsFrames);
    const success = emitted.find((event) => event.type === "session.tool.success");
    expect(success?.data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID: "msg_tools_1",
      id: "call_bash_1",
      content: [{ type: "text", text: "hello\nworld\n" }],
      metadata: { exitCode: 0 },
      executed: true,
    });
  });

  test("routes an errored execution to tool.failed instead of success", () => {
    const { emitted } = replay(toolsFrames);
    const failed = emitted.find((event) => event.type === "session.tool.failed");
    expect(failed?.data).toEqual({
      sessionID: SESSION_ID,
      assistantMessageID: "msg_tools_1",
      id: "call_edit_1",
      error: "permission denied",
      content: [{ type: "text", text: "permission denied" }],
      executed: true,
    });
    expect(emitted.some((event) => event.type === "session.tool.success" && event.data.id === "call_edit_1")).toBe(
      false,
    );
  });

  test("exposes pending tool calls from input start until execution end", () => {
    const firstExecution = toolsFrames.findIndex((frame) => frame.type === "tool_execution_start");
    expect(firstExecution).toBeGreaterThan(0);

    const before = replay(toolsFrames.slice(0, firstExecution + 1));
    const pending = before.projector.pendingToolCalls();
    expect([...pending.keys()]).toEqual(["call_bash_1"]);
    expect(pending.get("call_bash_1")?.name).toBe("bash");
    expect(pending.get("call_bash_1")?.startedAt).toBe(before.emitted[0]?.created);

    const after = replay(toolsFrames);
    expect(after.projector.pendingToolCalls().size).toBe(0);
  });

  test("ignores frames it does not own and counts the unknown ones", () => {
    const { emitted, projector } = replay([
      { type: "quantum_flux", payload: {} },
      null,
      "not an event",
      { type: "message_start", message: { role: "user" } },
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi" } },
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "telepathy_delta", contentIndex: 0, delta: "x" },
      },
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: "orphan" } },
      {
        type: "tool_execution_end",
        toolCallId: "ghost",
        result: { content: [{ type: "text", text: "x" }] },
        isError: false,
      },
    ]);
    expect(emitted).toEqual([]);
    expect(projector.stats.ignored).toBe(6);
  });

  // The manual-QA script captures these lines as the emitted-sequence evidence for one bash call.
  test("prints the emitted sequence for one bash tool call", () => {
    const { emitted } = replay([startFrame("msg_events_1"), ...eventsToolFrames]);
    for (const event of emitted) console.log(`${event.type} ${JSON.stringify(event.data)}`);
    expect(emitted.length).toBe(6);
  });
});
