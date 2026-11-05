import { describe, expect, test } from "bun:test";
import { validateResponse } from "../../src/contract/validate";
import { deriveSchemas } from "../../scripts/contracts-extract";

// The TUI schema declares `content: AssistantContent.pipe(Schema.Array)`
// (packages/schema/src/session-message.ts), so an assistant message carries a
// list of content blocks and a bare block object is not a valid message.
function assistant(content: unknown): Record<string, unknown> {
  return {
    id: "msg_assistant",
    time: { created: 1793851200000 },
    type: "assistant",
    agent: "build",
    model: { id: "deepseek-v4", providerID: "deepseek" },
    content,
  };
}

function envelope(message: unknown): Record<string, unknown> {
  return { data: [message], cursor: {} };
}

describe("session.messages assistant content", () => {
  test("array of content blocks is accepted", () => {
    const result = validateResponse(
      "session.messages",
      envelope(
        assistant([
          { type: "text", text: "hello" },
          { type: "reasoning", text: "thinking" },
          {
            type: "tool",
            id: "tool_1",
            name: "read",
            executed: true,
            state: { status: "running", input: {}, metadata: {} },
            time: { created: 1793851201000 },
          },
        ]),
      ),
    );
    expect(result).toEqual({ ok: true });
  });

  test("empty content array is accepted", () => {
    expect(validateResponse("session.messages", envelope(assistant([])))).toEqual({ ok: true });
  });

  test("single content block object is rejected", () => {
    const result = validateResponse("session.messages", envelope(assistant({ type: "text", text: "hello" })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("/data/0/content");
  });

  test("array with an unknown block type is rejected", () => {
    const result = validateResponse("session.messages", envelope(assistant([{ type: "image", url: "x" }])));
    expect(result.ok).toBe(false);
  });

  test("extractor derives assistant content as an array of blocks", () => {
    type Block = { properties?: { type?: { const?: string } } };
    type ContentField = { type?: string; items?: { anyOf?: Block[] } };
    type MessageSchema = { properties?: { type?: { const?: string }; content?: ContentField } };
    const schema = deriveSchemas().get("session.messages") as {
      properties: { data: { items: { anyOf: MessageSchema[] } } };
    };
    const assistantSchema = schema.properties.data.items.anyOf.find((member) => member.properties?.type?.const === "assistant");
    expect(assistantSchema).toBeDefined();
    const content = assistantSchema?.properties?.content;
    expect(content?.type).toBe("array");
    const blockTypes = (content?.items?.anyOf ?? []).map((block) => block.properties?.type?.const);
    expect(blockTypes).toEqual(["text", "reasoning", "tool"]);
  });
});
