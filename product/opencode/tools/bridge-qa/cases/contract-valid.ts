import type { CaseContext, CaseResult, Check } from "../run.ts";
import { parseEvent } from "../../../packages/bridge-core/src/contracts.ts";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const event = parseEvent({ kind: "tool.completed", sequence: 42, sessionId: "ses_live", messageId: "msg_9", payload: "done" });
  const checks: Check[] = [
    {
      name: "valid-event-accepted",
      expected: "kind tool.completed with sequence 42",
      observed: event.kind + " seq=" + String(event.sequence),
      pass: event.kind === "tool.completed" && event.sequence === 42 && event.messageId === "msg_9",
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["pure decode, no resources"] } };
}
