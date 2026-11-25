import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * F1: does the plan describe what actually exists?
 *
 * This audit reads the plan and the artifacts it names; it re-runs nothing, so it cannot vouch for a QA
 * command that was never run. What it can catch is the failure mode that matters here: a task ticked
 * whose evidence is missing, ids or dependencies that do not line up, and a plan that reports itself
 * complete while items are still open.
 */
type Item = {
  readonly id: string;
  readonly ticked: boolean;
  readonly title: string;
  readonly blockedBy: readonly string[];
  readonly evidenceRefs: readonly string[];
};

const PLAN_RELATIVE = path.join(".omo", "plans", "bridge-product-plan.md");

/** The plan lives in the workspace, which is an ancestor of this case; walk up until it is found. */
function findPlan(qaRoot: string): string {
  /* A task worktree does not carry the plan, so the caller may name it explicitly; otherwise the
     nearest ancestor that has one wins. */
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

/** Evidence may sit beside the plan, under the product checkout, or at the worktree root. */
function evidenceRoots(planPath: string, qaRoot: string): string[] {
  const workspace = path.dirname(path.dirname(path.dirname(planPath)));
  return [
    path.join(workspace, ".omo", "evidence"),
    path.join(qaRoot, "..", "..", ".omo", "evidence"),
    /* A task worktree keeps its own evidence at the worktree root, four levels above tools/bridge-qa. */
    path.join(qaRoot, "..", "..", "..", "..", ".omo", "evidence"),
  ].map((value) => path.resolve(value));
}

function readPlan(qaRoot: string): { readonly plan: string; readonly planPath: string } {
  const planPath = findPlan(qaRoot);
  return { plan: readFileSync(planPath, "utf8"), planPath: planPath };
}

function parseItems(plan: string): Item[] {
  const lines = plan.split("\n");
  const items: Item[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const head = line.match(/^- \[( |x|X|~)\] (\S+?)\.?\s+(.*)$/);
    if (head === null) continue;
    /* One item's body runs until the next item head. */
    let end = index + 1;
    while (end < lines.length && !/^- \[( |x|X|~)\] /.test(lines[end] ?? "")) end += 1;
    const body = lines.slice(index, end).join("\n");
    /* An item the person took out of the delivery stays unticked on purpose; it still counts as settled
       for ordering and completeness so the audit does not report an item nobody may ever tick. */
    const outOfScope = /移出当前交付|user-out-of-scope/.test(body);
    const blocked = body.match(/Blocked by:\s*([^|]+)/);
    /* Dependencies are written as single ids or as a range with an en dash ("7–12"), so a range is
       expanded rather than read as one unknown id. */
    const blockedBy = (blocked?.[1] ?? "")
      .split(",")
      .flatMap((value) => {
        const token = value.trim().replace(/\.$/, "");
        const range = token.match(/^(\d+)\s*[–-]\s*(\d+)$/);
        if (range === null) return [token];
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 40) return [token];
        return Array.from({ length: to - from + 1 }, (_unused, offset) => String(from + offset));
      })
      .filter((value) => value.length > 0 && value !== "无");
    const evidenceRefs = [...body.matchAll(/\.omo\/evidence\/([A-Za-z0-9._\/-]+)/g)].map((match) => match[1] ?? "");
    items.push({
      id: head[2] ?? "?",
      ticked: head[1] !== " " || outOfScope,
      title: (head[3] ?? "").slice(0, 60),
      blockedBy: blockedBy,
      evidenceRefs: evidenceRefs,
    });
    index = end - 1;
  }
  return items;
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const read = readPlan(context.qaRoot);
  const items = parseItems(read.plan);
  const roots = evidenceRoots(read.planPath, context.qaRoot);

  record("plan-parses", "a list of items with ids", String(items.length) + " items", items.length > 0);

  const ids = items.map((item) => item.id);
  record("ids-are-unique", "no duplicate id", ids.length === new Set(ids).size ? "unique" : "duplicates present", ids.length === new Set(ids).size);

  /* Every evidence path a task names must exist: a plan that points at a missing receipt is rejected. */
  const missing: string[] = [];
  for (const item of items) {
    for (const ref of item.evidenceRefs) {
      if (!roots.some((root) => existsSync(path.join(root, ref)))) missing.push(item.id + ":" + ref);
    }
  }
  record(
    "named-evidence-exists",
    "every .omo/evidence path the plan names exists",
    missing.length === 0 ? "all present" : missing.slice(0, 4).join(", "),
    missing.length === 0,
  );

  /* A task may not be ticked before everything it is blocked by is ticked. */
  const byId = new Map(items.map((item) => [item.id, item]));
  const outOfOrder = items
    .filter((item) => item.ticked)
    .flatMap((item) =>
      item.blockedBy
        .filter((dependency) => byId.get(dependency)?.ticked !== true)
        .map((dependency) => item.id + " before " + dependency),
    );
  record(
    "ticks-respect-dependencies",
    "no ticked task waits on an open one",
    outOfOrder.length === 0 ? "consistent" : outOfOrder.slice(0, 4).join(", "),
    outOfOrder.length === 0,
  );

  const open = items.filter((item) => !item.ticked).map((item) => item.id);
  record(
    "plan-is-complete",
    "no open items",
    open.length === 0 ? "complete" : "open: " + open.join(", "),
    open.length === 0,
  );

  return {
    checks: checks,
    cleanup: { ok: true, detail: ["this case reads the plan and the evidence tree only; it starts nothing"] },
  };
}
