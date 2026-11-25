const STATUS = ["unverified", "verified", "degraded", "unsupported", "blocked"] as const;

type MatrixItem = {
  readonly key?: unknown;
  readonly kind?: unknown;
  readonly sourceLocation?: unknown;
  readonly sourceTopic?: unknown;
  readonly targetCapability?: unknown;
  readonly semanticDifference?: unknown;
  readonly userScope?: unknown;
  readonly implementationTask?: unknown;
  readonly test?: unknown;
  readonly evidence?: unknown;
  readonly userVisibleConsequence?: unknown;
  readonly status?: unknown;
};

export type Matrix = {
  readonly protocolRowCount?: unknown;
  readonly sourceRowTotal?: unknown;
  readonly seamCount?: unknown;
  readonly items?: unknown;
};

const REQUIRED_SEAMS = ["N-MINI", "N-PLUGIN", "N-MCP"] as const;

function nonEmptyText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateCapabilityMatrix(matrix: Matrix): readonly string[] {
  const problems: string[] = [];
  if (!Array.isArray(matrix.items)) return ["items is not an array"];

  const items = matrix.items as MatrixItem[];
  const keys = new Set<string>();
  const protocolRows = items.filter((item) => item.kind === "protocol-row");

  for (const item of items) {
    if (!nonEmptyText(item.key)) {
      problems.push("item without a key");
      continue;
    }
    const key = item.key as string;
    if (keys.has(key)) problems.push("duplicate key " + key);
    keys.add(key);

    for (const field of ["sourceLocation", "sourceTopic", "targetCapability", "semanticDifference", "userScope", "userVisibleConsequence"] as const) {
      if (!nonEmptyText(item[field])) problems.push(key + ": empty " + field);
    }
    if (!nonEmptyText(item.test)) problems.push(key + ": empty test");
    if (!nonEmptyText(item.evidence)) problems.push(key + ": empty evidence");

    const task = item.implementationTask;
    if (typeof task !== "number" || !Number.isInteger(task) || task < 1 || task > 32) {
      problems.push(key + ": implementationTask must be an integer plan task id 1..32");
    }
    const status = item.status;
    if (typeof status !== "string" || !(STATUS as readonly string[]).includes(status)) {
      problems.push(key + ": unsupported status " + String(status));
    }
  }

  if (typeof matrix.sourceRowTotal !== "number") problems.push("sourceRowTotal missing");
  if (typeof matrix.protocolRowCount !== "number") problems.push("protocolRowCount missing");
  if (matrix.protocolRowCount !== protocolRows.length) {
    problems.push("protocolRowCount " + String(matrix.protocolRowCount) + " does not match " + String(protocolRows.length) + " protocol rows");
  }
  if (matrix.sourceRowTotal !== protocolRows.length) {
    problems.push("source rows missing: expected " + String(matrix.sourceRowTotal) + " mapped rows, found " + String(protocolRows.length));
  }

  for (const seam of REQUIRED_SEAMS) {
    if (!keys.has(seam)) problems.push("missing required seam " + seam);
  }
  return problems;
}
