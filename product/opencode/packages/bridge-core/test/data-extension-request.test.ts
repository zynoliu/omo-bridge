import { describe, expect, test } from "bun:test";

import { BridgeData } from "../src/data.ts";
import { createExtensionRequester } from "../src/extension-request.ts";

describe("bridge data extension requests", () => {
  test("a surface refuses when the launcher installed no sender", async () => {
    const data = new BridgeData();
    await expect(data.requestExtension("req-1", {})).rejects.toThrow(/no extension request sender/);
  });

  test("an installed sender writes the frame and resolves with the matching answer", async () => {
    const written: unknown[] = [];
    const requester = createExtensionRequester({ write: (frame) => written.push(frame) });
    const data = new BridgeData();
    data.setExtensionRequester(requester);

    const pending = data.requestExtension("req-1", { id: "req-1", type: "extension_request", name: "omo.memory.status" });
    expect(written).toEqual([{ id: "req-1", type: "extension_request", name: "omo.memory.status" }]);
    expect(requester.accept("req-1", { id: "req-1", success: true, data: { kind: "snapshot" } })).toBe("resolved");
    await expect(pending).resolves.toEqual({ id: "req-1", success: true, data: { kind: "snapshot" } });
  });

  test("a frame that does not carry the id is written with it, because the host answers by that id", async () => {
    const written: unknown[] = [];
    const requester = createExtensionRequester({ write: (frame) => written.push(frame) });
    const data = new BridgeData();
    data.setExtensionRequester(requester);
    const pending = data.requestExtension("mcp-reply-1", {
      type: "extension_request",
      name: "tui.pack.mcp.reply",
      sessionId: "rpc-1",
      data: { requestId: "mcp-1", ok: true },
    });
    expect(written).toEqual([
      {
        type: "extension_request",
        name: "tui.pack.mcp.reply",
        sessionId: "rpc-1",
        data: { requestId: "mcp-1", ok: true },
        id: "mcp-reply-1",
      },
    ]);
    requester.accept("mcp-reply-1", { id: "mcp-reply-1", success: true });
    await expect(pending).resolves.toEqual({ id: "mcp-reply-1", success: true });
  });

  test("the answer is handed back unvalidated, so a caller decodes it itself", async () => {
    const requester = createExtensionRequester({ write: () => {} });
    const data = new BridgeData();
    data.setExtensionRequester(requester);
    const pending = data.requestExtension("req-2", { id: "req-2", type: "extension_request", name: "omo.memory.status" });
    requester.accept("req-2", "not a frame");
    await expect(pending).resolves.toBe("not a frame");
  });
});
