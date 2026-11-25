import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { pump } from "./stream-socket.ts";

const ONCE = [
  { value: "allow-once", label: "Allow once", onceOnly: true },
  { value: "deny", label: "Deny", onceOnly: false },
];

export async function run(context: CaseContext): Promise<CaseResult> {
  const frames = await pump(path.join(context.out, "dialog.sock"), [
    { op: "open", id: "d1", kind: "confirm", options: ONCE, required: false },
    { op: "answer", id: "d1", value: "allow-once" },
    { op: "answer", id: "d1", value: "deny" },
  ]);

  const registry = new DialogRegistry();
  const outcomes: string[] = [];
  for (const frame of frames) {
    const message = JSON.parse(frame) as { op: string; id: string; kind?: string; options?: typeof ONCE; required?: boolean; value?: string };
    if (message.op === "open") {
      registry.open({ id: message.id, kind: "confirm", options: message.options ?? ONCE, required: message.required ?? false });
      outcomes.push("opened");
    } else if (message.op === "answer") {
      const result = registry.answer(message.id, message.value ?? "");
      outcomes.push(result.kind === "accepted" ? "accepted:" + result.value : "refused:" + result.code);
    }
  }

  const checks: Check[] = [
    { name: "three-messages-delivered", expected: "3 frames", observed: String(frames.length), pass: frames.length === 3 },
    {
      name: "first-answer-accepted-once",
      expected: "accepted:allow-once then refused:ALREADY_ANSWERED",
      observed: outcomes.slice(1).join(","),
      pass: outcomes[1] === "accepted:allow-once" && outcomes[2] === "refused:ALREADY_ANSWERED",
    },
    {
      name: "authorization-not-claimed-server-side",
      expected: "dialog answered with a raw once-only value",
      observed: registry.get("d1")?.answer ?? "none",
      pass: registry.get("d1")?.answer === "allow-once" && registry.get("d1")?.state === "answered",
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["socket removed by the pump helper"] } };
}
