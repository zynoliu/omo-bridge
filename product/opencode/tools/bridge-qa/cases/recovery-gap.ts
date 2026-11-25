import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { MessageProjector } from "../../../packages/bridge-core/src/stream.ts";
import { planRecovery } from "../../../packages/bridge-core/src/recovery.ts";
import { pump } from "./stream-socket.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const projector = new MessageProjector();
  const before = await pump(path.join(context.out, "gap-a.sock"), [
    { kind: "partial", sequence: 0, text: "AB" },
    { kind: "message_end", sequence: 1, text: "AB" },
  ]);
  for (const frame of before) projector.apply(JSON.parse(frame) as unknown);
  const textBefore = projector.snapshot().text;

  const decision = planRecovery({
    cause: "client_disconnect",
    supportsReset: true,
    eventGap: true,
    replyLost: false,
    unconfirmedSideEffects: [],
    pendingDialogIds: [],
    heartbeatCapabilities: ["session.list"],
  });

  const after = await pump(path.join(context.out, "gap-b.sock"), [
    { kind: "message_end", sequence: 2, text: "AB" },
    { kind: "agent_idle", sequence: 3 },
  ]);
  for (const frame of after) projector.apply(JSON.parse(frame) as unknown);
  const state = projector.snapshot();

  const checks: Check[] = [
    { name: "resync-declared", expected: "reset", observed: String(decision.eventResync), pass: decision.eventResync === "reset" },
    {
      name: "message-not-duplicated-after-reconnect",
      expected: "AB",
      observed: JSON.stringify(state.text),
      pass: state.text === textBefore && state.text === "AB",
    },
    { name: "turn-ended-by-idle", expected: "idle", observed: state.status, pass: state.status === "idle" },
    { name: "tool-arguments-reset", expected: "true", observed: String(decision.resetToolArguments), pass: decision.resetToolArguments },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["both sockets removed by the pump helper"] } };
}
