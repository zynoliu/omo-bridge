export type JsonSchema = Record<string, unknown>;

const usage: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["input", "output"],
  properties: {
    input: { type: "number" },
    output: { type: "number" },
    cacheRead: { type: "number" },
    cacheWrite: { type: "number" },
    totalTokens: { type: "number" },
    cost: { type: "object" },
  },
};

function delta(type: string, properties: Record<string, JsonSchema> = {}, required: string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: true,
    required: ["type", "contentIndex", ...required],
    properties: { type: { const: type }, contentIndex: { type: "integer", minimum: 0 }, ...properties },
  };
}

const assistantMessageEvent: JsonSchema = {
  anyOf: [
    delta("text_start"),
    delta("text_delta", { delta: { type: "string" } }, ["delta"]),
    delta("text_end", { content: { type: "string" } }, ["content"]),
    delta("thinking_start"),
    delta("thinking_delta", { delta: { type: "string" } }, ["delta"]),
    delta("thinking_end", { content: { type: "string" } }, ["content"]),
    delta("toolcall_start", { id: { type: "string" }, toolName: { type: "string" } }, ["id", "toolName"]),
    delta("toolcall_delta", { delta: { type: "string" } }, ["delta"]),
    delta("toolcall_end", { toolCall: { type: "object" } }, ["toolCall"]),
  ],
};

const textContent: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["type", "text"],
  properties: { type: { const: "text" }, text: { type: "string" } },
};

const toolResult: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["content"],
  properties: { content: { type: "array", items: { type: "object" } }, details: { type: "object" } },
};

const stringArray: JsonSchema = { type: "array", items: { type: "string" } };

function dialog(method: string, properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return {
    type: "object",
    additionalProperties: true,
    required: ["type", "id", "method", ...required],
    properties: { type: { const: "extension_ui_request" }, id: { type: "string" }, method: { const: method }, ...properties },
  };
}

export const EVENT_SCHEMAS: Record<string, JsonSchema> = {
  message_start: {
    type: "object",
    additionalProperties: true,
    required: ["type", "message"],
    properties: { type: { const: "message_start" }, message: { type: "object" } },
  },
  message_end: {
    type: "object",
    additionalProperties: true,
    required: ["type", "message"],
    properties: { type: { const: "message_end" }, message: { type: "object" } },
  },
  message_update: {
    type: "object",
    additionalProperties: true,
    required: ["type", "usage", "assistantMessageEvent"],
    properties: {
      type: { const: "message_update" },
      usage,
      resolvedToolName: { type: "string" },
      assistantMessageEvent,
    },
  },
  turn_start: { type: "object", additionalProperties: true, required: ["type"], properties: { type: { const: "turn_start" } } },
  turn_end: {
    type: "object",
    additionalProperties: true,
    required: ["type", "message", "toolResults"],
    properties: {
      type: { const: "turn_end" },
      message: { type: "object" },
      toolResults: { type: "array", items: { type: "object" } },
    },
  },
  agent_start: {
    type: "object",
    additionalProperties: true,
    required: ["type"],
    properties: { type: { const: "agent_start" }, runId: { type: "string" }, lifecycle: { type: "object" } },
  },
  agent_end: {
    type: "object",
    additionalProperties: true,
    required: ["type", "messages", "willRetry"],
    properties: {
      type: { const: "agent_end" },
      messages: { type: "array", items: { type: "object" } },
      willRetry: { type: "boolean" },
      failure: { type: "object" },
    },
  },
  agent_settled: {
    type: "object",
    additionalProperties: true,
    required: ["type"],
    properties: { type: { const: "agent_settled" }, reason: { type: "string" } },
  },
  tool_execution_start: {
    type: "object",
    additionalProperties: true,
    required: ["type", "toolCallId", "toolName", "args"],
    properties: {
      type: { const: "tool_execution_start" },
      toolCallId: { type: "string" },
      toolName: { type: "string" },
      args: { type: "object" },
    },
  },
  tool_execution_update: {
    type: "object",
    additionalProperties: true,
    required: ["type", "toolCallId", "toolName", "args", "partialResult"],
    properties: {
      type: { const: "tool_execution_update" },
      toolCallId: { type: "string" },
      toolName: { type: "string" },
      args: { type: "object" },
      partialResult: toolResult,
    },
  },
  tool_execution_end: {
    type: "object",
    additionalProperties: true,
    required: ["type", "toolCallId", "toolName", "result", "isError"],
    properties: {
      type: { const: "tool_execution_end" },
      toolCallId: { type: "string" },
      toolName: { type: "string" },
      result: toolResult,
      isError: { type: "boolean" },
    },
  },
  queue_update: {
    type: "object",
    additionalProperties: true,
    required: ["type", "steering", "followUp"],
    properties: { type: { const: "queue_update" }, steering: stringArray, followUp: stringArray },
  },
  extension_ui_request: {
    anyOf: [
      dialog("select", { title: { type: "string" }, options: stringArray, toolCallId: { type: "string" }, timeout: { type: "number" } }, ["title", "options"]),
      dialog("confirm", { title: { type: "string" }, message: { type: "string" }, timeout: { type: "number" } }, ["title"]),
      dialog("input", { title: { type: "string" }, placeholder: { type: "string" }, timeout: { type: "number" } }, ["title"]),
      dialog("editor", { title: { type: "string" }, content: { type: "string" }, timeout: { type: "number" } }, ["title"]),
      dialog(
        "question",
        {
          requestId: { type: "string" },
          toolCallId: { type: "string" },
          waitForAnswer: { type: "boolean" },
          raisedBy: { type: "string" },
          questions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: true,
              required: ["id", "header", "question", "multiSelect"],
              properties: {
                id: { type: "string" },
                header: { type: "string" },
                question: { type: "string" },
                multiSelect: { type: "boolean" },
                options: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: true,
                    required: ["label"],
                    properties: { label: { type: "string" }, description: { type: "string" } },
                  },
                },
              },
            },
          },
          timeout: { type: "number" },
          askedAtMs: { type: "number" },
          deadlineAtMs: { type: "number" },
        },
        ["questions"],
      ),
      dialog("notify", { message: { type: "string" }, notifyType: { type: "string" } }, ["message"]),
      dialog("setStatus", { statusKey: { type: "string" }, statusText: { type: "string" } }, ["statusKey"]),
      dialog("setWidget", { widgetKey: { type: "string" }, widgetLines: { type: "array" } }, ["widgetKey"]),
      dialog("setTitle", { title: { type: "string" } }, ["title"]),
      dialog("set_editor_text", { text: { type: "string" } }, ["text"]),
    ],
  },
};

const sessionRow: JsonSchema = {
  type: "object",
  additionalProperties: true,
  required: ["sessionId"],
  properties: {
    sessionId: { type: "string" },
    durableSessionId: { type: "string" },
    sessionPath: { type: "string" },
    cwd: { type: "string" },
    name: { type: "string" },
    status: { type: "string" },
    attachments: { type: "integer" },
    retain_on_disconnect: { type: "boolean" },
    kind: { enum: ["interactive", "worker"] },
  },
};

export const RESPONSE_DATA_SCHEMAS: Record<string, JsonSchema> = {
  get_protocol_info: {
    type: "object",
    additionalProperties: true,
    required: ["protocolVersion", "serverVersion", "capabilities", "mode"],
    properties: {
      protocolVersion: { type: "integer" },
      serverVersion: { type: "string" },
      capabilities: stringArray,
      mode: { enum: ["classic", "multi"] },
      instanceId: { type: "string" },
      generation: { type: "integer" },
      engineVersion: { type: "string" },
      engineOrdinal: { type: "array", items: { type: "integer" } },
      launch_profile: { type: "object" },
      agentDir: { type: "string" },
      method_classes: { type: "object" },
      memory_pressure: { type: "boolean" },
    },
  },
  list_sessions: {
    type: "object",
    additionalProperties: true,
    required: ["sessions"],
    properties: { sessions: { type: "array", items: sessionRow } },
  },
  open_session: {
    type: "object",
    additionalProperties: true,
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" },
      attached: { type: "boolean" },
      state: { type: "object", additionalProperties: true },
    },
  },
  get_state: {
    type: "object",
    additionalProperties: true,
    required: ["sessionId"],
    properties: {
      sessionId: { type: "string" },
      model: { anyOf: [{ type: "object" }, { type: "null" }] },
      isStreaming: { type: "boolean" },
      isCompacting: { type: "boolean" },
      thinkingLevel: { type: "string" },
      messageCount: { type: "integer" },
      pendingMessageCount: { type: "integer" },
      pendingDialogs: { type: "array", items: { type: "object" } },
    },
  },
  get_entries: {
    type: "object",
    additionalProperties: true,
    required: ["entries", "leafId"],
    properties: {
      entries: { type: "array", items: { type: "object", additionalProperties: true } },
      leafId: { type: ["string", "null"] },
      hasMore: { type: "boolean" },
      nextSince: { type: "string" },
      next_before: { type: "string" },
    },
  },
  close_session: { type: "object", additionalProperties: true },
};
