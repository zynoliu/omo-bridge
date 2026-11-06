import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRouter } from "../../src/http/router";
import { routes } from "../../src/http/routes";

// The ledger's `capability` field is a boolean with a fixed contract: false means senpi cannot back
// the family at all (every answer is a shim), true means the bridge answers from state it reads
// itself. The file, DEGRADATIONS.md:22-49 and GET /api/bridge/capabilities must agree.

const REPO_ROOT = join(import.meta.dir, "..", "..");
const LEDGER_FILE = join(REPO_ROOT, "contracts", "bridge", "capabilities.json");
const DEGRADATIONS_FILE = join(REPO_ROOT, "DEGRADATIONS.md");
const CAPABILITIES_PATH = "/api/bridge/capabilities";

const FAMILY_FIELDS = ["family", "endpoints", "capability", "tuiBehaviour", "reason"] as const;

const REQUIRED_FAMILIES = ["mcp", "skills", "plugins", "usage", "worktree"] as const;

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
type Method = (typeof METHODS)[number];

type Family = {
  family: string;
  endpoints: string[];
  capability: boolean;
  tuiBehaviour: string;
  reason: string;
};

type MountedRoute = { method: string; path: string };

type TableEndpoint = { spec: string; route: MountedRoute };

const MOUNTED: MountedRoute[] = routes.map(({ method, path }) => ({ method, path }));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathOf(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

function shapeOf(path: string): string {
  return pathOf(path)
    .map((segment) => (segment.startsWith(":") || segment === "*" ? ":" : segment))
    .join("/");
}

function endpointKey(method: string, path: string): string {
  return `${method} ${shapeOf(path)}`;
}

function sameTail(route: MountedRoute, tail: string[]): boolean {
  const segments = pathOf(route.path).map((segment) => (segment.startsWith(":") ? ":" : segment));
  if (segments.length < tail.length) return false;
  return segments.slice(-tail.length).every((segment, index) => segment === tail[index]);
}

function exactCandidates(method: Method | null, path: string): MountedRoute[] {
  const target = shapeOf(path);
  return MOUNTED.filter((route) => shapeOf(route.path) === target && (method === null || route.method === method));
}

function suffixCandidates(method: Method | null, path: string): MountedRoute[] {
  const tail = pathOf(path).map((segment) => (segment.startsWith(":") ? ":" : segment));
  return MOUNTED.filter((route) => (method === null || route.method === method) && sameTail(route, tail));
}

// `.../connect` in the table reuses a prefix written above, so shorthand is resolved by suffix over
// the mounted route table: zero matches or several matches fail the test instead of picking one.
function resolveSpan(spec: string): TableEndpoint {
  const match = /^(GET|POST|PATCH|PUT|DELETE)\s+(.+)$/.exec(spec);
  const method = match === null ? null : (match[1] as Method);
  const path = (match === null ? spec : match[2]!).trim();
  const candidates = path.startsWith("...") ? suffixCandidates(method, path.slice(3)) : exactCandidates(method, path);
  if (candidates.length !== 1) {
    const seen = candidates.map((route) => `${route.method} ${route.path}`).join(", ") || "none";
    throw new Error(`DEGRADATIONS.md: cannot resolve \`${spec}\` to exactly one mounted route (candidates: ${seen})`);
  }
  return { spec, route: candidates[0]! };
}

function endpointSpansOf(cell: string): string[] {
  const spans: string[] = [];
  for (const match of cell.matchAll(/`([^`]+)`/g)) {
    const span = match[1]!.trim();
    if (/^(GET|POST|PATCH|PUT|DELETE)\s/.test(span) || span.startsWith("/api/") || span.startsWith(".../")) {
      spans.push(span);
    }
  }
  return spans;
}

function degradedEndpoints(): TableEndpoint[] {
  const lines = readFileSync(DEGRADATIONS_FILE, "utf8").split("\n");
  const header = lines.findIndex((line) => line.startsWith("| Endpoint(s) |"));
  if (header < 0) throw new Error("DEGRADATIONS.md: the `| Endpoint(s) |` table header is missing");
  const endpoints: TableEndpoint[] = [];
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.startsWith("|")) break;
    if (/^\|\s*:?-{3,}/.test(line)) continue;
    const cell = line.split("|")[1] ?? "";
    for (const spec of endpointSpansOf(cell)) endpoints.push(resolveSpan(spec));
  }
  if (endpoints.length === 0) throw new Error("DEGRADATIONS.md: the endpoint table parsed to zero endpoints");
  return endpoints;
}

// Guards against a ledger so coarse that one entry swallows unrelated surfaces. `/api/session/...`
// keeps its sub-resource so `session.diff` and `session.terminal` stay distinct families.
function familyOf(routePath: string): string {
  const statics = pathOf(routePath)
    .slice(1)
    .filter((segment) => !segment.startsWith(":") && segment !== "*" && segment !== "experimental");
  const head = statics[0];
  if (head === undefined) return "";
  if (head !== "session") return head;
  const sub = statics[1];
  return sub === undefined ? "session" : `session.${sub}`;
}

function readLedger(problems: string[]): Family[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(LEDGER_FILE, "utf8"));
  } catch (error) {
    problems.push(`ledger is not readable JSON: ${(error as Error).message}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    problems.push("ledger must be a JSON array of family entries");
    return [];
  }
  const families: Family[] = [];
  const seen = new Set<string>();
  const expectedFields = [...FAMILY_FIELDS].sort().join(",");
  for (const [index, entry] of parsed.entries()) {
    const where = `ledger[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${where}: not an object`);
      continue;
    }
    const fields = Object.keys(entry).sort().join(",");
    if (fields !== expectedFields) problems.push(`${where}: fields ${fields} != ${expectedFields}`);
    const name = entry.family;
    if (typeof name !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
      problems.push(`${where}: family must be a kebab-case string, got ${JSON.stringify(name)}`);
      continue;
    }
    if (seen.has(name)) problems.push(`${where}: duplicate family ${name}`);
    seen.add(name);
    const endpoints = entry.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      problems.push(`${where} (${name}): endpoints must be a non-empty array`);
      continue;
    }
    if (typeof entry.capability !== "boolean") problems.push(`${where} (${name}): capability must be a boolean`);
    for (const field of ["tuiBehaviour", "reason"] as const) {
      const text = entry[field];
      if (typeof text !== "string" || text.trim().length === 0) {
        problems.push(`${where} (${name}): ${field} must be a non-empty string`);
      }
    }
    families.push(entry as unknown as Family);
  }
  return families;
}

function ledgerOwnership(problems: string[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const family of readLedger(problems)) {
    for (const endpoint of family.endpoints) {
      if (typeof endpoint !== "string") {
        problems.push(`family ${family.family}: endpoint ${JSON.stringify(endpoint)} is not a string`);
        continue;
      }
      const match = /^(GET|POST|PATCH|PUT|DELETE) (\/\S*)$/.exec(endpoint);
      if (match === null) {
        problems.push(`family ${family.family}: endpoint ${JSON.stringify(endpoint)} is not "METHOD /path"`);
        continue;
      }
      const key = endpointKey(match[1]!, match[2]!);
      if (!MOUNTED.some((route) => endpointKey(route.method, route.path) === key)) {
        problems.push(`family ${family.family}: ${endpoint} is not mounted in src/http/routes/index.ts`);
      }
      const previous = owner.get(key);
      if (previous !== undefined) {
        problems.push(`${endpoint} is listed by both ${previous} and ${family.family}`);
        continue;
      }
      owner.set(key, family.family);
    }
  }
  return owner;
}

function fieldText(value: unknown): string {
  return value === undefined ? "<missing>" : JSON.stringify(value);
}

// One line per disagreement, and every absent family named, so a red run reads as a checklist.
function compareWithLedger(ledger: Family[], served: unknown[]): string[] {
  const problems: string[] = [];
  const servedFamilies = new Map<string, Record<string, unknown>>();
  for (const entry of served) {
    if (!isRecord(entry) || typeof entry.family !== "string") {
      problems.push(`served entry is not a family object: ${fieldText(entry)}`);
      continue;
    }
    if (servedFamilies.has(entry.family)) problems.push(`served family ${entry.family} appears more than once`);
    servedFamilies.set(entry.family, entry);
  }
  for (const family of ledger) {
    const entry = servedFamilies.get(family.family);
    if (entry === undefined) {
      problems.push(`missing family: ${family.family}`);
      continue;
    }
    servedFamilies.delete(family.family);
    const extra = Object.keys(entry).filter((key) => !(FAMILY_FIELDS as readonly string[]).includes(key));
    if (extra.length > 0) problems.push(`family ${family.family}: unexpected fields ${extra.join(", ")}`);
    for (const field of FAMILY_FIELDS) {
      const expected = JSON.stringify(family[field]);
      const actual = fieldText(entry[field]);
      if (expected !== actual) problems.push(`family ${family.family}: ${field} ${actual} != ledger ${expected}`);
    }
  }
  for (const name of servedFamilies.keys()) problems.push(`unledgered family: ${name}`);
  return problems;
}

describe("capability ledger", () => {
  test("lists every degraded family from DEGRADATIONS.md", () => {
    const problems: string[] = [];
    const owner = ledgerOwnership(problems);
    const endpoints = degradedEndpoints();
    for (const endpoint of endpoints) {
      if (!owner.has(endpointKey(endpoint.route.method, endpoint.route.path))) {
        problems.push(
          `${endpoint.route.method} ${endpoint.route.path} from DEGRADATIONS.md \`${endpoint.spec}\` is not listed in the capability ledger`,
        );
      }
    }
    const families = readLedger([]);
    const names = new Set(families.map((family) => family.family));
    for (const required of REQUIRED_FAMILIES) {
      if (!names.has(required)) problems.push(`ledger is missing family ${required}`);
    }
    const derived = new Set(endpoints.map((endpoint) => familyOf(endpoint.route.path)));
    if (families.length < derived.size) {
      problems.push(
        `ledger has ${families.length} families, fewer than the ${derived.size} distinct families in DEGRADATIONS.md: ${[...derived].sort().join(", ")}`,
      );
    }
    expect(problems).toEqual([]);
  });

  test(`GET ${CAPABILITIES_PATH} serves the ledger verbatim`, async () => {
    const problems: string[] = [];
    const ledger = readLedger(problems);
    const request = new Request(`http://bridge.test${CAPABILITIES_PATH}`);
    const response = await createRouter(routes)(request);
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (response.status !== 200) {
      const tag = isRecord(body) && typeof body._tag === "string" ? body._tag : "unknown";
      const message = isRecord(body) && typeof body.message === "string" ? body.message : text.slice(0, 200);
      problems.push(`GET ${CAPABILITIES_PATH} answered ${response.status} ${tag}: ${message}`);
    }
    const data = isRecord(body) ? body.data : undefined;
    if (!Array.isArray(data)) {
      problems.push(`GET ${CAPABILITIES_PATH} has no data array (body: ${text.slice(0, 200)})`);
    }
    problems.push(...compareWithLedger(ledger, Array.isArray(data) ? data : []));
    expect(problems).toEqual([]);
  });

  test("the comparison reports a family that the route drops or drifts", () => {
    const ledger = readLedger([]);
    const drifted = ledger
      .filter((family) => family.family !== "mcp")
      .map((family) =>
        family.family === "worktree" ? { ...family, capability: true, reason: "drifted" } : { ...family },
      );
    const problems = compareWithLedger(ledger, drifted);
    expect(problems).toContain("missing family: mcp");
    expect(problems).toContain(
      `family worktree: capability ${JSON.stringify(true)} != ledger ${JSON.stringify(false)}`,
    );
    expect(problems).toContain(`family worktree: reason ${JSON.stringify("drifted")} != ledger ${JSON.stringify(ledger.find((family) => family.family === "worktree")!.reason)}`);
    expect(problems).toHaveLength(3);
  });
});
