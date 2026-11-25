import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * Task 31: can the capability matrix be released as it stands?
 *
 * Every row the matrix carries has a status. A release is only honest when each row the plan selected is
 * `verified`; `unverified`, `blocked` and `unsupported` rows mean the product is claiming less than it
 * promises, and `degraded` means it is claiming something different. The case counts them and refuses
 * to call the matrix releasable while any remain, so the answer does not depend on how many tests pass.
 */
type Item = {
  readonly key: string;
  readonly kind: string;
  readonly status: string;
};

type Matrix = {
  readonly kind: string;
  readonly version: number;
  readonly statusValues: readonly string[];
  readonly items: readonly Item[];
};

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const matrixPath = path.resolve(context.qaRoot, "..", "..", "packages", "bridge-core", "spec", "capabilities.json");
  const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as Matrix;

  record("matrix-parses", "a bridge capability matrix", matrix.kind + " v" + String(matrix.version), matrix.kind === "bridge-capability-matrix");
  const unknown = matrix.items.filter((item) => !matrix.statusValues.includes(item.status));
  record(
    "every-row-uses-a-declared-status",
    "no status outside " + matrix.statusValues.join("/"),
    unknown.length === 0 ? "all declared" : unknown.slice(0, 5).map((item) => item.key + "=" + item.status).join(", "),
    unknown.length === 0,
  );

  const counts = new Map<string, number>();
  for (const item of matrix.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const summary = [...counts].map(([status, count]) => status + "=" + String(count)).join(", ");

  const verified = matrix.items.filter((item) => item.status === "verified");
  record(
    "matrix-reports-its-own-distribution",
    "a status for every row",
    summary,
    verified.length + (counts.get("unverified") ?? 0) + (counts.get("blocked") ?? 0) + (counts.get("degraded") ?? 0) + (counts.get("unsupported") ?? 0) === matrix.items.length,
  );

  /* Rows the person explicitly put out of scope do not block a release; any other non-verified row does. */
  const outOfScope = (item: { readonly userScope?: string }) => String(item.userScope ?? "").includes("user-approved");
  const notVerified = matrix.items.filter((item) => item.status !== "verified" && !outOfScope(item));
  record(
    "release-needs-every-row-verified",
    "no unverified, blocked, degraded or unsupported row",
    notVerified.length === 0 ? "all verified" : String(notVerified.length) + " not verified: " + notVerified.slice(0, 5).map((item) => item.key + "=" + item.status).join(", "),
    notVerified.length === 0,
  );

  /* A row that names evidence which no longer exists is not evidence. Both roots are checked because the
     matrix is read from the product checkout while some cited paths are repository-root relative. */
  const productRoot = path.resolve(context.qaRoot, "..", "..");
  /* Product checkout root and the repository root above it, so both `packages/...` and
     `product/opencode/...` references resolve. */
  const repoRoot = path.resolve(productRoot, "..", "..");
  const resolves = (reference: string) =>
    existsSync(path.resolve(productRoot, reference)) || existsSync(path.resolve(repoRoot, reference));
  const cited = matrix.items.filter((item) => item.status === "verified" || item.status === "degraded");
  const dangling: string[] = [];
  for (const item of cited) {
    const tokens = String((item as { evidence?: string }).evidence ?? "")
      .split(/,\s*/)
      .filter((token) => token.length > 0 && !token.includes(" "));
    /* Every path the row names has to exist: one resolvable token used to hide the rest. */
    for (const token of tokens) {
      if (!token.includes("/")) continue;
      if (!resolves(token)) dangling.push(item.key + " -> " + token);
    }
  }
  record(
    "every-verified-row-cites-existing-evidence",
    "each path a verified or degraded row names exists",
    dangling.length === 0 ? "all " + String(cited.length) + " rows resolve" : dangling.slice(0, 5).join("; ") + (dangling.length > 5 ? " (+ more)" : ""),
    dangling.length === 0,
  );

  detail.push("read the matrix only; nothing was started");
  return { checks: checks, cleanup: { ok: true, detail: detail } };
}
