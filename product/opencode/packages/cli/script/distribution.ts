/**
 * The release gate for the bridge launcher's per-architecture artifacts.
 *
 * A build that produced a binary nobody can start is indistinguishable from one that produced
 * nothing, so an artifact counts only when it exists, is executable, and refuses a missing --socket
 * when launched. The build script and the `package-missing-artifact` QA case call the same check, so
 * the case exercises the gate the build actually enforces rather than a copy of it.
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import path from "node:path";

export type ArtifactAudit = {
  readonly ok: boolean;
  readonly arches: readonly string[];
  readonly missing: readonly string[];
  readonly unlaunchable: readonly string[];
};

const REFUSAL = "--socket";

export function auditArtifacts(root: string, arches: readonly string[]): ArtifactAudit {
  const missing: string[] = [];
  const unlaunchable: string[] = [];
  for (const arch of arches) {
    const binary = path.join(root, `bridge-darwin-${arch}`, "bridge-run");
    if (!existsSync(binary)) {
      missing.push(arch);
      continue;
    }
    try {
      accessSync(binary, constants.X_OK);
    } catch {
      unlaunchable.push(arch);
      continue;
    }
    /* An x64 binary runs here only under Rosetta; when the emulator is absent this launch fails and
       the architecture is reported as unlaunchable instead of being assumed to work. */
    const launch = process.arch === "arm64" && arch === "x64" ? ["/usr/bin/arch", "-x86_64", binary] : [binary];
    const launched = Bun.spawnSync({
      cmd: launch,
      cwd: path.dirname(binary),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const output = new TextDecoder().decode(launched.stdout) + new TextDecoder().decode(launched.stderr);
    if (!output.includes(REFUSAL)) unlaunchable.push(arch);
  }
  return { ok: missing.length === 0 && unlaunchable.length === 0, arches, missing, unlaunchable };
}

export function executableFile(file: string): boolean {
  try {
    return statSync(file).isFile() && (accessSync(file, constants.X_OK), true);
  } catch {
    return false;
  }
}
