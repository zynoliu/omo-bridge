import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PINNED_SENPI = "2026.11.4-2";

type Step = { name: string; args: readonly string[] };

const STEPS: readonly Step[] = [
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "contracts:check", args: ["run", "contracts:check"] },
  { name: "test", args: ["test"] },
];

/**
 * Each step is a child `bun` process so a failure can capture its own output without taking the
 * parent down. BUN_BE_BUN makes the bundled OmO runtime behave as the plain bun CLI.
 */
async function runStep(step: Step): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, ...step.args],
    cwd: REPO_ROOT,
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    ok: exitCode === 0,
    output: [stdout, stderr].map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0).join("\n"),
  };
}

async function main(): Promise<void> {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    dependencies?: Record<string, string>;
  };
  const actual = pkg.dependencies?.["@code-yeongyu/senpi"];
  if (actual !== PINNED_SENPI) {
    console.error(
      `selfcheck: @code-yeongyu/senpi must be pinned to exactly "${PINNED_SENPI}" (no caret/range), found ${JSON.stringify(actual)}`,
    );
    console.error("selfcheck: failed");
    process.exit(1);
  }

  for (const step of STEPS) {
    const result = await runStep(step);
    if (result.ok) continue;
    console.error(`selfcheck: ${step.name} failed`);
    if (result.output.length > 0) console.error(result.output);
    console.error("selfcheck: failed");
    process.exit(1);
  }

  console.log("selfcheck: ok");
}

main().catch((error: unknown) => {
  console.error(`selfcheck: ${error instanceof Error ? error.message : String(error)}`);
  console.error("selfcheck: failed");
  process.exit(1);
});
