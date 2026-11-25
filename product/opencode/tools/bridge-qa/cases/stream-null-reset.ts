import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { MessageProjector } from "../../../packages/bridge-core/src/stream.ts";
import { pump } from "./stream-socket.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "stream-reset.sock");
  const frames = await pump(socketPath, [
    { kind: "partial", sequence: 0, text: "keep" },
    { kind: "tool_call", sequence: 1, callId: "c1", arguments: "{\"old\":true}" },
    { kind: "partial", sequence: 2, text: null },
    { kind: "reset", sequence: 3 },
    { kind: "tool_call", sequence: 4, callId: "c1", arguments: "{\"new\":true}" },
  ]);

  const projector = new MessageProjector();
  let threw = "none";
  try {
    for (const frame of frames) projector.apply(JSON.parse(frame) as unknown);
  } catch (error) {
    threw = String(error);
  }
  const state = projector.snapshot();
  const stale = state.tools.some((tool) => tool.arguments.includes("old"));

  const checks: Check[] = [
    { name: "null-partial-does-not-throw", expected: "none", observed: threw, pass: threw === "none" },
    {
      name: "null-partial-ignored-explicitly",
      expected: "PARTIAL_WITHOUT_TEXT recorded",
      observed: state.ignored.join(","),
      pass: state.ignored.includes("PARTIAL_WITHOUT_TEXT"),
    },
    {
      name: "reset-clears-old-arguments",
      expected: "no stale arguments after reset",
      observed: stale ? "stale" : "cleared",
      pass: !stale && state.tools.length === 1 && state.tools[0]?.arguments === "{\"new\":true}",
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["socket removed by the pump helper"] } };
}
