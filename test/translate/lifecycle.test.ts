import { describe, expect, test } from "bun:test";
import { createLifecycleProjector } from "../../src/translate/lifecycle";
import type { OpenCodeEvent } from "../../src/translate/types";

const SESSION_ID = "ses_lifecycle";
const START = 1_718_000_000_000;

function replay(frames: unknown[]) {
  const emitted: OpenCodeEvent[] = [];
  let sequence = 0;
  let clock = START;
  const projector = createLifecycleProjector(
    { sessionID: SESSION_ID, nextID: () => `evt_${++sequence}`, now: () => clock++ },
    (event) => emitted.push(event),
  );
  for (const frame of frames) projector.handle(frame);
  return { emitted, projector };
}

const agentStart = { type: "agent_start", runId: "run_1" };

function agentEnd(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "agent_end", messages: [], willRetry: false, ...extra };
}

function messageStart(id = "msg_1", provider = "anthropic", model = "claude-sonnet-4"): Record<string, unknown> {
  return { type: "message_start", message: { role: "assistant", id, provider, model, content: [] } };
}

function messageEnd(id: string, usage: Record<string, unknown>): Record<string, unknown> {
  return { type: "message_end", message: { role: "assistant", id, usage } };
}

const usageOne = {
  input: 100,
  output: 40,
  reasoning: 0,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: 155,
  cost: { total: 0.02 },
};

const usageTwo = {
  input: 20,
  output: 10,
  reasoning: 3,
  cacheRead: 1,
  cacheWrite: 2,
  totalTokens: 36,
  cost: { total: 0.01 },
};

describe("lifecycle projector", () => {
  test("lifecycle projects started then succeeded", () => {
    const { emitted } = replay([agentStart, messageStart(), messageEnd("msg_1", usageOne), agentEnd()]);

    expect(emitted.map((event) => event.type)).toEqual([
      "session.execution.started",
      "session.usage.updated",
      "session.execution.succeeded",
    ]);
    expect(emitted[0]?.data).toEqual({ sessionID: SESSION_ID });
    expect(emitted[1]?.data).toEqual({
      sessionID: SESSION_ID,
      cost: 0.02,
      tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 10, write: 5 } },
    });
    expect(emitted[2]?.data).toEqual({ sessionID: SESSION_ID });
  });

  test("lifecycle projects started then failed with the provider failure", () => {
    const { emitted } = replay([
      agentStart,
      agentEnd({
        failure: { category: "rate_limit", reason: "the provider is rate limiting requests", httpStatus: 429 },
      }),
    ]);

    expect(emitted.map((event) => event.type)).toEqual(["session.execution.started", "session.execution.failed"]);
    expect(emitted[1]?.data).toEqual({
      sessionID: SESSION_ID,
      error: { type: "rate_limit", message: "the provider is rate limiting requests", status: 429 },
    });
  });

  test("lifecycle defaults a failure without category or reason", () => {
    const { emitted } = replay([agentStart, agentEnd({ failure: {} })]);

    expect(emitted.map((event) => event.type)).toEqual(["session.execution.started", "session.execution.failed"]);
    expect(emitted[1]?.data).toEqual({
      sessionID: SESSION_ID,
      error: { type: "unknown", message: "the run failed" },
    });
  });

  test("lifecycle maps abortSource to an interruption reason", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ aborted: true, abortSource: "user" }, "user"],
      [{ aborted: true, abortSource: "system" }, "shutdown"],
      [{ aborted: true, abortSource: "provider" }, "shutdown"],
      [{ aborted: true, abortSource: "inactivity" }, "inactivity"],
      [{ aborted: true, abortSource: "superseded" }, "superseded"],
      [{ aborted: true }, "user"],
      [{ aborted: true, abortCause: { kind: "session_replaced", reason: "new" } }, "superseded"],
    ];

    for (const [extra, reason] of cases) {
      const { emitted } = replay([agentStart, agentEnd(extra)]);
      expect(emitted.map((event) => event.type)).toEqual([
        "session.execution.started",
        "session.execution.interrupted",
      ]);
      expect(emitted[1]?.data).toEqual({ sessionID: SESSION_ID, reason });
    }
  });

  test("lifecycle ignores a duplicate agent_start", () => {
    const { emitted } = replay([agentStart, agentStart, agentEnd()]);

    expect(emitted.map((event) => event.type)).toEqual(["session.execution.started", "session.execution.succeeded"]);
  });

  test("lifecycle emits usage once at agent_end with summed tokens", () => {
    const beforeEnd = replay([agentStart, messageEnd("msg_1", usageOne), messageEnd("msg_2", usageTwo)]);
    expect(beforeEnd.emitted.map((event) => event.type)).toEqual(["session.execution.started"]);

    const { emitted } = replay([
      agentStart,
      messageEnd("msg_1", usageOne),
      messageEnd("msg_2", usageTwo),
      agentEnd(),
    ]);
    expect(emitted.map((event) => event.type)).toEqual([
      "session.execution.started",
      "session.usage.updated",
      "session.execution.succeeded",
    ]);
    expect(emitted[1]?.data).toEqual({
      sessionID: SESSION_ID,
      cost: 0.03,
      tokens: { input: 120, output: 50, reasoning: 3, cache: { read: 11, write: 7 } },
    });
  });

  test("lifecycle projects compaction start and end", () => {
    const { emitted } = replay([
      messageStart("msg_model", "anthropic", "claude-sonnet-4"),
      { type: "compaction_start", reason: "threshold" },
      {
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "Summary of conversation...",
          usage: {
            input: 32000,
            output: 1200,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 33200,
            cost: { total: 0.03 },
          },
        },
      },
    ]);

    expect(emitted.map((event) => event.type)).toEqual([
      "session.compaction.started",
      "session.compaction.ended",
    ]);
    expect(emitted[0]?.data).toEqual({ sessionID: SESSION_ID, reason: "auto" });
    expect(emitted[1]?.data).toEqual({
      sessionID: SESSION_ID,
      reason: "auto",
      model: { id: "claude-sonnet-4", providerID: "anthropic" },
      native: true,
      text: "Summary of conversation...",
      cost: 0.03,
      tokens: { input: 32000, output: 1200, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  });

  test("lifecycle keeps a manual compaction manual", () => {
    const { emitted } = replay([
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", result: { summary: "Short summary" } },
    ]);

    expect(emitted.map((event) => event.type)).toEqual([
      "session.compaction.started",
      "session.compaction.ended",
    ]);
    expect(emitted[0]?.data).toEqual({ sessionID: SESSION_ID, reason: "manual" });
    expect(emitted[1]?.data).toMatchObject({
      sessionID: SESSION_ID,
      reason: "manual",
      native: true,
      text: "Short summary",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    });
  });

  test("lifecycle emits step.streamed on turn_start inside a run", () => {
    const withoutMessage = replay([agentStart, { type: "turn_start" }]);
    expect(withoutMessage.emitted.map((event) => event.type)).toEqual([
      "session.execution.started",
      "session.step.streamed",
    ]);
    expect(withoutMessage.emitted[1]?.data).toEqual({ sessionID: SESSION_ID });

    const withMessage = replay([agentStart, messageStart("msg_9"), { type: "turn_start" }]);
    expect(withMessage.emitted.map((event) => event.type)).toEqual([
      "session.execution.started",
      "session.step.streamed",
    ]);
    expect(withMessage.emitted[1]?.data).toEqual({ sessionID: SESSION_ID, assistantMessageID: "msg_9" });

    const coldStart = replay([{ type: "turn_start" }]);
    expect(coldStart.emitted.map((event) => event.type)).toEqual(["session.execution.started"]);
  });

  test("lifecycle counts unknown frames and never throws", () => {
    const { emitted, projector } = replay([
      { type: "quantum_flux" },
      null,
      "not an event",
      { type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } },
      { type: "tool_execution_start" },
    ]);

    expect(emitted).toEqual([]);
    expect(projector.stats.ignored).toBe(3);
  });

  test("lifecycle survives malformed handled frames", () => {
    const { emitted, projector } = replay([
      agentStart,
      { type: "message_end", message: null },
      { type: "message_end", message: { role: "assistant", usage: "bad" } },
      { type: "agent_end", aborted: "yes", failure: null },
    ]);

    expect(emitted.map((event) => event.type)).toEqual(["session.execution.started", "session.execution.succeeded"]);
    expect(projector.stats.ignored).toBe(0);
  });

  test("lifecycle prints the emitted sequences for the three terminal paths", () => {
    const paths: Record<string, unknown[]> = {
      succeeded: [agentStart, messageEnd("msg_ok", usageOne), agentEnd()],
      failed: [
        agentStart,
        agentEnd({
          failure: { category: "rate_limit", reason: "the provider is rate limiting requests", httpStatus: 429 },
        }),
      ],
      interrupted: [agentStart, agentEnd({ aborted: true, abortSource: "user" })],
    };

    for (const [name, frames] of Object.entries(paths)) {
      const { emitted } = replay(frames);
      console.log(`lifecycle ${name}`);
      for (const event of emitted) console.log(`${event.type} ${JSON.stringify(event.data)}`);
      expect(emitted.length).toBeGreaterThan(0);
    }
  });
});
