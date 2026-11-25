import * as fs from "node:fs";
import * as path from "node:path";

export type Check = {
  readonly name: string;
  readonly expected: string;
  readonly observed: string;
  readonly pass: boolean;
};

export type CaseContext = { readonly out: string; readonly qaRoot: string };

export type CaseResult = {
  readonly checks: readonly Check[];
  readonly cleanup: { readonly ok: boolean; readonly detail: readonly string[] };
  readonly artifacts?: readonly string[];
  /** Prerequisites the case cannot supply were missing: the behaviour is unverified, which is neither a pass nor a defect. */
  readonly blocked?: boolean;
};

export type CaseModule = { readonly run: (context: CaseContext) => Promise<CaseResult> };

class UsageError extends Error {}

function parseOptions(argv: readonly string[]): { readonly caseName: string; readonly out: string } {
  const [kind, caseName, ...rest] = argv;
  if (kind !== "case" || caseName === undefined) throw new UsageError("expected: case <name> --out <directory>");
  let out: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag !== "--out") throw new UsageError("unknown option " + String(flag));
    out = rest[index + 1];
    if (out === undefined) throw new UsageError("missing value for --out");
    index += 1;
  }
  if (out === undefined) throw new UsageError("--out is required");
  return { caseName: caseName, out: out };
}

function writeJson(file: string, value: unknown): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

const qaRoot = import.meta.dir;

const options = (() => {
  try {
    return parseOptions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write("usage: run.ts case <name> --out <new-directory>\n");
    process.stderr.write("error: " + (error as Error).message + "\n");
    process.exit(64);
  }
})();

const outDirectory = path.resolve(options.out);
try {
  fs.mkdirSync(outDirectory, { recursive: false, mode: 0o700 });
} catch (error) {
  process.stderr.write("error: output directory must be new: " + outDirectory + "\n");
  process.exit(65);
}

const casePath = path.join(qaRoot, "cases", options.caseName + ".ts");
if (!fs.existsSync(casePath)) {
  writeJson(path.join(outDirectory, "result.json"), {
    case: options.caseName,
    verdict: "FAIL",
    error: "UNKNOWN_CASE",
    checks: [],
  });
  writeJson(path.join(outDirectory, "cleanup.json"), { ok: true, detail: ["no resources were created"] });
  process.stderr.write("error: unknown case " + options.caseName + "\n");
  process.exit(66);
}

const module = (await import(casePath)) as CaseModule;
if (typeof module.run !== "function") {
  // cases/ also holds helpers that other cases import (stream-socket.ts exports pump); naming one here is a
  // caller mistake, and saying so beats a TypeError from the call below.
  throw new Error(options.caseName + " is not a case: it exports no run()");
}
const result = await module.run({ out: outDirectory, qaRoot: qaRoot });
const verdict =
  result.blocked === true ? "BLOCKED" : result.checks.every((check) => check.pass) && result.cleanup.ok ? "PASS" : "FAIL";

writeJson(path.join(outDirectory, "cleanup.json"), result.cleanup);
writeJson(path.join(outDirectory, "result.json"), {
  case: options.caseName,
  checks: result.checks,
  artifacts: result.artifacts ?? [],
  verdict: verdict,
});
process.exit(verdict === "PASS" ? 0 : verdict === "BLOCKED" ? 3 : 1);
