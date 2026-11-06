#!/usr/bin/env bun
/**
 * One gate for the whole repository. Usage:
 * bun run check:all [--min-lines 90] [--min-funcs 92] [--expect-bun <version>]
 *                    [--allow-version-mismatch] [--allow-missing-fork] [--quiet]
 */

import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const argv = Bun.argv.slice(2);

function flag(name: string): boolean {
  return argv.includes(`--${name}`);
}

function option(name: string, fallback: string): string {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1]! : fallback;
}

const quiet = flag("quiet");
const minLines = Number(option("min-lines", "90"));
const minFuncs = Number(option("min-funcs", "92"));
// Process entry points: qa:tui drives them end to end, unit tests never import them.
const ENTRY_POINTS = new Set(["src/index.ts", "src/launcher.ts", "src/tui-launch.ts"]);
// Two stages derive their fixtures from the fork checkout; one missing checkout is one skip, not two failures.
const forkDir = option("fork", process.env.OMO_BRIDGE_OPENCODE_FORK ?? "/Users/zyno/OmO Projects/my-tui/opencode");
const forkPresent = existsSync(join(forkDir, "packages", "client"));

function say(line: string): void {
  if (!quiet) process.stdout.write(`${line}\n`);
}

function fail(line: string): void {
  process.stderr.write(`${line}\n`);
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(cmd, {
    cwd: REPO,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: `${out}${err}` };
}

type Result = { stage: string; ok: boolean; detail: string };

const results: Result[] = [];

function record(stage: string, ok: boolean, detail: string): void {
  results.push({ stage, ok, detail });
  say(`${ok ? "ok  " : "FAIL"} ${stage.padEnd(9)} ${detail}`);
}

// ---- version ----
{
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { packageManager?: string };
  const pinned = String(pkg.packageManager ?? "").replace(/^bun@/, "");
  const expected = option("expect-bun", pinned);
  const actual = Bun.version;
  if (expected.length === 0) {
    record("version", true, `bun ${actual} (no pin in package.json)`);
  } else if (actual === expected) {
    record("version", true, `bun ${actual} matches the pin`);
  } else if (flag("allow-version-mismatch")) {
    record("version", true, `bun ${actual} != pin ${expected} (allowed by --allow-version-mismatch)`);
  } else {
    record("version", false, `bun ${actual} != pin ${expected}; rerun with --allow-version-mismatch to accept`);
    finish();
  }
}

// ---- typecheck ----
{
  const { code, out } = await run([process.execPath, "run", "typecheck"]);
  record("typecheck", code === 0, code === 0 ? "tsc --noEmit clean" : lastLines(out));
  if (code !== 0) finish();
}

// ---- contracts ----
if (!forkPresent && flag("allow-missing-fork")) {
  record("contracts", true, `skipped: fork checkout missing at ${forkDir} (--allow-missing-fork)`);
} else {
  const { code, out } = await run([process.execPath, "run", "contracts:check"]);
  const summary = lineWith(out, /contracts:/) ?? lastLines(out);
  record("contracts", code === 0, summary);
  if (code !== 0) finish();
}

// ---- surface ----
if (!forkPresent && flag("allow-missing-fork")) {
  record("surface", true, `skipped: fork checkout missing at ${forkDir} (--allow-missing-fork)`);
} else {
  const { code, out } = await run([process.execPath, "run", "surface:check"]);
  if (code === 0) {
    record("surface", true, lineWith(out, /surface fixture/) ?? "fixture current");
  } else if (!forkPresent) {
    record("surface", false, `the fork checkout is missing at ${forkDir}; set OMO_BRIDGE_OPENCODE_FORK or pass --allow-missing-fork`);
    finish();
  } else {
    record("surface", false, lastLines(out));
    finish();
  }
}

// ---- test + coverage floor ----
{
  const coverageDir = await import("node:fs").then((fs) => fs.mkdtempSync(join(tmpdir(), "omo-bridge-coverage-")));
  const { code, out } = await run([
    process.execPath,
    "test",
    "--coverage",
    "--coverage-reporter=lcov",
    `--coverage-dir=${coverageDir}`,
  ]);
  const counts = lineWith(out, /^Ran \d+ tests? across/) ?? "";
  const coverage = readSrcCoverage(join(coverageDir, "lcov.info"));
  await import("node:fs").then((fs) => fs.rmSync(coverageDir, { recursive: true, force: true }));
  if (code !== 0) {
    record("test", false, lastLines(out));
    finish();
  }
  if (coverage === undefined) {
    record("test", false, `no src coverage in the lcov report; ${counts}`);
    finish();
  }
  const under = coverage.funcs < minFuncs || coverage.lines < minLines;
  record(
    "test",
    !under,
    `src funcs ${coverage.funcs}% (min ${minFuncs}) lines ${coverage.lines}% (min ${minLines}); ${coverage.excluded} entry point(s) excluded; ${counts}`,
  );
  if (under) finish();
}

// ---- rule layer ----
{
  const { code, out } = await run([process.execPath, "test", "./test/rule"]);
  const counts = lineWith(out, /^Ran \d+ tests? across/) ?? "";
  record("rule", code === 0, code === 0 ? `data-source + family rules green; ${counts}` : lastLines(out));
  if (code !== 0) finish();
}

finish();

// ---- helpers ----
/**
 * src-only coverage: the floor protects shipped code, not test helpers or the extractor scripts
 * that only a gate run loads.
 */
function readSrcCoverage(file: string): { lines: number; funcs: number; excluded: number } | undefined {
  let report: string;
  try {
    report = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  let excluded = 0;
  for (const block of report.split("end_of_record")) {
    const source = block.match(/^SF:(.+)$/m)?.[1]?.trim();
    if (source === undefined || !source.startsWith("src/")) continue;
    if (ENTRY_POINTS.has(source)) {
      excluded += 1;
      continue;
    }
    for (const match of block.matchAll(/^LF:(\d+)$/gm)) lf += Number(match[1]);
    for (const match of block.matchAll(/^LH:(\d+)$/gm)) lh += Number(match[1]);
    for (const match of block.matchAll(/^FNF:(\d+)$/gm)) fnf += Number(match[1]);
    for (const match of block.matchAll(/^FNH:(\d+)$/gm)) fnh += Number(match[1]);
  }
  if (lf === 0 || fnf === 0) return undefined;
  return { lines: round2((100 * lh) / lf), funcs: round2((100 * fnh) / fnf), excluded };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function lineWith(text: string, pattern: RegExp): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => pattern.test(line));
}

function lastLines(text: string, count = 3): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-count)
    .join(" | ")
    .slice(0, 300);
}

function finish(): never {
  const failed = results.filter((result) => !result.ok);
  say("");
  say(`check:all ${failed.length === 0 ? "PASS" : "FAIL"} - ${results.length} stage(s), ${failed.length} failed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
