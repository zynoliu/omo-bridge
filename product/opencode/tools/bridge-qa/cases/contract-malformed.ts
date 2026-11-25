import type { CaseContext, CaseResult, Check } from "../run.ts";
import { ContractError, parseEvent } from "../../../packages/bridge-core/src/contracts.ts";

export async function run(_context: CaseContext): Promise<CaseResult> {
  let code = "none";
  try {
    parseEvent({ kind: "tool.completed", sequence: 1, sessionId: "ses_live", messageId: "msg_9", payload: 42 });
  } catch (error) {
    code = error instanceof ContractError ? error.code : "untyped";
  }
  const checks: Check[] = [
    {
      name: "wrong-field-type-rejected",
      expected: "ContractError WRONG_TYPE",
      observed: code,
      pass: code === "WRONG_TYPE",
    },
    {
      name: "unknown-variant-rejected",
      expected: "ContractError UNKNOWN_VARIANT",
      observed: (() => {
        try {
          parseEvent({ kind: "totally.new", sequence: 1, sessionId: "a", payload: "x" });
          return "accepted";
        } catch (error) {
          return error instanceof ContractError ? error.code : "untyped";
        }
      })(),
      pass: true,
    },
  ];
  checks[1] = { ...checks[1], pass: checks[1].observed === "UNKNOWN_VARIANT" };
  return { checks: checks, cleanup: { ok: true, detail: ["pure decode, no resources"] } };
}
