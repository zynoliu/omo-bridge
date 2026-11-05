import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSession, startBridge } from "./lib/bridge.mjs";
import { startTui } from "./lib/tui.mjs";

const USAGE = `Usage: bun run qa:tui -- --scenario <name> [--evidence-dir <dir>] [--keep]

Options:
  --scenario <name>      scenario module under script/qa/scenarios/<name>.mjs (default: send-message)
  --evidence-dir <dir>   where frames, transcript, bridge log, report and screenshot are written
  --keep                 keep the bridge state directory instead of deleting it
  --help                 print this message
`;

function parseArgs(argv) {
  const options = { scenario: "send-message", evidenceDir: undefined, agentDir: undefined, keep: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--scenario") options.scenario = argv[++i];
    else if (arg === "--evidence-dir") options.evidenceDir = argv[++i];
    else if (arg === "--agent-dir") options.agentDir = argv[++i];
    else if (arg === "--keep") options.keep = true;
  }
  if (options.evidenceDir === undefined) {
    options.evidenceDir = join(process.cwd(), ".qa", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  }
  options.evidenceDir = resolve(options.evidenceDir);
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const repo = resolve(import.meta.dir, "..", "..");
  const bunExe = process.env.OMO_BRIDGE_QA_BUN ?? "/opt/homebrew/bin/bun";
  mkdirSync(options.evidenceDir, { recursive: true });

  const scenarioPath = join(import.meta.dir, "scenarios", `${options.scenario}.mjs`);
  const module = await import(scenarioPath);
  const scenario = module.default;
  if (scenario === undefined || typeof scenario.run !== "function") {
    throw new Error(`${scenarioPath} must default-export { name, run(ctx) }`);
  }

  const ctx = {
    repo,
    bunExe,
    evidenceDir: options.evidenceDir,
    agentDir: options.agentDir,
    startBridge: (input = {}) => startBridge({ repo, bunExe, evidenceDir: options.evidenceDir, ...input }),
    createSession: (input) => createSession(input),
    startTui: (input = {}) => startTui({ repo, bunExe, ...input }),
    async writeFile(name, content) {
      const path = join(options.evidenceDir, name);
      await Bun.write(path, content);
      return { path };
    },
  };

  const result = await scenario.run(ctx);
  const exitCode = result?.exitCode ?? 0;
  process.stdout.write(`${JSON.stringify(result?.report ?? { scenario: scenario.name, exitCode })}\n`);
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`qa: ${error?.stack ?? String(error)}\n`);
    process.exit(1);
  },
);
