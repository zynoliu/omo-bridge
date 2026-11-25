import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

const REGISTRY = "https://registry.npmjs.org/omo-ai";
const TARGET_VERSION = "5.1.75";

type RegistryDocument = { readonly versions?: Record<string, unknown>; readonly "dist-tags"?: Record<string, string> };

async function fetchRegistry(): Promise<RegistryDocument | undefined> {
  try {
    const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return undefined;
    return (await response.json()) as RegistryDocument;
  } catch {
    return undefined;
  }
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const document = await fetchRegistry();
  const versions = document?.versions ?? {};
  const published = Object.keys(versions);
  const hasTarget = published.includes(TARGET_VERSION);
  const latest = document?.["dist-tags"]?.latest ?? "unknown";

  const artifact = {
    registry: REGISTRY,
    targetVersion: TARGET_VERSION,
    latestPublished: latest,
    publishedVersionCount: published.length,
    targetPublished: hasTarget,
    queriedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(context.out, "artifact-query.json"), JSON.stringify(artifact, null, 2) + "\n", {
    mode: 0o600,
  });

  const checks: Check[] = [
    {
      name: "registry-reachable",
      expected: "the registry document is readable",
      observed: document === undefined ? "unreachable" : "readable",
      pass: document !== undefined,
    },
    {
      name: "target-artifact-published",
      expected: TARGET_VERSION + " published as an installable artifact",
      observed: hasTarget ? "published" : "absent (latest " + latest + ")",
      pass: hasTarget,
    },
  ];

  const blocked = !hasTarget;
  return {
    checks: checks,
    cleanup: { ok: true, detail: ["read-only registry query; no host was started"] },
    artifacts: ["artifact-query.json", blocked ? "outcome=BLOCKED" : "outcome=AVAILABLE"],
  };
}
