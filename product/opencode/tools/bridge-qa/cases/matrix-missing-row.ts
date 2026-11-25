import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { validateCapabilityMatrix } from "../../../packages/bridge-core/spec/capability-matrix.ts";

export async function run(context: CaseContext): Promise<CaseResult> {
  const specPath = path.join(context.qaRoot, "..", "..", "packages", "bridge-core", "spec", "capabilities.json");
  const source = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
    items: { kind?: string }[];
    protocolRowCount?: number;
    sourceRowTotal?: number;
  };

  const items = Array.isArray(source.items) ? source.items.slice() : [];
  const removalIndex = items.findIndex((item) => item.kind === "protocol-row");
  if (removalIndex < 0) throw new Error("synthetic copy has no protocol row to delete");
  items.splice(removalIndex, 1);

  const tampered = { ...source, items: items };
  const problems = validateCapabilityMatrix(tampered as Parameters<typeof validateCapabilityMatrix>[0]);
  const rejectedForMissingRow = problems.some((problem) => problem.includes("source rows missing"));

  fs.writeFileSync(
    path.join(context.out, "tampered-matrix.json"),
    JSON.stringify({ removedProtocolRow: removalIndex, problems: problems }, null, 2) + "\n",
    { mode: 0o600 },
  );

  const checks: Check[] = [
    {
      name: "synthetic-copy-shrank",
      expected: "one protocol row removed from the copy",
      observed: String(items.length) + " items remain",
      pass: items.length === source.items.length - 1,
    },
    {
      name: "validator-rejects-missing-row",
      expected: "a 'source rows missing' problem",
      observed: problems.length === 0 ? "accepted (wrong)" : problems[0] ?? "",
      pass: rejectedForMissingRow,
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["only an in-directory copy was modified"] }, artifacts: ["tampered-matrix.json"] };
}
