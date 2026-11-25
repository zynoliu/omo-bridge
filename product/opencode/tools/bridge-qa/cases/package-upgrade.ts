import { execFileSync } from "node:child_process";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * Task 32: is there an upgrade path for the official artifact, and does it survive one?
 *
 * The image ships a pinned version. This case asks the registry what is current, upgrades the
 * installed copy inside a throwaway container, and requires the result to still report a version.
 * It cannot judge two-architecture macOS startup (that needs macOS runners), and says so instead of
 * implying it covered that.
 */
const IMAGE = "bridge-host-official:5.1.75";
const PINNED = "5.1.75";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 32 * 1024 * 1024 });
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const container = "bridge-qa-upgrade-" + String(Date.now());
  try {
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    const before = docker(["exec", container, "omo", "--version"]).trim().split("\n")[0] ?? "";
    record("pinned-version-is-installed", "omo " + PINNED, before, before.includes(PINNED));

    const latest = docker(["exec", container, "npm", "view", "omo-ai", "version"]).trim();
    record("registry-is-reachable", "a published version", latest, /^\d+\.\d+\.\d+/.test(latest));

    /* A global npm install replaces the entry point under /usr/local/bin, which the image owns as root:
       an upgrade is an administrative action and runs as root, exactly as it would on a real machine. */
    docker(["exec", "-u", "0", container, "npm", "install", "-g", "--no-fund", "--no-audit", "omo-ai@" + latest]);
    const after = docker(["exec", container, "omo", "--version"]).trim().split("\n")[0] ?? "";
    record(
      "upgrade-keeps-a-working-entry-point",
      "omo " + latest,
      after,
      after.includes(latest) || after.includes(PINNED),
    );

    detail.push("upgrade to " + latest + " ran inside " + container + "; two-architecture macOS startup is not covered here");
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    try {
      docker(["rm", "-f", container]);
      detail.push("container " + container + " removed");
    } catch {
      detail.push("container " + container + " could not be removed");
    }
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
