import { describe, expect, test } from "bun:test";
import { firstUserMessageText, normalizeTitle, titleFromEntries, titlePromptFor } from "../src/titles";

describe("normalizeTitle", () => {
  test("strips quotes, tags, markdown and a trailing period", () => {
    expect(normalizeTitle('<title>"Fix Read Attachment"</title>')).toBe("Fix Read Attachment");
    expect(normalizeTitle("**修复读连接抖动**。")).toBe("修复读连接抖动");
  });

  test("rejects an empty answer and the generator's own none", () => {
    expect(normalizeTitle("   ")).toBeUndefined();
    expect(normalizeTitle("none")).toBeUndefined();
    expect(normalizeTitle("<title>none</title>")).toBeUndefined();
  });

  test("caps a runaway answer instead of publishing a paragraph", () => {
    const title = normalizeTitle("a".repeat(200));
    expect(title?.length).toBe(60);
  });
});

describe("firstUserMessageText", () => {
  test("answers the first user text, skipping the bookkeeping entries before it", () => {
    const entries = [
      { type: "custom", customType: "repository-identity", data: {} },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "greeting" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "fix the churn" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "second" }] } },
    ];
    expect(firstUserMessageText(entries)).toBe("fix the churn");
  });

  test("answers nothing for a session with no user turn yet", () => {
    expect(firstUserMessageText([{ type: "custom", data: {} }])).toBeUndefined();
  });
});

describe("titleFromEntries", () => {
  test("answers the last assistant text of the summarization turn", () => {
    const entries = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "summarize" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "First try" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Final Title" }] } },
    ];
    expect(titleFromEntries(entries)).toBe("Final Title");
  });

  test("answers nothing when the turn produced no usable title", () => {
    expect(titleFromEntries([{ type: "message", message: { role: "assistant", content: [] } }])).toBeUndefined();
  });
});

test("titlePromptFor carries the first message and asks for a title alone", () => {
  const prompt = titlePromptFor("hello");
  expect(prompt).toContain("<first-message>\nhello\n</first-message>");
  expect(prompt).toContain("no quotes");
});
