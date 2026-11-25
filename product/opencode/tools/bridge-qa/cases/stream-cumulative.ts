import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { MessageProjector } from "../../../packages/bridge-core/src/stream.ts";
import { pump } from "./stream-socket.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const frames = await pump(path.join(context.out, "stream.sock"), [
    { kind: "prompt_started", sequence: 0 },
    { kind: "partial", sequence: 1, text: "A" },
    { kind: "partial", sequence: 2, text: "AB" },
    { kind: "message_end", sequence: 3, text: "AB" },
  ]);

  const projector = new MessageProjector();
  for (const frame of frames) projector.apply(JSON.parse(frame) as unknown);
  const state = projector.snapshot();

  const checks: Check[] = [
    {
      name: "events-reach-projector-over-socket",
      expected: "4 frames",
      observed: String(frames.length),
      pass: frames.length === 4,
    },
    {
      name: "cumulative-text-not-duplicated",
      expected: "AB exactly once",
      observed: JSON.stringify(state.text),
      pass: state.text === "AB",
    },
    {
      name: "final-message-is-the-baseline",
      expected: "status complete",
      observed: state.status,
      pass: state.status === "complete",
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["socket removed by the pump helper"] } };
}
