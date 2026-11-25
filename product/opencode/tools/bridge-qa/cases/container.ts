import { execFileSync } from "node:child_process";

import type { CaseContext, CaseResult, Check } from "../run.ts";

/**
 * The isolated host container: what it is, and what it must not contain.
 *
 * The product requirement is that the official host runs in an environment of its own. This case
 * checks the parts of that claim a machine can check: the image runs as a non-root user, it carries no
 * model credential, its home is not the user's home, and the built artifact identifies itself.
 */
const IMAGE = "bridge-host-official:5.1.75";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export async function run(_context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const container = "bridge-qa-container-" + String(Date.now());
  try {
    const inspect = JSON.parse(docker(["image", "inspect", IMAGE])) as readonly {
      readonly Config?: { readonly User?: string; readonly Env?: readonly string[] };
    }[];
    const config = inspect[0]?.Config ?? {};
    record("image-exists", IMAGE + " is present", IMAGE + " is present", inspect.length > 0);
    record(
      "image-runs-as-non-root",
      "a non-root user is baked into the image",
      String(config.User ?? "(unset)"),
      typeof config.User === "string" && config.User.length > 0 && config.User !== "root" && config.User !== "0",
    );
    const env = config.Env ?? [];
    const leaked = env.filter((entry) => /API_KEY|TOKEN|SECRET/i.test(entry));
    record(
      "image-carries-no-credential",
      "no key-like environment entry is baked into the image",
      leaked.length === 0 ? "none" : leaked.map((entry) => entry.split("=")[0]).join(", "),
      leaked.length === 0,
    );

    docker(["run", "-d", "--name", container, IMAGE, "sleep", "infinity"]);
    const whoami = docker(["exec", container, "id", "-un"]).trim();
    record("container-user-is-not-root", "a non-root user", whoami, whoami !== "root");
    const home = docker(["exec", container, "printenv", "HOME"]).trim();
    record("container-home-is-its-own", "a home inside the container", home, home.startsWith("/") && home !== process.env.HOME);
    const version = docker(["exec", container, "omo", "--version"]).trim();
    record("official-artifact-answers", "omo 5.1.75", version.split("\n")[0] ?? "", (version.split("\n")[0] ?? "").includes("5.1.75"));
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
