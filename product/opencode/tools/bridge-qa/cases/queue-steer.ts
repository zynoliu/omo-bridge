import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { pump } from "./stream-socket.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const controller = new InteractionController();
  const first = controller.startTurn();
  const frames = await pump(path.join(context.out, "queue.sock"), [
    { turn: first, kind: "steer", text: "be brief" },
    { turn: first, kind: "follow_up", text: "then test" },
  ]);
  const outcomes: string[] = [];
  for (const frame of frames) {
    const message = JSON.parse(frame) as { turn: string; kind: "steer" | "follow_up"; text: string };
    const result = controller.submit(message.turn, message.kind, message.text);
    outcomes.push(result.kind);
  }
  controller.completeTurn(first);
  const second = controller.startTurn();
  const queued = controller.pendingQueue();

  const checks: Check[] = [
    { name: "two-inputs-accepted", expected: "accepted,accepted", observed: outcomes.join(","), pass: outcomes.join(",") === "accepted,accepted" },
    {
      name: "queue-carries-into-next-turn",
      expected: "2 inputs bound to the second turn",
      observed: String(queued.length) + " bound to " + (queued[0]?.turn ?? "none"),
      pass: queued.length === 2 && queued.every((input) => input.turn === second),
    },
    {
      name: "text-preserved",
      expected: "be brief,then test",
      observed: queued.map((input) => input.text).join(","),
      pass: queued.map((input) => input.text).join(",") === "be brief,then test",
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["socket removed by the pump helper"] } };
}
