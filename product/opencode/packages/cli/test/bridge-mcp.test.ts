import { describe, expect, test } from "bun:test";

import { ptySessionID } from "../../bridge-core/src/opencode-api.ts";
import { createBridgeMcpExecutor } from "../src/bridge-mcp.ts";
import type { BridgePty, PtyCreateInput, PtyInfo } from "../src/bridge-pty.ts";

type Call = { readonly kind: string; readonly session?: string; readonly terminal?: string; readonly data?: string };

function ptyDouble(existing: readonly PtyInfo[] = []) {
  const calls: Call[] = [];
  const terminals: PtyInfo[] = [...existing];
  let created = 0;
  const pty = {
    list: async (sessionID?: string) => {
      calls.push({ kind: "list", ...(sessionID === undefined ? {} : { session: sessionID }) });
      return terminals;
    },
    create: async (sessionID: string, input: PtyCreateInput) => {
      created += 1;
      const terminal = { id: "pty_" + String(created), sessionID: sessionID, title: input.title } as unknown as PtyInfo;
      terminals.push(terminal);
      calls.push({ kind: "create", session: sessionID });
      return terminal;
    },
    write: async (id: string, data: string) => {
      calls.push({ kind: "write", terminal: id, data: data });
    },
  } as unknown as BridgePty;
  return { pty: pty, calls: calls };
}

describe("bridge client MCP executor", () => {
  test("open_terminal opens one terminal for the branded session and reports its id", async () => {
    const double = ptyDouble();
    const outcome = await createBridgeMcpExecutor(double.pty)({
      requestId: "r1",
      sessionID: "ses_host",
      server: "tui",
      tool: "open_terminal",
      input: {},
    });
    expect(double.calls).toEqual([
      { kind: "list", session: ptySessionID("ses_host") },
      { kind: "create", session: ptySessionID("ses_host") },
    ]);
    expect(JSON.stringify(outcome)).toContain("pty_1");
  });

  test("a session that already has a terminal gets that one instead of another", async () => {
    const existing = { id: "pty_old", sessionID: ptySessionID("ses_host") } as unknown as PtyInfo;
    const double = ptyDouble([existing]);
    const outcome = await createBridgeMcpExecutor(double.pty)({
      requestId: "r2",
      sessionID: "ses_host",
      server: "tui",
      tool: "open_terminal",
      input: {},
    });
    expect(double.calls.some((call) => call.kind === "create")).toBe(false);
    expect(JSON.stringify(outcome)).toContain("pty_old");
  });

  test("write_terminal types the text into the session's terminal", async () => {
    const double = ptyDouble();
    const outcome = await createBridgeMcpExecutor(double.pty)({
      requestId: "r3",
      sessionID: "ses_host",
      server: "tui",
      tool: "write_terminal",
      input: { text: "echo reached\n" },
    });
    const writes = double.calls.filter((call) => call.kind === "write");
    expect(writes).toEqual([{ kind: "write", terminal: "pty_1", data: "echo reached\n" }]);
    expect(JSON.stringify(outcome)).toContain("pty_1");
  });

  test("a non-string text is refused before anything is written", async () => {
    const double = ptyDouble();
    const outcome = await createBridgeMcpExecutor(double.pty)({
      requestId: "r4",
      sessionID: "ses_host",
      server: "tui",
      tool: "write_terminal",
      input: { text: 7 },
    });
    expect(outcome).toEqual({ error: "text must be a string" });
    expect(double.calls.some((call) => call.kind === "write")).toBe(false);
  });

  test("an unknown server or tool, a session-less request and a bridge without terminals all refuse", async () => {
    const double = ptyDouble();
    const executor = createBridgeMcpExecutor(double.pty);
    expect(
      await executor({ requestId: "r5", sessionID: "ses_host", server: "other", tool: "list", input: {} }),
    ).toEqual({ error: "the bridge serves only the 'tui' client server" });
    expect(
      await executor({ requestId: "r6", sessionID: "ses_host", server: "tui", tool: "delete_everything", input: {} }),
    ).toEqual({ error: "unknown tool delete_everything on the 'tui' client server" });
    expect(await executor({ requestId: "r7", sessionID: undefined, server: "tui", tool: "open_terminal", input: {} })).toEqual({
      error: "the request names no session",
    });
    expect(double.calls).toEqual([]);
    const bare = createBridgeMcpExecutor(undefined);
    expect(await bare({ requestId: "r8", sessionID: "ses_host", server: "tui", tool: "open_terminal", input: {} })).toEqual({
      error: "this bridge runs no terminal service, so it serves no client MCP tools",
    });
  });
});
