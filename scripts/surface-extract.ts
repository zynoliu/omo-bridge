/**
 * Extracts the HTTP surface the fork's TUI actually calls, and writes
 * `contracts/surface/tui-endpoints.json`. The endpoint list is parsed from the generated promise
 * client and narrowed to chains present in the TUI; `test/http/surface.test.ts` fails when the
 * fixture no longer matches the fork, so a new TUI call cannot be silently unserved.
 *
 * Regenerate with: bun run scripts/surface-extract.ts
 */

import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { ENDPOINTS } from "./contracts-extract";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FORK = (process.env.OMO_BRIDGE_OPENCODE_FORK ?? "/Users/zyno/OmO Projects/my-tui/opencode").replace(/\/$/, "");
export const SURFACE_FILE = join(REPO_ROOT, "contracts", "surface", "tui-endpoints.json");

export type SurfaceEndpoint = {
  chain: string;
  method: string;
  path: string;
  params: string[];
  successStatus: number;
  declaredStatuses: number[];
  empty: boolean;
  binary: boolean;
  sse: boolean;
  schema: string | null;
  callSites: string[];
};

type ClientEndpoint = Omit<SurfaceEndpoint, "callSites" | "schema"> & { pathTemplate: string; typeName: string | null };

function walk(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Parses every endpoint descriptor in the generated client. */
export function parseClient(fork: string = FORK): ClientEndpoint[] {
  const file = join(fork, "packages/client/src/promise/generated/client.ts");
  const lines = readFileSync(file, "utf8").split("\n");

  // Track the object-literal namespace stack (server, session.revert, experimental.persistentPty...).
  const stack: Array<{ name: string; indent: number }> = [];
  const namespaces: string[][] = [];
  for (const line of lines) {
    const open = /^(\s*)([A-Za-z][A-Za-z0-9]*): \{\s*$/.exec(line);
    const indent = (line.match(/^\s*/)?.[0].length ?? 0) as number;
    if (open) {
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      stack.push({ name: open[2]!, indent });
    } else if (/^\s*\}\s*,?\s*$/.test(line)) {
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    }
    namespaces.push(stack.map((entry) => entry.name));
  }

  const endpoints: ClientEndpoint[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const methodMatch = /method: "(GET|POST|PUT|PATCH|DELETE)",/.exec(lines[index]!);
    if (!methodMatch) continue;
    const block = lines.slice(index, index + 16).join("\n");
    const pathTemplate = /path: `([^`]+)`/.exec(block)?.[1];
    const successStatus = Number(/successStatus: (\d+)/.exec(block)?.[1]);
    const declared = /declaredStatuses: \[([^\]]*)\]/.exec(block)?.[1];
    const empty = /empty: (true|false)/.exec(block)?.[1] === "true";
    const binary = /binary: true/.test(block);
    if (pathTemplate === undefined || !Number.isInteger(successStatus) || declared === undefined) continue;

    let name: string | null = null;
    for (let back = index; back >= Math.max(0, index - 30); back -= 1) {
      const found = /^\s*([A-Za-z][A-Za-z0-9]*): \(/.exec(lines[back]!);
      if (found) {
        name = found[1]!;
        break;
      }
    }
    if (name === null) continue;
    const head = lines.slice(Math.max(0, index - 12), index).join("\n");
    const sse = /\bsse</.test(head);
    const typeName = /(?:request|sse)<([^>{]+)>/.exec(head)?.[1]?.trim() ?? null;

    endpoints.push({
      chain: [...(namespaces[index] ?? []), name].join("."),
      method: methodMatch[1]!,
      pathTemplate,
      path: normalizePath(pathTemplate),
      params: paramsOf(pathTemplate),
      successStatus,
      declaredStatuses: declared
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value)),
      empty,
      binary,
      sse,
      typeName,
    });
  }
  return endpoints;
}

function normalizePath(template: string): string {
  return template
    .replace(/\$\{encodeURIComponent\(input\.([A-Za-z0-9]+)\)\}/g, ":$1")
    .replace(/\$\{encodePath\(input\.([A-Za-z0-9]+)\)\}/g, ":$1");
}

function paramsOf(template: string): string[] {
  return [...template.matchAll(/\$\{(?:encodeURIComponent|encodePath)\(input\.([A-Za-z0-9]+)\)\}/g)].map(
    (match) => match[1]!,
  );
}

/** Every `.a.b(...)` call chain in the TUI and its data layer. */
export function callChains(fork: string = FORK): Array<{ chain: string; site: string }> {
  const files = [
    ...walk(join(fork, "packages/tui/src")),
    ...walk(join(fork, "packages/client/src/solid")),
    ...walk(join(fork, "packages/client/src/promise")).filter(
      (file) => !file.includes("/generated/") && !file.endsWith("client.ts"),
    ),
  ];
  const chains: Array<{ chain: string; site: string }> = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const script = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const relative = file.slice(fork.length + 1);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const text = node.expression.getText(script).replace(/\s+/g, "");
        if (text.length < 80) {
          const line = script.getLineAndCharacterOfPosition(node.getStart(script)).line + 1;
          chains.push({ chain: text, site: `${relative}:${line}` });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(script);
  }
  return chains;
}

/** Maps a client path+method to the bridge contract id that pins its success body, when one exists. */
export function contractIds(): Map<string, string> {
  const ids = new Map<string, string>();
  for (const endpoint of ENDPOINTS) {
    const note = "note" in endpoint ? endpoint.note : "";
    const match = /success body of (GET|POST|PUT|PATCH|DELETE) (\S+)/.exec(note ?? "");
    if (match) ids.set(`${match[1]} ${normalizePath(match[2]!)}`, endpoint.id);
  }
  return ids;
}

export function extractSurface(fork: string = FORK): SurfaceEndpoint[] {
  const endpoints = parseClient(fork);
  const chains = callChains(fork);
  const contracts = contractIds();
  const surface: SurfaceEndpoint[] = [];

  for (const endpoint of endpoints) {
    const sites = chains.filter((call) => call.chain.endsWith(`.${endpoint.chain}`)).map((call) => call.site);
    // `client.rpc(Definition)` builds its calls through makeRpc; the generated `rpc.call` endpoint is
    // never named at a call site, so the constructor call stands in for it.
    if (endpoint.chain === "rpc.call") {
      for (const call of chains) {
        if (/(^|\.)(client|api)\.rpc$/.test(call.chain)) sites.push(call.site);
      }
    }
    if (sites.length === 0) continue;
    const { pathTemplate: _template, typeName: _type, ...rest } = endpoint;
    surface.push({
      ...rest,
      schema: contracts.get(`${endpoint.method} ${endpoint.path}`) ?? null,
      callSites: [...new Set(sites)].sort(),
    });
  }
  return surface.sort((left, right) => left.chain.localeCompare(right.chain));
}

export function surfaceDocument(fork: string = FORK): string {
  return `${JSON.stringify({ fork: "my-tui/opencode", endpoints: extractSurface(fork) }, null, 2)}\n`;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const text = surfaceDocument();
  if (check) {
    const current = readFileSync(SURFACE_FILE, "utf8");
    if (current !== text) {
      console.error(`surface fixture is stale: run bun run scripts/surface-extract.ts`);
      process.exit(1);
    }
    console.log(`surface fixture is current (${JSON.parse(text).endpoints.length} endpoints)`);
  } else {
    mkdirSync(dirname(SURFACE_FILE), { recursive: true });
    writeFileSync(SURFACE_FILE, text);
    console.log(`wrote ${SURFACE_FILE} (${JSON.parse(text).endpoints.length} endpoints)`);
  }
}
