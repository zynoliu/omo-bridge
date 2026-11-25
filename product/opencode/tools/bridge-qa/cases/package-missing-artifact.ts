import { existsSync, renameSync } from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { auditArtifacts } from "../../../packages/cli/script/distribution.ts";

const ARCHES = ["arm64", "x64"] as const;

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const dist = path.resolve(context.qaRoot, "..", "..", "packages", "cli", "dist-bridge");
  const held = path.join(dist, "bridge-darwin-x64.held");
  let restored = false;

  try {
    const healthy = auditArtifacts(dist, [...ARCHES]);
    record(
      "built-artifacts-pass-the-release-gate",
      "both architectures exist and each launched binary refuses a missing --socket",
      healthy.ok
        ? "both launched and refused"
        : "missing=" + healthy.missing.join(",") + " unlaunchable=" + healthy.unlaunchable.join(","),
      healthy.ok,
    );

    /* Withholding one architecture is the failure the gate exists for: a release that claims a
       platform it did not ship must be refused, not silently accepted. */
    if (existsSync(path.join(dist, "bridge-darwin-x64"))) {
      renameSync(path.join(dist, "bridge-darwin-x64"), held);
      const withheld = auditArtifacts(dist, [...ARCHES]);
      record(
        "a-withheld-architecture-is-refused",
        "the gate reports x64 missing instead of claiming the platform",
        "ok=" + String(withheld.ok) + " missing=" + withheld.missing.join(","),
        !withheld.ok && withheld.missing.includes("x64"),
      );
      renameSync(held, path.join(dist, "bridge-darwin-x64"));
      restored = true;
    } else {
      record("a-withheld-architecture-is-refused", "an x64 directory to withhold", "x64 was already absent", false);
    }
  } finally {
    if (!restored && existsSync(held)) {
      renameSync(held, path.join(dist, "bridge-darwin-x64"));
      restored = true;
    }
  }

  detail.push(restored ? "x64 directory restored to " + path.join(dist, "bridge-darwin-x64") : "nothing was withheld");
  return { checks: checks, cleanup: { ok: restored, detail: detail } };
}
