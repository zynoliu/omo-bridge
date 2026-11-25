import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * F4: does every IS row have delivering tasks, a QA scenario that exists, and evidence on disk?
 *
 * The audit is mechanical on purpose. It does not judge whether a scenario was any good; it checks
 * that the plan's own success table is not pointing at cases or receipts that do not exist, which is
 * how a "complete" plan ends up resting on nothing.
 */
type Row = {
  readonly is: string;
  readonly tasks: readonly string[];
  readonly scenarios: readonly string[];
  readonly evidence: readonly string[];
};

const TICK = String.fromCharCode(96);
const PLAN_RELATIVE = path.join(".omo", "plans", "bridge-product-plan.md");

function findPlan(qaRoot: string): string {
  const named = process.env.BRIDGE_PLAN_PATH;
  if (named !== undefined && named.length > 0) {
    if (!existsSync(named)) throw new Error("BRIDGE_PLAN_PATH does not exist: " + named);
    return named;
  }
  /* The plan may live in the main checkout while the QA runs in a worktree; an explicit override keeps the
     contract single-sourced instead of copying a 73 KB plan into every worktree. */
  const override = process.env.BRIDGE_QA_PLAN_FILE;
  if (override && existsSync(override)) return path.resolve(override);
  let current = path.resolve(qaRoot);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, PLAN_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("no " + PLAN_RELATIVE + " above " + qaRoot);
}

/** Task cells list single ids or en-dash ranges ("7-12"), so a range is expanded. */
function expandTasks(cell: string): string[] {
  return cell
    .split(",")
    .flatMap((value) => {
      const token = value.trim();
      const range = token.match(/^(\\d+)\\s*[\u2013-]\\s*(\\d+)$/);
      if (range === null) return [token];
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 40) return [token];
      return Array.from({ length: to - from + 1 }, (_unused, offset) => String(from + offset));
    })
    .filter((value) => value.length > 0);
}

/** Code spans inside a table cell, without depending on the tick character appearing literally. */
function codeSpans(cell: string): string[] {
  const parts = cell.split(TICK);
  const spans: string[] = [];
  for (let index = 1; index < parts.length; index += 2) {
    const span = (parts[index] ?? "").trim();
    if (span.length > 0) spans.push(span);
  }
  return spans;
}

function parseRows(plan: string): Row[] {
  const rows: Row[] = [];
  for (const line of plan.split("\n")) {
    if (!line.startsWith("| IS-")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    const is = cells[1] ?? "";
    const tasks = expandTasks(cells[2] ?? "");
    const scenarios = codeSpans(cells[3] ?? "").filter((span) => !span.includes(" "));
    /* Every code span in the evidence cell is an evidence name; only the first is written with the
       $QA_EVIDENCE prefix, the rest are relative names in the same cell. */
    const evidence = codeSpans(cells[4] ?? "").map((span) =>
      (span.startsWith("$QA_EVIDENCE/") ? span.slice("$QA_EVIDENCE/".length) : span).replace(/\/$/, ""),
    );
    rows.push({ is: is, tasks: tasks, scenarios: scenarios, evidence: evidence });
  }
  return rows;
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const planPath = findPlan(context.qaRoot);
  const rows = parseRows(readFileSync(planPath, "utf8"));
  const workspace = path.dirname(path.dirname(path.dirname(planPath)));
  const evidenceRoots = [
    path.join(workspace, ".omo", "evidence"),
    path.resolve(context.qaRoot, "..", "..", ".omo", "evidence"),
  ];
  const casesDir = path.join(context.qaRoot, "cases");
  const available = new Set(readdirSync(casesDir).map((name) => name.replace(/\.ts$/, "")));

  /* The plan restates the table in more than one place, so rows are folded per IS before counting. */
  const byIs = new Map<string, Row>();
  for (const row of rows) {
    const previous = byIs.get(row.is);
    if (previous === undefined) {
      byIs.set(row.is, row);
      continue;
    }
    byIs.set(row.is, {
      is: row.is,
      tasks: [...new Set([...previous.tasks, ...row.tasks])],
      scenarios: [...new Set([...previous.scenarios, ...row.scenarios])],
      evidence: [...new Set([...previous.evidence, ...row.evidence])],
    });
  }
  const unique = [...byIs.values()];
  record("success-table-parses", "eight distinct IS rows", String(unique.length) + " distinct IS rows", unique.length === 8);

  const noTasks = unique.filter((row) => row.tasks.length === 0).map((row) => row.is);
  record(
    "every-is-names-delivering-tasks",
    "each IS row lists at least one task",
    noTasks.length === 0 ? "all rows have tasks" : "missing: " + noTasks.join(", "),
    noTasks.length === 0,
  );

  const missingCases: string[] = [];
  for (const row of unique) {
    for (const scenario of row.scenarios) {
      if (!available.has(scenario)) missingCases.push(row.is + ":" + scenario);
    }
  }
  record(
    "every-named-qa-case-exists",
    "each QA scenario the table names is a case file",
    missingCases.length === 0 ? "all present" : "missing: " + missingCases.slice(0, 6).join(", "),
    missingCases.length === 0,
  );

  const missingEvidence: string[] = [];
  for (const row of unique) {
    for (const item of row.evidence) {
      if (!evidenceRoots.some((root) => existsSync(path.join(root, item)))) missingEvidence.push(row.is + ":" + item);
    }
  }
  record(
    "every-is-has-evidence",
    "each evidence path the table names exists",
    missingEvidence.length === 0 ? "all present" : "missing: " + missingEvidence.slice(0, 6).join(", "),
    missingEvidence.length === 0,
  );

  return {
    checks: checks,
    cleanup: { ok: true, detail: ["this case reads the plan, the case directory and the evidence tree only"] },
  };
}
