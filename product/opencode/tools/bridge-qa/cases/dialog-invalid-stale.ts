import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { pump } from "./stream-socket.ts";

const ONCE = [{ value: "allow-once", label: "Allow once", onceOnly: true }];

export async function run(context: CaseContext): Promise<CaseResult> {
  const frames = await pump(path.join(context.out, "dialog-stale.sock"), [
    { op: "open", id: "d1", kind: "select", options: ONCE, required: false },
    { op: "expire", id: "d1" },
    { op: "answer", id: "d1", value: "allow-once" },
    { op: "open", id: "d2", kind: "select", options: ONCE, required: false },
    { op: "answer", id: "d2", value: "allow-forever" },
  ]);

  const registry = new DialogRegistry();
  const outcomes: string[] = [];
  for (const frame of frames) {
    const message = JSON.parse(frame) as { op: string; id: string; options?: typeof ONCE; value?: string };
    if (message.op === "open") {
      registry.open({ id: message.id, kind: "select", options: message.options ?? ONCE, required: false });
    } else if (message.op === "expire") {
      registry.expire(message.id);
    } else if (message.op === "answer") {
      const result = registry.answer(message.id, message.value ?? "");
      outcomes.push(result.kind === "accepted" ? "accepted" : "refused:" + result.code);
    }
  }

  const checks: Check[] = [
    {
      name: "expired-dialog-refuses-late-answer",
      expected: "refused:NOT_PENDING",
      observed: outcomes[0] ?? "none",
      pass: outcomes[0] === "refused:NOT_PENDING",
    },
    {
      name: "unknown-option-refused",
      expected: "refused:UNKNOWN_OPTION",
      observed: outcomes[1] ?? "none",
      pass: outcomes[1] === "refused:UNKNOWN_OPTION",
    },
    {
      name: "no-authorization-recorded",
      expected: "both dialogs remain unanswered",
      observed: (registry.get("d1")?.answer ?? "null") + "/" + (registry.get("d2")?.answer ?? "null"),
      pass: registry.get("d1")?.answer === null && registry.get("d2")?.answer === null,
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["socket removed by the pump helper"] } };
}
