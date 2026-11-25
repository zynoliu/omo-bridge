#!/usr/bin/env bun
/**
 * Direct dependency and license inventory for the bridge packages.
 *
 * Task 32 asks for a list of direct dependencies and their licenses. This reads each package's own
 * manifest and resolves every direct dependency to the license its installed copy declares, so a
 * dependency with no license, or one that cannot be resolved, is reported instead of assumed.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const packages = ["bridge-core", "bridge-extension", "tui", "cli"];

type Row = {
  readonly pkg: string;
  readonly name: string;
  readonly range: string;
  readonly license: string | null;
  readonly resolved: boolean;
};

/** Workspace packages are not in node_modules; they are the repository's own code and are read from it. */
const workspace = (() => {
  const map = new Map<string, string | null>();
  const base = path.join(root, "packages");
  for (const entry of readdirSync(base)) {
    const manifest = path.join(base, entry, "package.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; license?: string };
    if (parsed.name !== undefined) map.set(parsed.name, parsed.license ?? null);
  }
  return map;
})();

function licenseOf(name: string): { license: string | null; resolved: boolean } {
  if (workspace.has(name)) return { license: workspace.get(name) ?? null, resolved: true };
  for (const base of [path.join(root, "node_modules"), path.join(root, "node_modules", ".bun", "node_modules")]) {
    const manifest = path.join(base, name, "package.json");
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { license?: string | { type?: string }; licenses?: { type?: string }[] };
    const license = typeof parsed.license === "string" ? parsed.license : (parsed.license?.type ?? parsed.licenses?.[0]?.type ?? null);
    return { license: license, resolved: true };
  }
  return { license: null, resolved: false };
}

const rows: Row[] = [];
for (const pkg of packages) {
  const manifest = JSON.parse(readFileSync(path.join(root, "packages", pkg, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
  for (const [name, range] of Object.entries(deps)) {
    const found = licenseOf(name);
    rows.push({ pkg: pkg, name: name, range: range, license: found.license, resolved: found.resolved });
  }
}

/* A per-platform binary package simply is not installed for the other platforms; that is not a gap. */
const isPlatform = (name: string) => /-(darwin|linux|win32|android)-/.test(name);
const unresolved = rows.filter((row) => !row.resolved && !isPlatform(row.name));
const platformOnly = rows.filter((row) => !row.resolved && isPlatform(row.name));
const unlicensed = rows.filter((row) => row.resolved && (row.license === null || row.license.length === 0));
const byLicense = new Map<string, number>();
for (const row of rows) {
  const key = row.license ?? "(none)";
  byLicense.set(key, (byLicense.get(key) ?? 0) + 1);
}

const out = process.argv[2] ?? path.join(root, "..", "..", ".omo", "evidence", "t32-licenses.json");
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rows: rows }, null, 1));

console.log(
  JSON.stringify({
    dependencies: rows.length,
    unresolved: unresolved.map((row) => row.pkg + ":" + row.name).slice(0, 10),
    platformOnly: platformOnly.length,
    unlicensed: unlicensed.map((row) => row.pkg + ":" + row.name).slice(0, 10),
    byLicense: Object.fromEntries(byLicense),
    written: out,
  }),
);
if (unresolved.length > 0 || unlicensed.length > 0) process.exit(1);
