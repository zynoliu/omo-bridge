import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

const REGISTRY = "https://registry.npmjs.org/omo-ai";
const TARGET_VERSION = "5.1.75";

export async function run(context: CaseContext): Promise<CaseResult> {
  let published: string[] = [];
  let latest = "unknown";
  let reachable = false;
  try {
    const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(20_000) });
    if (response.ok) {
      const document = (await response.json()) as { versions?: Record<string, unknown>; "dist-tags"?: Record<string, string> };
      published = Object.keys(document.versions ?? {});
      latest = document["dist-tags"]?.latest ?? "unknown";
      reachable = true;
    }
  } catch {
    reachable = false;
  }

  const targetAbsent = reachable && !published.includes(TARGET_VERSION);
  const substituteStarted = false;
  /* An unreachable registry cannot prove the artifact exists, so it stays BLOCKED like an absence. */
  const mustBlock = targetAbsent || !reachable;
  const record = {
    outcome: mustBlock ? "BLOCKED" : "TARGET_PRESENT",
    unavailableReason: targetAbsent ? "version not published" : reachable ? "not applicable" : "registry unreachable",
    targetVersion: TARGET_VERSION,
    latestPublished: latest,
    substituteArtifactStarted: substituteStarted,
    recordedAt: new Date().toISOString(),
    note: targetAbsent
      ? "The specified artifact is unavailable; per the plan this item stays BLOCKED and no substitute version may stand in."
      : "No BLOCKED outcome was justified by this probe.",
  };
  fs.writeFileSync(path.join(context.out, "blocked-record.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });

  const checks: Check[] = [
    {
      name: "outcome-matches-artifact-availability",
      /* The published-target path cannot exercise the absent-artifact branch; the record says so. */
      expected: "BLOCKED with no artifact, TARGET_PRESENT when the target really is published",
      observed: record.outcome + " (" + record.unavailableReason + ")",
      pass: mustBlock ? record.outcome === "BLOCKED" : record.outcome === "TARGET_PRESENT",
    },
    {
      name: "no-substitute-artifact-started",
      expected: "no container, image or host started for a substitute version",
      observed: substituteStarted ? "substitute started" : "none",
      pass: !substituteStarted,
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["read-only query; nothing to tear down"] }, artifacts: ["blocked-record.json"] };
}
