import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * A permission answer that is not one of the offered options must never be read as consent.
 *
 * The test extension asks the host to run a harmless `bash` command, so "did it run" is the whole
 * verdict: if an out-of-vocabulary answer could be mistaken for an approval, the marker file appears.
 * The case answers the dialog with `Deny ` (a trailing space, therefore not a candidate) and reports
 * what actually happened, including the possibility that the host never completes the call at all.
 */
const IMAGE = "bridge-host-official:5.1.75";
const EXTENSION = path.join(import.meta.dir, "..", "fixtures", "perm-probe", "index.ts");

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const container = "bridge-qa-invalid-" + String(Date.now());
  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-invalid-"));
  let answered = 0;
  let sawDialog = false;
  try {
    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    docker(["exec", container, "bash", "-lc", "mkdir -p /home/bridge/.omo/agent/extensions/bridge-perm && echo SYNTHETIC > /work/synthetic.txt"]);
    execFileSync("docker", ["cp", EXTENSION, container + ":/home/bridge/.omo/agent/extensions/bridge-perm/index.ts"], { stdio: ["pipe", "pipe", "pipe"] });
    docker(["exec", "-u", "0", container, "bash", "-lc", "chown -R 10001:10001 /home/bridge/.omo/agent/extensions"]);

    const child = spawn("docker", ["exec", "-i", container, "bash", "-lc", "omo --mode rpc --permission-preset ask --model opencode-go/deepseek-v4.1-flash"], { stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        let frame: { type?: string; method?: string; id?: string } | undefined;
        try {
          frame = JSON.parse(line) as typeof frame;
        } catch {
          continue;
        }
        if (frame?.type !== "extension_ui_request" || frame.method !== "select") continue;
        sawDialog = true;
        answered += 1;
        /* The offered options are "Allow once", "Allow always", "Deny" and "Deny with feedback".
           This answer is none of them. */
        child.stdin.write(
          JSON.stringify({ type: "extension_ui_response", id: "answer-" + String(answered), uiRequestId: frame.id, value: "Deny " }) + "\n",
        );
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    child.kill();

    record("permission-dialog-appeared", "a select dialog under the ask preset", sawDialog ? "seen" : "none", sawDialog);
    const ran = (() => {
      try {
        return docker(["exec", container, "cat", "/work/bash-ran.txt"]).trim();
      } catch {
        return "";
      }
    })();
    record(
      "non-candidate-answer-is-not-consent",
      "the command must not run",
      ran === "RAN" ? "the command ran" : "the command did not run",
      ran !== "RAN",
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    try {
      docker(["rm", "-f", container]);
      detail.push("container " + container + " removed");
    } catch {
      detail.push("container " + container + " could not be removed");
    }
    rmSync(scratch, { recursive: true, force: true });
    detail.push("scratch directory removed");
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
