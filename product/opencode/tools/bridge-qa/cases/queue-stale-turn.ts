import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { pump } from "./stream-socket.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const controller = new InteractionController();
  const stale = controller.startTurn();
  controller.abort(stale);
  const current = controller.startTurn();

  const frames = await pump(path.join(context.out, "stale.sock"), [{ turn: stale, kind: "steer", text: "late input" }]);
  const outcomes: string[] = [];
  for (const frame of frames) {
    const message = JSON.parse(frame) as { turn: string; kind: "steer"; text: string };
    const result = controller.submit(message.turn, message.kind, message.text);
    outcomes.push(result.kind === "accepted" ? "accepted" : result.code);
  }

  const checks: Check[] = [
    { name: "stale-turn-rejected", expected: "STALE_TURN", observed: outcomes[0] ?? "none", pass: outcomes[0] === "STALE_TURN" },
    {
      name: "session-unchanged",
      expected: "active turn still the current one and queue empty",
      observed: String(controller.state().activeTurn) + "/" + String(controller.pendingQueue().length),
      pass: controller.state().activeTurn === current && controller.pendingQueue().length === 0,
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["socket removed by the pump helper"] } };
}
