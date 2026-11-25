import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * The bootstrap snapshot, verified from outside the tool that wrote it.
 *
 * The snapshot is written to a scratch target so the product checkout is untouched, and then every
 * item is checked three ways: the target file against the manifest, the source file against the same
 * manifest entry, and each symlink against the target string the manifest recorded. A tool that graded
 * its own output could pass a weaker check than this.
 */
export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  /* qaRoot is <checkout>/product/opencode/tools/bridge-qa; the bootstrap lives in <checkout>/product. */
  const checkout = path.resolve(context.qaRoot, "..", "..", "..", "..");
  const root = path.join(checkout, "product");
  /* The tool refuses an existing target, so the path is named but not created. */
  const parent = mkdtempSync(path.join(tmpdir(), "bridge-snapshot-"));
  const target = path.join(parent, "target");
  const manifestPath = path.join(context.out, "snapshot-manifest.json");
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--no-install", "--no-env-file", path.join(root, "bootstrap.ts"), "snapshot", "--source", "upstream/opencode", "--target", target, "--manifest", manifestPath],
      { cwd: checkout, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
    );
    const report = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as { status?: string; itemCount?: number; fileCount?: number };
    record("snapshot-succeeds", "status ok", String(report.status) + " with " + String(report.itemCount) + " items", report.status === "ok");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      readonly items: readonly { readonly path: string; readonly kind: string; readonly bytes?: number; readonly sha256?: string; readonly linkTarget?: string | null }[];
    };
    const sourceRoot = path.join(checkout, "upstream", "opencode");
    const hashOf = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    const problems: string[] = [];
    let files = 0;
    let links = 0;
    for (const item of manifest.items) {
      const targetPath = path.join(target, item.path);
      if (item.kind === "symlink") {
        links += 1;
        try {
          if (readlinkSync(targetPath) !== item.linkTarget) problems.push(item.path + ": link target differs");
        } catch {
          problems.push(item.path + ": unreadable link");
        }
        continue;
      }
      files += 1;
      try {
        if (lstatSync(targetPath).size !== item.bytes) {
          problems.push(item.path + ": size differs");
          continue;
        }
        if (hashOf(targetPath) !== item.sha256) {
          problems.push(item.path + ": target digest differs");
          continue;
        }
        const sourcePath = path.join(sourceRoot, item.path);
        if (!existsSync(sourcePath)) problems.push(item.path + ": missing in source");
        else if (hashOf(sourcePath) !== item.sha256) problems.push(item.path + ": source digest differs");
      } catch (error) {
        problems.push(item.path + ": " + String(error).slice(0, 60));
      }
    }
    record(
      "every-item-matches-source-and-manifest",
      "0 differences across files and symlinks",
      String(files) + " files, " + String(links) + " symlinks, " + String(problems.length) + " problems",
      problems.length === 0,
    );
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error ? String((error as { stderr?: unknown }).stderr).slice(0, 300) : "";
    record("case-completed", "no unexpected failure", (String(error).slice(0, 160) + " | " + stderr).slice(0, 300), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
    detail.push("scratch snapshot target removed");
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
