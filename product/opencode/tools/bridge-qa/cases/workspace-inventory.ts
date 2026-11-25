import { createHash } from "node:crypto";
import { lstat, readlink, unlink } from "node:fs/promises";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * IS-8: the workspace's untracked and ignored content, inventoried before and after a real operation.
 *
 * The snapshot case proves copy fidelity into a scratch target; this one asks the other half of the
 * question — does the checkout the plan actually works in keep its untracked knowledge base, its
 * ignored upstream alias and its research receipts while a build or a cleanup runs inside it.
 *
 * The window is named by `BRIDGE_QA_IS8_WINDOW`: `build` runs `bun run build:bridge` in
 * `packages/cli`, `cleanup` removes the compiler's leftover `.bun-build` temp files there. Each window
 * declares the only paths its operation may touch; anything else that changes, appears or disappears
 * fails the case. The case itself never writes inside the workspace — its own output directory is the
 * one path it excludes, and it is empty while both scans run.
 *
 * `BRIDGE_QA_IS8_SUPPRESS_EXPECTATIONS=1` declares no allowed region, so the same operation's changes
 * must be reported as unexpected: that is how the detector's red path is exercised on real data.
 */

const SMALL_FILE_BYTES = 64 * 1024;
const IO_WIDTH = 32;

type Entry = {
  readonly path: string;
  readonly classification: "untracked" | "ignored";
  readonly kind: "file" | "symlink" | "other";
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly mode: string;
  readonly sha256: string | null;
  readonly linkTarget?: string;
};

type Change = { readonly path: string; readonly kind: "changed" | "appeared" | "disappeared"; readonly detail: string };

type Allowance = { readonly prefix: string; readonly basename: RegExp };

type Expectation = {
  readonly window: "build" | "cleanup";
  readonly operation: string;
  readonly declaredChange: string;
  readonly allowedPaths: readonly string[];
  readonly allowedPrefixes: readonly string[];
  readonly allowedBasenames: readonly Allowance[];
  readonly allowedChangeKinds: readonly Change["kind"][];
};

const CLI_PACKAGE = "product/opencode/packages/cli";
const BUILD_OUTDIR = CLI_PACKAGE + "/dist-bridge/";
/** Bun writes a compile to `<hash>-<random>.bun-build` and renames it; a leftover means the rename never ran. */
const BUN_BUILD_TEMP = /^\.[0-9a-f]{8,32}-\d+\.bun-build$/;

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const artifacts: string[] = [];
  const cleanupDetail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  try {
    const requested = process.env.BRIDGE_QA_IS8_WINDOW ?? "build";
    const window = requested === "cleanup" ? "cleanup" : "build";
    record("window-is-known", "build or cleanup", requested, window === requested);

    const workspaceRoot = path.resolve(
      process.env.BRIDGE_QA_IS8_WORKSPACE ?? path.resolve(context.qaRoot, "..", "..", "..", ".."),
    );
    const repoRoot = (await git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim();
    const workspacePrefix = path.relative(repoRoot, workspaceRoot);
    const excluded = path.relative(repoRoot, context.out);
    const suppressed = process.env.BRIDGE_QA_IS8_SUPPRESS_EXPECTATIONS === "1";

    const startedAt = new Date().toISOString();
    const before = await inventory(repoRoot, workspacePrefix, excluded);
    const expectation = suppressed ? withoutExpectations(expectations(window, before)) : expectations(window, before);
    const beforeDigest = digestOf(before);
    await writeArtifact(context.out, "inventory-before.jsonl", renderInventory(before));
    artifacts.push("inventory-before.jsonl");

    const operation =
      window === "build"
        ? await build(context, workspaceRoot)
        : await cleanTemporaryBuildFiles(context, workspaceRoot, before);
    artifacts.push(...operation.artifacts);
    record("operation-exit-0", operation.expected, operation.observed, operation.ok);

    const after = await inventory(repoRoot, workspacePrefix, excluded);
    const afterDigest = digestOf(after);
    await writeArtifact(context.out, "inventory-after.jsonl", renderInventory(after));
    artifacts.push("inventory-after.jsonl");

    const changes = diff(before, after);
    const declared = changes.filter((change) => isDeclared(change, expectation));
    const unexpected = changes.filter((change) => !isDeclared(change, expectation));
    await writeArtifact(
      context.out,
      "diff.json",
      JSON.stringify({ window: window, changes: changes.length, declared: declared, unexpected: unexpected }, null, 2) + "\n",
    );
    artifacts.push("diff.json");

    const hashed = before.filter((entry) => entry.sha256 !== null);
    const untracked = before.filter((entry) => entry.classification === "untracked").length;
    const ignoredEntries = before.length - untracked;
    record(
      "inventory-covers-workspace",
      "both classifications present and at least one file digested",
      String(before.length) + " entries (" + String(untracked) + " untracked, " + String(ignoredEntries) + " ignored), " +
        String(hashed.length) + " digests, " + String(Math.round(hashed.reduce((sum, entry) => sum + entry.bytes, 0) / 1e6)) + " MB hashed",
      untracked > 0 && ignoredEntries > 0 && hashed.length > 0,
    );
    record(
      "no-unexpected-change",
      "0 entries outside the declared region changed, appeared or disappeared",
      String(unexpected.length) + " unexpected of " + String(changes.length) + " changes" + examples(unexpected),
      unexpected.length === 0,
    );
    record(
      "declared-region-changed",
      "at least one entry inside the declared region changed as declared",
      String(declared.length) + " declared changes" + examples(declared),
      declared.length > 0,
    );

    /* A detector that cannot be shown to fail proves nothing about the real window, and a failing window
       is not reproducible on demand: the red path is exercised on synthetic entries instead. */
    const probe = detectorProbe();
    record("detector-accepts-declared-change", "the declared change is accepted", probe.accepted, probe.acceptedPass);
    record("detector-flags-unexpected-change", "an undeclared change is reported unexpected", probe.changed, probe.changedPass);
    record("detector-flags-unexpected-disappearance", "an undeclared disappearance is reported unexpected", probe.disappearance, probe.disappearancePass);

    const linkPath = "upstream/opencode";
    const linkEntry = before.find((entry) => entry.path === linkPath);
    if (linkEntry !== undefined) {
      const followed = after.some((entry) => entry.path.startsWith(linkPath + "/"));
      record(
        "symlink-not-followed",
        linkPath + " recorded as a symlink and not descended",
        linkEntry.kind + " -> " + String(linkEntry.linkTarget) + ", " + String(followed ? "descended" : "not descended"),
        linkEntry.kind === "symlink" && !followed,
      );
    }

    const summary = {
      window: window,
      suppressed: suppressed,
      startedAt: startedAt,
      finishedAt: new Date().toISOString(),
      workspaceRoot: workspaceRoot,
      repoRoot: repoRoot,
      workspacePrefix: workspacePrefix,
      excluded: excluded,
      expectation: {
        operation: expectation.operation,
        declaredChange: expectation.declaredChange,
        allowedPaths: expectation.allowedPaths,
        allowedPrefixes: expectation.allowedPrefixes,
        allowedBasenames: expectation.allowedBasenames.map((allowance) => allowance.prefix + " " + String(allowance.basename)),
        allowedChangeKinds: expectation.allowedChangeKinds,
      },
      counts: {
        before: before.length,
        after: after.length,
        untracked: untracked,
        ignored: ignoredEntries,
        digests: hashed.length,
        changed: changes.filter((change) => change.kind === "changed").length,
        appeared: changes.filter((change) => change.kind === "appeared").length,
        disappeared: changes.filter((change) => change.kind === "disappeared").length,
        declared: declared.length,
        unexpected: unexpected.length,
      },
      digests: { before: beforeDigest, after: afterDigest },
      byTopLevel: topLevelCounts(before),
    };
    await writeArtifact(context.out, "window.json", JSON.stringify(summary, null, 2) + "\n");
    artifacts.push("window.json");

    cleanupDetail.push(window === "build" ? "the build owns " + BUILD_OUTDIR + " and rewrites it" : "the window's own removals are its operation");
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 300), false);
  }

  return { checks: checks, cleanup: { ok: true, detail: cleanupDetail }, artifacts: artifacts };
}

function expectations(window: "build" | "cleanup", before: readonly Entry[]): Expectation {
  if (window === "build") {
    return {
      window: window,
      operation: "cd packages/cli && bun run build:bridge",
      declaredChange:
        "the script removes and rewrites packages/cli/dist-bridge, and the compiler may leave .bun-build temp files beside it",
      allowedPaths: [],
      allowedPrefixes: [BUILD_OUTDIR],
      allowedBasenames: [{ prefix: CLI_PACKAGE + "/", basename: BUN_BUILD_TEMP }],
      allowedChangeKinds: ["changed", "appeared", "disappeared"],
    };
  }
  return {
    window: window,
    operation: "remove the compiler's leftover .bun-build temp files in packages/cli",
    declaredChange: "exactly the inventoried .bun-build temp files disappear, recorded with their digest before removal",
    allowedPaths: temporaryBuildFiles(before).map((entry) => entry.path),
    allowedPrefixes: [],
    allowedBasenames: [],
    allowedChangeKinds: ["disappeared"],
  };
}

function temporaryBuildFiles(entries: readonly Entry[]): Entry[] {
  return entries.filter(
    (entry) => entry.kind === "file" && entry.path.startsWith(CLI_PACKAGE + "/") && BUN_BUILD_TEMP.test(path.basename(entry.path)),
  );
}

function withoutExpectations(expectation: Expectation): Expectation {
  return { ...expectation, allowedPaths: [], allowedPrefixes: [], allowedBasenames: [] };
}

async function inventory(repoRoot: string, workspacePrefix: string, excluded: string): Promise<Entry[]> {
  const pathspec = workspacePrefix === "" ? "." : workspacePrefix;
  const [untracked, ignored] = await Promise.all([
    git(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard", "--", pathspec]).then(split),
    git(repoRoot, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", pathspec]).then(split),
  ]);
  const candidates = [
    ...untracked.map((item) => ({ path: item, classification: "untracked" as const })),
    ...ignored.map((item) => ({ path: item, classification: "ignored" as const })),
  ]
    .filter((item) => excluded === "" || !(item.path === excluded || item.path.startsWith(excluded + "/")))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  const entries: Entry[] = new Array(candidates.length);
  const read = { cursor: 0 };
  await Promise.all(
    Array.from({ length: IO_WIDTH }, async () => {
      while (read.cursor < candidates.length) {
        const index = read.cursor;
        read.cursor += 1;
        const candidate = candidates[index];
        entries[index] = await describe(path.join(repoRoot, candidate.path), candidate.path, candidate.classification);
      }
    }),
  );
  return entries;
}

async function describe(full: string, relative: string, classification: Entry["classification"]): Promise<Entry> {
  const stat = await lstat(full);
  const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
  if (stat.isSymbolicLink()) {
    return { path: relative, classification: classification, kind: "symlink", bytes: stat.size, mtimeMs: stat.mtimeMs, mode: mode, sha256: null, linkTarget: await readlink(full) };
  }
  if (!stat.isFile()) {
    return { path: relative, classification: classification, kind: "other", bytes: stat.size, mtimeMs: stat.mtimeMs, mode: mode, sha256: null };
  }
  const sha256 =
    stat.size <= SMALL_FILE_BYTES ? createHash("sha256").update(new Uint8Array(await Bun.file(full).arrayBuffer())).digest("hex") : null;
  return { path: relative, classification: classification, kind: "file", bytes: stat.size, mtimeMs: stat.mtimeMs, mode: mode, sha256: sha256 };
}

function digestOf(entries: readonly Entry[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(
      [entry.path, entry.classification, entry.kind, String(entry.bytes), String(entry.mtimeMs), entry.mode, entry.sha256 ?? "-", entry.linkTarget ?? "-"].join("\0") + "\n",
    );
  }
  return hash.digest("hex");
}

function renderInventory(entries: readonly Entry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function diff(before: readonly Entry[], after: readonly Entry[]): Change[] {
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]));
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const changes: Change[] = [];
  for (const entry of before) {
    const next = afterByPath.get(entry.path);
    if (next === undefined) {
      changes.push({ path: entry.path, kind: "disappeared", detail: entry.kind + " of " + String(entry.bytes) + " bytes removed" });
      continue;
    }
    const fields = differingFields(entry, next);
    if (fields.length > 0) changes.push({ path: entry.path, kind: "changed", detail: fields.join(", ") });
  }
  for (const entry of after) {
    if (!beforeByPath.has(entry.path)) changes.push({ path: entry.path, kind: "appeared", detail: entry.kind + " of " + String(entry.bytes) + " bytes added" });
  }
  return changes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function differingFields(left: Entry, right: Entry): string[] {
  const fields: string[] = [];
  if (left.kind !== right.kind) fields.push("kind");
  if (left.classification !== right.classification) fields.push("classification");
  if (left.bytes !== right.bytes) fields.push("bytes");
  if (left.mtimeMs !== right.mtimeMs) fields.push("mtime");
  if (left.mode !== right.mode) fields.push("mode");
  if (left.sha256 !== right.sha256) fields.push("digest");
  if (left.linkTarget !== right.linkTarget) fields.push("link");
  return fields;
}

function isDeclared(change: Change, expectation: Expectation): boolean {
  const declaredPath = expectation.allowedPaths.includes(change.path);
  const declaredPrefix = expectation.allowedPrefixes.some((prefix) => change.path.startsWith(prefix));
  const declaredBasename = expectation.allowedBasenames.some(
    (allowance) => change.path.startsWith(allowance.prefix) && allowance.basename.test(path.basename(change.path)),
  );
  return (declaredPath || declaredPrefix || declaredBasename) && expectation.allowedChangeKinds.includes(change.kind);
}

function detectorProbe(): {
  accepted: string;
  acceptedPass: boolean;
  changed: string;
  changedPass: boolean;
  disappearance: string;
  disappearancePass: boolean;
} {
  const probe: Expectation = {
    window: "cleanup",
    operation: "detector self-check",
    declaredChange: "one declared path",
    allowedPaths: ["declared/removed.txt"],
    allowedPrefixes: [],
    allowedBasenames: [],
    allowedChangeKinds: ["disappeared"],
  };
  const base: Entry = { path: "declared/removed.txt", classification: "untracked", kind: "file", bytes: 3, mtimeMs: 1, mode: "0644", sha256: "aa" };
  const other: Entry = { ...base, path: "outside/kept.txt" };
  const accepted = diff([base], []);
  const mutation = diff([other], [{ ...other, sha256: "bb", mtimeMs: 2 }]);
  const removal = diff([other], []);
  const undeclared = (changes: readonly Change[]) => changes.filter((change) => !isDeclared(change, probe));
  return {
    accepted: String(accepted.length) + " declared, " + String(undeclared(accepted).length) + " flagged",
    acceptedPass: accepted.length === 1 && undeclared(accepted).length === 0,
    changed: String(mutation.length) + " changes, " + String(undeclared(mutation).length) + " flagged unexpected",
    changedPass: mutation.length === 1 && undeclared(mutation).length === 1,
    disappearance: String(removal.length) + " disappearances, " + String(undeclared(removal).length) + " flagged unexpected",
    disappearancePass: removal.length === 1 && undeclared(removal).length === 1,
  };
}

async function build(context: CaseContext, workspaceRoot: string): Promise<{ ok: boolean; expected: string; observed: string; artifacts: string[] }> {
  const startedAt = Date.now();
  const proc = Bun.spawn([process.execPath, "run", "build:bridge"], {
    cwd: path.join(workspaceRoot, CLI_PACKAGE),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const finishedAt = Date.now();
  await writeArtifact(context.out, "build.stdout.txt", stdout);
  await writeArtifact(context.out, "build.stderr.txt", stderr);
  await writeArtifact(
    context.out,
    "build.json",
    JSON.stringify({ command: process.execPath + " run build:bridge", cwd: path.join(workspaceRoot, CLI_PACKAGE), exit: exit, ms: finishedAt - startedAt }, null, 2) + "\n",
  );
  const last = stdout.trim().split("\n").pop() ?? "";
  return {
    ok: exit === 0,
    expected: "exit 0 from bun run build:bridge",
    observed: "exit " + String(exit) + " in " + String(finishedAt - startedAt) + " ms, last line " + last.slice(0, 160),
    artifacts: ["build.stdout.txt", "build.stderr.txt", "build.json"],
  };
}

async function cleanTemporaryBuildFiles(
  context: CaseContext,
  workspaceRoot: string,
  before: readonly Entry[],
): Promise<{ ok: boolean; expected: string; observed: string; artifacts: string[] }> {
  const candidates = temporaryBuildFiles(before);
  const removed: { path: string; bytes: number; mtimeMs: number; sha256: string | null }[] = [];
  const problems: string[] = [];
  for (const candidate of candidates) {
    const full = path.join(workspaceRoot, candidate.path);
    const stat = await lstat(full);
    if (!stat.isFile()) {
      problems.push(candidate.path + ": not a regular file");
      continue;
    }
    /* The bytes are hashed before the removal: after it they exist nowhere, so this digest is the only
       record of what the cleanup window deleted. */
    const sha256 = createHash("sha256").update(new Uint8Array(await Bun.file(full).arrayBuffer())).digest("hex");
    await unlink(full);
    removed.push({ path: candidate.path, bytes: candidate.bytes, mtimeMs: candidate.mtimeMs, sha256: sha256 });
  }
  const payload = { declared: candidates.length, removed: removed.length, problems: problems, entries: removed };
  await writeArtifact(context.out, "cleanup-removed.json", JSON.stringify(payload, null, 2) + "\n");
  return {
    ok: candidates.length > 0 && problems.length === 0 && removed.length === candidates.length,
    expected: "at least one inventoried temp file, every one of them removed",
    observed: String(removed.length) + " of " + String(candidates.length) + " removed, " + String(problems.length) + " problems",
    artifacts: ["cleanup-removed.json"],
  };
}

function topLevelCounts(entries: readonly Entry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const top = entry.path.split("/").slice(0, 2).join("/");
    counts[top] = (counts[top] ?? 0) + 1;
  }
  return counts;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error("git " + args.join(" ") + " failed with " + String(exit) + ": " + stderr.trim().slice(0, 200));
  return stdout;
}

function split(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

function examples(changes: readonly Change[]): string {
  if (changes.length === 0) return "";
  return ": " + changes.slice(0, 3).map((change) => change.path + " (" + change.kind + ", " + change.detail + ")").join("; ");
}

async function writeArtifact(directory: string, name: string, content: string): Promise<void> {
  await Bun.write(path.join(directory, name), content, { createPath: false });
}
