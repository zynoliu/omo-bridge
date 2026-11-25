/**
 * Wires the DAG ledger to the four host channels.
 *
 * Channel names and the catch-up rule come from
 * upstream/oh-my-openagent/packages/omo-senpi/src/components/task/dag-rpc-bridge.ts:28-42 and
 * dag-rpc-handlers.ts:109-165:
 *
 * - `omo.dag.list` returns the run list (`{ runs, limit }`);
 * - `omo.dag.subscribe` is a STATELESS catch-up handshake: it reads the snapshot first, reports
 *   `highWaterSeq`, and returns a history page bounded by that mark. It registers no subscriber, so
 *   live events keep arriving only on the event channel;
 * - `omo.dag.history` pages the ledger and is what closes a `dag.stream.overflow` gap.
 *
 * Every answer is decoded before it is applied, and an overflow stops normal application until the
 * gap is closed.
 */
import type { BridgeData } from "../../../../../bridge-core/src/data.ts";
import { decodeHostExtensionFrame } from "../../../../../bridge-core/src/host-extension-frames.ts";
import type { DagLedger } from "./state.ts";

export type DagConnectOptions = {
  /** Rows asked of `omo.dag.list`; the host caps it. */
  readonly runLimit?: number;
  /** Rows asked per history page. */
  readonly pageLimit?: number;
  readonly onError?: (message: string) => void;
};

function field(value: object, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A host answer is `{ success, data }`; the payload lives under `data`. */
function payload(answer: unknown): unknown {
  if (typeof answer !== "object" || answer === null) return undefined;
  if ((answer as Record<string, unknown>)["success"] === false) return undefined;
  return (answer as Record<string, unknown>)["data"];
}

export function connectBridgeDag(ledger: DagLedger, data: BridgeData, options: DagConnectOptions = {}): () => void {
  const runLimit = options.runLimit ?? 50;
  const pageLimit = options.pageLimit ?? 200;
  const nextId = (prefix: string): string => prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  const request = (name: string, payloadIn: Record<string, unknown>, id: string): void => {
    data
      .requestExtension(id, { id: id, type: "extension_request", name: name, data: payloadIn })
      .then((answer) => {
        const value = payload(answer);
        if (value === undefined) {
          options.onError?.(name + " failed: " + refuseReason(answer));
          return;
        }
        if (name === "omo.dag.list") {
          if (typeof value === "object" && value !== null) {
            const runs = field(value, "runs");
            if (Array.isArray(runs)) ledger.replaceRuns(runs);
          }
          return;
        }
        if (name === "omo.dag.subscribe" || name === "omo.dag.history") {
          const runId = payloadIn["runId"];
          if (typeof value !== "object" || value === null) return;
          if (typeof runId !== "string") return;
          ledger.applyHistoryPage(runId, field(value, "events"));
        }
      })
      .catch((error: unknown) => {
        options.onError?.(name + " failed: " + (error instanceof Error ? error.message : String(error)));
      });
  };

  const stop = data.subscribeEvents((frame) => {
    const decoded = decodeHostExtensionFrame(frame);
    if (!decoded.ok || decoded.frame.kind !== "extension_event") return;
    const { name, data: body } = decoded.frame;
    if (name === "omo.dag.event") {
      ledger.applyEvent(body);
      return;
    }
    if (name === "omo.dag.heartbeat") {
      ledger.applyHeartbeat(body);
      return;
    }
    if (name === "omo.dag.activity") {
      ledger.noteActivity(body);
      return;
    }
    if (name === "omo.dag.updated") {
      if (Array.isArray(body)) ledger.replaceRuns(body);
      else if (typeof body === "object" && body !== null) ledger.replaceRuns(field(body, "runs"));
      return;
    }
    /* an overflow stops normal application and is repaired from history, never from the queue count */
    if (name !== "dag.stream.overflow" && name !== "omo.dag.overflow") return;
    if (typeof body !== "object" || body === null) return;
    const gap = ledger.applyOverflow(body);
    const runId = runIdOf(body);
    if (gap !== undefined && runId !== undefined)
      request("omo.dag.history", { runId: runId, throughSeq: gap.through, limit: pageLimit }, nextId("dag-history"));
  });

  if (data.hasExtensionRequester()) {
    request("omo.dag.list", { limit: runLimit }, nextId("dag-list"));
  }

  return stop;
}

function runIdOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  return text(field(body, "runId"));
}

function refuseReason(answer: unknown): string {
  if (typeof answer !== "object" || answer === null) return "the host returned no payload";
  const reason = field(answer, "reason");
  return typeof reason === "string" ? reason : "the host refused the request";
}
