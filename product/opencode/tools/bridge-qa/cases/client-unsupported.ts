import type { CaseContext, CaseResult, Check } from "../run.ts";
import { BridgeClient, UnsupportedCapability } from "../../../packages/bridge-core/src/client.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const client = new BridgeClient({
    data: new BridgeData(),
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
  });

  let observed = "no error";
  try {
    client.capability("plugin.registerContext");
  } catch (error) {
    observed = error instanceof UnsupportedCapability ? error.capability : "untyped error";
  }

  const checks: Check[] = [
    {
      name: "unsupported-capability-errors",
      expected: "UnsupportedCapability naming the capability",
      observed: observed,
      pass: observed === "plugin.registerContext",
    },
    {
      name: "no-silent-success",
      expected: "the call never returns a value",
      observed: observed === "no error" ? "returned" : "threw",
      pass: observed !== "no error",
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["no resources created"] } };
}
