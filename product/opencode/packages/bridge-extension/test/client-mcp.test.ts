import { describe, expect, test } from "bun:test";

import { createMcpRegistry, decodeMcpConfig } from "../src/mcp.ts";

const SESSION = "sess_1";

function registry(session: string | null = SESSION) {
  let counter = 0;
  return createMcpRegistry({
    sessionID: () => session,
    nextRequestId: () => {
      counter += 1;
      return "req-" + String(counter);
    },
  });
}

const config = { type: "stdio", command: "bun", args: ["run", "server.ts"] };

describe("client mcp registry", () => {
  test("a stdio server registers for the connected session and lists back verbatim", () => {
    const mcp = registry();
    const outcome = mcp.register({ sessionID: SESSION, name: "bridge-tools", config: config });
    expect(outcome.kind).toBe("registered");
    const listed = mcp.list(SESSION);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.config.command).toBe("bun");
    expect(listed[0]?.config.args).toEqual(["run", "server.ts"]);
  });

  test("registering for another session is refused", () => {
    const mcp = registry();
    const outcome = mcp.register({ sessionID: "sess_2", name: "x", config: config });
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.code).toBe("cross_session");
    expect(mcp.list("sess_2")).toHaveLength(0);
  });

  test("a malformed config is refused instead of being coerced", () => {
    const mcp = registry();
    expect(decodeMcpConfig({ type: "http", url: "http://x" })).toBeUndefined();
    expect(decodeMcpConfig({ type: "stdio" })).toBeUndefined();
    expect(decodeMcpConfig({ type: "stdio", command: "bun", args: [1] })).toBeUndefined();
    const outcome = mcp.register({ sessionID: SESSION, name: "x", config: { type: "stdio" } });
    expect(outcome.kind).toBe("refused");
  });

  test("a duplicate name in the same session is refused", () => {
    const mcp = registry();
    mcp.register({ sessionID: SESSION, name: "dup", config: config });
    const again = mcp.register({ sessionID: SESSION, name: "dup", config: config });
    expect(again.kind).toBe("refused");
    if (again.kind === "refused") expect(again.code).toBe("duplicate_name");
  });

  test("a read request queues without asking for authorization", () => {
    const mcp = registry();
    mcp.register({ sessionID: SESSION, name: "bridge-tools", config: config });
    const outcome = mcp.request({ sessionID: SESSION, server: "bridge-tools", tool: "list", input: {} });
    expect(outcome.kind).toBe("queued");
    expect(mcp.pending()).toEqual([]);
  });

  test("a write request shows the exact content and only runs after the same text comes back", () => {
    const mcp = registry();
    mcp.register({ sessionID: SESSION, name: "bridge-tools", config: config });
    const outcome = mcp.request({
      sessionID: SESSION,
      server: "bridge-tools",
      tool: "terminal.write",
      input: {},
      write: { content: "echo bridge-mcp-ok" },
    });
    expect(outcome.kind).toBe("needs_authorization");
    if (outcome.kind !== "needs_authorization") return;
    expect(outcome.shown).toBe("echo bridge-mcp-ok");
    expect(mcp.authorize(outcome.requestId, "echo something else")).toBe(false);
    expect(mcp.pending()).toEqual([outcome.requestId]);
    expect(mcp.authorize(outcome.requestId, "echo bridge-mcp-ok")).toBe(true);
    expect(mcp.pending()).toEqual([]);
  });

  test("a request for an unregistered server or another session is refused and queues nothing", () => {
    const mcp = registry();
    mcp.register({ sessionID: SESSION, name: "bridge-tools", config: config });
    const unknown = mcp.request({ sessionID: SESSION, server: "other", tool: "list", input: {} });
    expect(unknown.kind).toBe("refused");
    const cross = mcp.request({ sessionID: "sess_2", server: "bridge-tools", tool: "list", input: {} });
    expect(cross.kind).toBe("refused");
    if (cross.kind === "refused") expect(cross.code).toBe("cross_session");
    expect(mcp.pending()).toEqual([]);
  });
});
