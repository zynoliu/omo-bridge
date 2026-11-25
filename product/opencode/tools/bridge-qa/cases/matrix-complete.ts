import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { validateCapabilityMatrix } from "../../../packages/bridge-core/spec/capability-matrix.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const specPath = path.join(context.qaRoot, "..", "..", "packages", "bridge-core", "spec", "capabilities.json");
  const raw = fs.readFileSync(specPath, "utf8");
  const matrix = JSON.parse(raw) as Parameters<typeof validateCapabilityMatrix>[0];
  const problems = validateCapabilityMatrix(matrix);
  const items = (matrix.items ?? []) as { kind?: string }[];
  const protocolRows = items.filter((item) => item.kind === "protocol-row").length;
  /* Seams are named, not counted: extra non-protocol rows (native surfaces) are legitimate. */
  const seamKeys = ["N-MINI", "N-PLUGIN", "N-MCP"];
  const seams = seamKeys.filter((key) => items.some((item) => item.key === key)).length;

  fs.writeFileSync(path.join(context.out, "matrix-copy.json"), raw, { mode: 0o600 });

  const checks: Check[] = [
    {
      name: "every-source-row-mapped",
      expected: "95 protocol rows present",
      observed: String(protocolRows),
      pass: protocolRows === 95,
    },
    {
      name: "required-seams-mapped",
      expected: "the three named seams N-MINI, N-PLUGIN and N-MCP are present",
      observed: String(seams) + " of 3",
      pass: seams === 3,
    },
    {
      name: "validator-accepts",
      expected: "no problems",
      observed: problems.length === 0 ? "none" : problems.slice(0, 3).join(" | "),
      pass: problems.length === 0,
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["no external resources created"] }, artifacts: ["matrix-copy.json"] };
}
