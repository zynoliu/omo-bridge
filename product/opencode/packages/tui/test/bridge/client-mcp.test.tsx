import { describe, expect, test } from "bun:test";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { createExtensionRequester } from "../../../bridge-core/src/extension-request.ts";
import { connectBridgeMcp, decodeMcpRequest } from "../../src/bridge/mcp-client.ts";

function wired(execute: (request: { readonly requestId: string; readonly server: string; readonly tool: string }) => Promise<{ readonly result: unknown } | { readonly error: string }>) {
  const written: unknown[] = [];
  const data = new BridgeData();
  data.setExtensionRequester(createExtensionRequester({ write: (frame) => written.push(frame) }));
  const errors: string[] = [];
  const client = connectBridgeMcp(data, { execute: execute, onError: (message) => errors.push(message) });
  return { data: data, client: client, written: written, errors: errors };
}

function request(requestId: string) {
  return {
    type: "extension_event",
    name: "tui.pack.mcp.request",
    data: { requestId: requestId, sessionId: "sess_1", server: "bridge-tools", tool: "list", input: {} },
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("tui client mcp channel", () => {
  test("a request runs once and is answered on the documented reply name", async () => {
    let calls = 0;
    const context = wired(async () => {
      calls += 1;
      return { result: { tools: ["list"] } };
    });
    context.data.publishEvent(request("mcp-1"));
    await flush();
    expect(calls).toBe(1);
    expect(context.written).toHaveLength(1);
    const frame = context.written[0];
    if (typeof frame !== "object" || frame === null) throw new Error("no frame");
    expect((frame as Record<string, unknown>)["name"]).toBe("tui.pack.mcp.reply");
    const payload = (frame as Record<string, unknown>)["data"];
    expect(payload).toEqual({ requestId: "mcp-1", ok: true, result: { tools: ["list"] } });
    context.client.stop();
  });

  test("the reply carries the routing handle, which a multi-session host requires", async () => {
    const written: unknown[] = [];
    const data = new BridgeData();
    data.setExtensionRequester(createExtensionRequester({ write: (frame) => written.push(frame) }));
    const client = connectBridgeMcp(data, {
      execute: async () => ({ result: {} }),
      routeSession: (sessionID) => (sessionID === "sess_1" ? "rpc-7" : undefined),
    });
    data.publishEvent(request("mcp-4"));
    await flush();
    const frame = written[0];
    if (typeof frame !== "object" || frame === null) throw new Error("no frame");
    expect((frame as Record<string, unknown>)["sessionId"]).toBe("rpc-7");
    client.stop();
  });

  test("a session the launcher cannot route is sent as the extension named it", async () => {
    const written: unknown[] = [];
    const data = new BridgeData();
    data.setExtensionRequester(createExtensionRequester({ write: (frame) => written.push(frame) }));
    const client = connectBridgeMcp(data, { execute: async () => ({ result: {} }), routeSession: () => undefined });
    data.publishEvent(request("mcp-5"));
    await flush();
    const frame = written[0];
    if (typeof frame !== "object" || frame === null) throw new Error("no frame");
    expect((frame as Record<string, unknown>)["sessionId"]).toBe("sess_1");
    client.stop();
  });

  test("a replayed request after a reconnect is not run twice", async () => {
    let calls = 0;
    const context = wired(async () => {
      calls += 1;
      return { result: {} };
    });
    context.data.publishEvent(request("mcp-1"));
    await flush();
    context.data.publishEvent(request("mcp-1"));
    await flush();
    expect(calls).toBe(1);
    expect(context.written).toHaveLength(1);
    expect(context.client.seen()).toEqual(["mcp-1"]);
    context.client.stop();
  });

  test("a failing tool answers with the error instead of throwing into the event dispatch", async () => {
    const context = wired(async () => ({ error: "server refused" }));
    context.data.publishEvent(request("mcp-2"));
    await flush();
    const frame = context.written[0];
    if (typeof frame !== "object" || frame === null) throw new Error("no frame");
    expect((frame as Record<string, unknown>)["data"]).toEqual({ requestId: "mcp-2", ok: false, error: "server refused" });
    context.client.stop();
  });

  test("a malformed request is reported and nothing is executed", async () => {
    let calls = 0;
    const context = wired(async () => {
      calls += 1;
      return { result: {} };
    });
    context.data.publishEvent({ type: "extension_event", name: "tui.pack.mcp.request", data: { requestId: "x" } });
    await flush();
    expect(calls).toBe(0);
    expect(context.errors).toHaveLength(1);
    expect(context.written).toHaveLength(0);
    context.client.stop();
  });

  test("a restored snapshot stops a replayed request from running twice across a reconnect", async () => {
    let calls = 0;
    const context = wired(async () => {
      calls += 1;
      return { result: {} };
    });
    expect(context.client.snapshot()).toEqual([]);
    expect(context.client.restore(["mcp-9"])).toBe(1);
    expect(context.client.snapshot()).toEqual(["mcp-9"]);
    context.data.publishEvent(request("mcp-9"));
    await flush();
    expect(calls).toBe(0);
    expect(context.written).toHaveLength(0);
    context.client.stop();
  });

  test("the request decoder refuses a payload without a request id, server or tool", () => {
    expect(decodeMcpRequest({ server: "s", tool: "t" })).toBeUndefined();
    expect(decodeMcpRequest({ requestId: "r", tool: "t" })).toBeUndefined();
    expect(decodeMcpRequest({ requestId: "r", server: "s" })).toBeUndefined();
  });
});
