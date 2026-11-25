import { describe, expect, test } from "bun:test";

import { createExtensionRequester, ExtensionRequestError } from "../src/extension-request.ts";

function makeRequester(options: { failWrite?: boolean } = {}) {
  const written: unknown[] = [];
  const timers: Array<{ run: () => void; cancelled: boolean }> = [];
  const requester = createExtensionRequester({
    write: (frame) => {
      if (options.failWrite === true) throw new Error("socket closed");
      written.push(frame);
    },
    timeoutMs: 1000,
    setTimer: (run) => {
      const entry = { run: run, cancelled: false };
      timers.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
  });
  return { requester, written, timers };
}

describe("extension request correlator", () => {
  test("a request resolves only with the answer carrying its own id", async () => {
    const { requester, written } = makeRequester();
    const pending = requester.request("req-1", { type: "extension_request", id: "req-1", name: "omo.memory.status" });
    expect(written).toEqual([{ type: "extension_request", id: "req-1", name: "omo.memory.status" }]);
    expect(requester.accept("req-2", { id: "req-2", success: true })).toBe("unknown");
    expect(requester.pending()).toEqual(["req-1"]);
    expect(requester.accept("req-1", { id: "req-1", success: true, data: { ok: true } })).toBe("resolved");
    await expect(pending).resolves.toEqual({ id: "req-1", success: true, data: { ok: true } });
  });

  test("a repeated answer for the same id is reported as a duplicate and resolves nothing", async () => {
    const { requester } = makeRequester();
    const pending = requester.request("req-1", {});
    requester.accept("req-1", { id: "req-1" });
    await pending;
    expect(requester.accept("req-1", { id: "req-1" })).toBe("duplicate");
  });

  test("a second request with the same pending id is refused", async () => {
    const { requester } = makeRequester();
    void requester.request("req-1", {});
    await expect(requester.request("req-1", {})).rejects.toBeInstanceOf(ExtensionRequestError);
  });

  test("a timeout is reported rather than left hanging", async () => {
    const { requester, timers } = makeRequester();
    const pending = requester.request("req-1", {});
    const first = timers[0];
    if (first !== undefined) first.run();
    await expect(pending).rejects.toThrow(/no answer for request req-1/);
    expect(requester.pending()).toEqual([]);
  });

  test("a write failure rejects the request and leaves nothing pending", async () => {
    const { requester } = makeRequester({ failWrite: true });
    await expect(requester.request("req-1", {})).rejects.toThrow(/could not be written/);
    expect(requester.pending()).toEqual([]);
  });

  test("closing the transport rejects every pending request and reports how many", async () => {
    const { requester } = makeRequester();
    const first = requester.request("a", {});
    const second = requester.request("b", {});
    const settled = Promise.all([first.catch((error: unknown) => error), second.catch((error: unknown) => error)]);
    expect(requester.failAll("transport closed")).toBe(2);
    const outcomes = await settled;
    expect(outcomes.every((value) => value instanceof ExtensionRequestError)).toBe(true);
    expect(requester.pending()).toEqual([]);
  });
});
