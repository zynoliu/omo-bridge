import { describe, expect, test } from "bun:test";
import {
  projectEntries,
  projectEntriesWithStats,
  type PublicAssistantMessage,
  type PublicCompactionMessage,
  type PublicShellMessage,
  type PublicUserMessage,
} from "../../src/model/message-projection";

function userEntry(id: string, timestamp: string, content: unknown): unknown {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp,
    message: { role: "user", content, timestamp: Date.parse(timestamp) },
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

const T0 = "2026-11-05T00:00:00.000Z";
const T1 = "2026-11-05T00:00:01.000Z";
const T2 = "2026-11-05T00:00:02.000Z";
const T3 = "2026-11-05T00:00:03.000Z";

describe("projectEntries", () => {
  test("maps user text and images onto the opencode user message", () => {
    const entries = [
      userEntry("u1", T0, [
        { type: "text", text: "hello" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ]),
    ];
    const messages = projectEntries(entries);
    expect(messages).toHaveLength(1);
    const user = messages[0] as PublicUserMessage;
    expect(user).toEqual({
      id: "u1",
      time: { created: T0 },
      type: "user",
      text: "hello",
      files: [{ data: "aGVsbG8=", mime: "image/png", source: { type: "inline" } }],
    });
    expect(projectEntries([userEntry("u2", T1, "plain")])[0]).toMatchObject({ type: "user", text: "plain" });
  });

  test("maps assistant text, thinking and completed tool calls", () => {
    const messages = projectEntries([
      assistantEntry("a1", T1, [
        { type: "text", text: "Running it" },
        { type: "thinking", thinking: "considering" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
      ]),
      toolResultEntry("r1", T2, "call-1", "file.txt", false),
    ]);
    expect(messages).toHaveLength(1);
    const assistant = messages[0] as PublicAssistantMessage;
    expect(assistant.type).toBe("assistant");
    expect(assistant.agent).toBe("build");
    expect(assistant.model).toEqual({ id: "claude-sonnet-4", providerID: "anthropic" });
    expect(assistant.content).toEqual([
      { type: "text", text: "Running it" },
      { type: "reasoning", text: "considering" },
      {
        type: "tool",
        id: "call-1",
        name: "bash",
        state: { status: "completed", input: { command: "ls" }, content: [{ type: "text", text: "file.txt" }] },
        time: { created: T1 },
      },
    ]);
  });

  test("marks failed tool calls as error and unanswered calls as running", () => {
    const messages = projectEntries([
      assistantEntry("a1", T1, [
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "false" } },
        { type: "toolCall", id: "call-2", name: "read", arguments: { path: "/x" } },
      ]),
      toolResultEntry("r1", T2, "call-1", "boom", true),
    ]);
    const assistant = messages[0] as PublicAssistantMessage;
    expect(assistant.content[0]).toMatchObject({
      type: "tool",
      state: {
        status: "error",
        input: { command: "false" },
        error: { type: "tool", message: "boom" },
        content: [{ type: "text", text: "boom" }],
      },
    });
    expect(assistant.content[1]).toMatchObject({
      type: "tool",
      state: { status: "running", input: { path: "/x" }, metadata: {} },
    });
  });

  test("maps bash execution, compaction and model switches", () => {
    const messages = projectEntries([
      {
        type: "message",
        id: "b1",
        parentId: null,
        timestamp: T0,
        message: { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0, cancelled: false, timestamp: Date.parse(T0) },
      },
      { type: "compaction", id: "c1", parentId: "b1", timestamp: T1, summary: "earlier work", firstKeptEntryId: "b1", tokensBefore: 100 },
      { type: "model_change", id: "m1", parentId: "c1", timestamp: T2, provider: "openai", modelId: "gpt-4o" },
    ]);
    expect(messages).toHaveLength(3);
    const shell = messages[0] as PublicShellMessage;
    expect(shell).toMatchObject({ type: "shell", command: "echo hi", status: "exited", exit: 0, output: "hi" });
    expect(shell.shellID).toBe("b1");
    const compaction = messages[1] as PublicCompactionMessage;
    expect(compaction).toMatchObject({ type: "compaction", status: "completed", summary: "earlier work", time: { created: T1 } });
    expect(messages[2]).toEqual({
      id: "m1",
      time: { created: T2 },
      type: "model-switched",
      model: { id: "gpt-4o", providerID: "openai" },
    });
  });

  test("marks a cancelled bash execution as killed", () => {
    const messages = projectEntries([
      {
        type: "message",
        id: "b1",
        parentId: null,
        timestamp: T0,
        message: { role: "bashExecution", command: "sleep 10", output: "", cancelled: true, timestamp: Date.parse(T0) },
      },
    ]);
    expect(messages[0]).toMatchObject({ type: "shell", status: "killed" });
    expect((messages[0] as PublicShellMessage).exit).toBeUndefined();
  });

  test("skips unknown entry types, senpi-only roles and malformed entries with a count", () => {
    const result = projectEntriesWithStats([
      userEntry("u1", T0, "hello"),
      { type: "custom", id: "x1", parentId: "u1", timestamp: T1, customType: "ext" },
      { type: "label", id: "x2", parentId: "u1", timestamp: T2 },
      { type: "message", id: "x3", parentId: "u1", timestamp: T3, message: { role: "custom", customType: "ext" } },
      "not an entry",
      { type: "message", id: "", timestamp: T1 },
    ]);
    expect(result.messages.map((message) => message.id)).toEqual(["u1"]);
    expect(result.skipped).toBe(5);
    expect([...result.skippedTypes].sort()).toEqual(
      ["custom", "invalid-entry", "label", "message", "message:custom"].sort(),
    );
  });

  test("keeps entry ids stable as the only message ids", () => {
    const entries = [userEntry("u1", T0, "one"), assistantEntry("a1", T1, [{ type: "text", text: "two" }])];
    expect(projectEntries(entries).map((message) => message.id)).toEqual(["u1", "a1"]);
  });
});
