import { describe, expect, test } from "bun:test";

import {
  MCP_PING_REQUEST,
  MCP_REGISTER_REQUEST,
  MCP_REPLY_REQUEST,
  MCP_REQUEST_EVENT,
  bridgeCompanionExtension,
} from "../src/index.ts";
import type { ExtensionHostApi } from "../src/index.ts";

function hostDouble(options: { readonly registerMcp?: boolean } = {}) {
  const handlers = new Map<string, (data: unknown) => unknown | Promise<unknown>>();
  const emitted: { readonly name: string; readonly data: unknown }[] = [];
  const registered: { readonly name: string; readonly config: unknown }[] = [];
  const api: ExtensionHostApi = {
    rpc: {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
      emit: (name, data) => {
        emitted.push({ name: name, data: data });
      },
    },
    ...(options.registerMcp === false
      ? {}
      : {
          registerMcpServer: (name: string, config: unknown) => {
            registered.push({ name: name, config: config });
          },
          unregisterMcpServer: () => {},
        }),
  };
  bridgeCompanionExtension(api);
  const call = (name: string, data: unknown): unknown => {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error("no handler for " + name);
    return handler(data);
  };
  return { handlers: handlers, emitted: emitted, registered: registered, call: call };
}

describe("bridge companion extension", () => {
  test("bridge.mcp.ping emits a request and answers with the reply that arrives for it", async () => {
    const host = hostDouble();
    const roundTrip = host.call(MCP_PING_REQUEST, { sessionId: "ses_1", server: "tui", tool: "open_terminal" });
    expect(host.emitted).toHaveLength(1);
    const request = host.emitted[0];
    if (request === undefined) throw new Error("the ping emitted no request");
    expect(request.name).toBe(MCP_REQUEST_EVENT);
    const payload = request.data as { requestId: string; sessionId: string; server: string; tool: string };
    expect(payload.sessionId).toBe("ses_1");
    expect(payload.server).toBe("tui");
    expect(payload.tool).toBe("open_terminal");
    const accepted = host.call(MCP_REPLY_REQUEST, { requestId: payload.requestId, ok: true, result: { terminalID: "pty_1" } });
    expect(accepted).toEqual({ accepted: true });
    expect(await roundTrip).toEqual({ requestId: payload.requestId, ok: true, result: { terminalID: "pty_1" } });
  });

  test("a reply with no waiting request is refused instead of resolving anything", () => {
    const host = hostDouble();
    expect(host.call(MCP_REPLY_REQUEST, { requestId: "ping-9", ok: true })).toEqual({
      accepted: false,
      reason: "no request is waiting for ping-9",
    });
  });

  test("bridge.mcp.register registers a stdio server through the host API", () => {
    const host = hostDouble();
    const report = host.call(MCP_REGISTER_REQUEST, {
      servers: [{ name: "fs", config: { type: "stdio", command: "fs-server", args: ["--root", "/w"] } }],
    });
    expect(report).toEqual({ registered: ["fs"], refused: [] });
    expect(host.registered).toEqual([
      { name: "fs", config: { type: "stdio", command: "fs-server", args: ["--root", "/w"] } },
    ]);
  });

  test("registration is refused with the host's own reason when it exposes no registerMcpServer", () => {
    const host = hostDouble({ registerMcp: false });
    const report = host.call(MCP_REGISTER_REQUEST, {
      servers: [{ name: "fs", config: { type: "stdio", command: "fs-server" } }],
    });
    expect(report).toEqual({
      registered: [],
      refused: [{ name: "*", message: "this host exposes no registerMcpServer, so a client server cannot be registered" }],
    });
    expect(host.registered).toEqual([]);
  });

  test("a non-stdio server is refused by the existing config decoder", () => {
    const host = hostDouble();
    const report = host.call(MCP_REGISTER_REQUEST, {
      servers: [{ name: "remote", config: { type: "http", url: "https://example.invalid" } }],
    });
    expect(report).toEqual({ registered: [], refused: [{ name: "*", message: "server remote is not a stdio server" }] });
  });
});
