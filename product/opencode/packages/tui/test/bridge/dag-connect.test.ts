import { describe, expect, test } from "bun:test";

import { BridgeData } from "../../../bridge-core/src/data.ts";
import { createExtensionRequester } from "../../../bridge-core/src/extension-request.ts";
import { connectBridgeDag } from "../../src/bridge/features/dag/connect.ts";
import { createDagLedger } from "../../src/bridge/features/dag/state.ts";

function wired() {
  const written: unknown[] = [];
  const requester = createExtensionRequester({ write: (frame) => written.push(frame) });
  const data = new BridgeData();
  data.setExtensionRequester(requester);
  const ledger = createDagLedger();
  const errors: string[] = [];
  const stop = connectBridgeDag(ledger, data, { onError: (message) => errors.push(message) });
  return { data: data, ledger: ledger, written: written, requester: requester, errors: errors, stop: stop };
}

function frameName(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const name = (frame as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : undefined;
}

function frameId(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const id = (frame as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

describe("dag channel wiring", () => {
  test("with a sender installed it asks for the run list once", () => {
    const context = wired();
    expect(context.written).toHaveLength(1);
    expect(frameName(context.written[0])).toBe("omo.dag.list");
    context.stop();
  });

  test("each channel lands in its own place", () => {
    const context = wired();
    context.data.publishEvent({ type: "extension_event", name: "omo.dag.event", data: { runId: "run-1", seq: 1 } });
    context.data.publishEvent({ type: "extension_event", name: "omo.dag.heartbeat", data: { schemaVersion: 1, at: "2026-11-18T01:00:00Z", runs: [] } });
    context.data.publishEvent({ type: "extension_event", name: "omo.dag.activity", data: { runId: "run-1", kind: "progress" } });
    context.data.publishEvent({ type: "extension_event", name: "omo.dag.updated", data: { runs: [{ runId: "run-2", status: "running" }] } });
    expect(context.ledger.events("run-1")).toHaveLength(1);
    expect(context.ledger.heartbeatAt()).toBe("2026-11-18T01:00:00Z");
    expect(context.ledger.activity()).toHaveLength(1);
    expect(context.ledger.runs().map((run) => run.runId)).toEqual(["run-2"]);
    context.stop();
  });

  test("an overflow asks the host for the bounded history page", () => {
    const context = wired();
    context.data.publishEvent({ type: "extension_event", name: "omo.dag.event", data: { runId: "run-1", seq: 1 } });
    context.data.publishEvent({
      type: "extension_event",
      name: "dag.stream.overflow",
      data: { runId: "run-1", seq: 4, recoverAfterSeq: 1, droppedCount: 2 },
    });
    const history = context.written.filter((frame) => frameName(frame) === "omo.dag.history");
    expect(history).toHaveLength(1);
    const answer = history[0];
    expect(answer).toBeDefined();
    const payload =
      typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>)["data"] : undefined;
    expect(payload).toEqual({ runId: "run-1", throughSeq: 4, limit: 200 });
    expect(context.ledger.gap("run-1")).toEqual({ after: 1, through: 4, droppedCount: 2 });
    context.stop();
  });

  test("the history answer closes the gap and a second answer for the same id resolves nothing", async () => {
    const context = wired();
    context.data.publishEvent({ type: "extension_event", name: "omo.dag.event", data: { runId: "run-1", seq: 1 } });
    context.data.publishEvent({
      type: "extension_event",
      name: "dag.stream.overflow",
      data: { runId: "run-1", seq: 3, recoverAfterSeq: 1, droppedCount: 1 },
    });
    const history = context.written.find((frame) => frameName(frame) === "omo.dag.history");
    const id = frameId(history);
    if (id === undefined) throw new Error("no id on the history request");
    context.requester.accept(id, {
      id: id,
      success: true,
      data: { events: [{ runId: "run-1", seq: 2 }, { runId: "run-1", seq: 3 }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(context.ledger.gap("run-1")).toBeUndefined();
    expect(context.ledger.events("run-1").map((event) => event.seq)).toEqual([1, 2, 3]);
    context.stop();
  });

  test("a refused pull is reported instead of being treated as an empty run list", async () => {
    const context = wired();
    const list = context.written.find((frame) => frameName(frame) === "omo.dag.list");
    const id = frameId(list);
    if (id === undefined) throw new Error("no id on the list request");
    context.requester.accept(id, { id: id, success: false, reason: "No such parent session on this connection." });
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (context.errors.length !== 1 || !context.errors[0]?.includes("No such parent session")) throw new Error("errors=" + JSON.stringify(context.errors));
    context.stop();
  });
});
