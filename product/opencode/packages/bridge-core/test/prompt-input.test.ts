import { describe, expect, test } from "bun:test";

import { AGENT_REQUEST_MARKER, agentInstruction, translatePromptAgentSelection } from "../src/prompt-input.ts";

describe("prompt agent selection translation", () => {
  test("a prompt naming one agent carries one instruction naming it, then the caller's text", () => {
    const translated = translatePromptAgentSelection({ sessionID: "s1", text: "hello", agent: "build" });
    expect(translated.selection).toEqual({ requested: ["build"], carrier: "prompt-prefix", hostField: false });
    expect(translated.text.startsWith(AGENT_REQUEST_MARKER)).toBe(true);
    expect(translated.text).toContain('"build"');
    expect(translated.text).toContain("switched no agent");
    expect(translated.text.endsWith("\n\nhello")).toBe(true);
  });

  test("a non-empty agents list is translated and repeated names collapse", () => {
    const translated = translatePromptAgentSelection({
      text: "go",
      agent: "review",
      agents: [{ name: "review" }, { name: "build" }],
    });
    expect(translated.selection?.requested).toEqual(["review", "build"]);
    expect(translated.text).toContain('"review", "build"');
  });

  test("a prompt with no agent selection passes through untouched", () => {
    for (const input of [
      { text: "hello" },
      { text: "hello", agents: [] },
      { text: "hello", agent: undefined, agents: [] },
      { text: "hello", agent: null, agents: null },
      { text: "hello", agents: [{ name: "" }] },
    ]) {
      const translated = translatePromptAgentSelection(input);
      expect(translated.selection).toBeUndefined();
      expect(translated.text).toBe("hello");
    }
    expect(translatePromptAgentSelection(undefined)).toEqual({ text: "", selection: undefined });
    expect(translatePromptAgentSelection("hello")).toEqual({ text: "", selection: undefined });
  });

  test("the record never claims an agent ran: the host field is unused and the text says so", () => {
    const instruction = agentInstruction(["build"]);
    expect(instruction).toContain(AGENT_REQUEST_MARKER);
    expect(instruction).toContain("carries no agent field");
    expect(instruction).toContain("switched no agent");
    expect(instruction).toContain("the only carrier of that request");
    const translated = translatePromptAgentSelection({ text: "x", agent: "build" });
    expect(translated.selection?.hostField).toBe(false);
    expect(translated.selection?.carrier).toBe("prompt-prefix");
  });
});
