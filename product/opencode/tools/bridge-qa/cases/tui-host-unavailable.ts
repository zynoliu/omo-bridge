import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

const RUNNER = `import { pathToFileURL } from "node:url";
const entryModule = await import(pathToFileURL(process.argv[3]).href);
const { createBridgeEntry } = entryModule;
const socket = process.argv[2];
const entry = createBridgeEntry({ socket, mini: false }, async (target) => {
  const connection = await Bun.connect({ unix: target, socket: { data() {}, open() {}, close() {}, error() {} } });
  connection.end();
});
const state = await entry.connect();
console.log("STATE=" + state);
console.log("ERROR=" + String(entry.error()));
entry.close();
console.log("STATE_AFTER_CLOSE=" + entry.state());
process.exit(state === "failed" ? 0 : 3);
`;

export async function run(context: CaseContext): Promise<CaseResult> {
  const runner = path.join(context.out, "runner.ts");
  fs.writeFileSync(runner, RUNNER, { mode: 0o600 });
  const socketPath = path.join(context.out, "absent.sock");

  let output = "";
  const proc = Bun.spawn({
    cmd: [process.execPath, runner, socketPath, path.join(context.qaRoot, "..", "..", "packages", "cli", "src", "bridge-entry.ts")],
    terminal: { cols: 100, rows: 30, data(_term, chunk) { output += new TextDecoder().decode(chunk); } },
    env: { ...process.env, TERM: "xterm-256color" },
  });
  const exited = await Promise.race([
    proc.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(-1), 15_000)),
  ]);

  const checks: Check[] = [
    {
      name: "connection-failure-visible",
      expected: "STATE=failed and a non-empty ERROR line",
      observed: (output.match(/STATE=[a-z]+/) ?? ["none"])[0] + " / " + (output.includes("ERROR=") ? "error line present" : "no error line"),
      pass: output.includes("STATE=failed") && /ERROR=.+/.test(output),
    },
    { name: "process-exited", expected: "exit 0", observed: String(exited), pass: exited === 0 },
    {
      name: "no-socket-or-process-left",
      expected: "no socket file and a terminal close state",
      observed: (fs.existsSync(socketPath) ? "socket present" : "no socket") + " / " + (output.includes("STATE_AFTER_CLOSE=closed") ? "closed" : "not closed"),
      pass: !fs.existsSync(socketPath) && output.includes("STATE_AFTER_CLOSE=closed"),
    },
  ];
  fs.unlinkSync(runner);
  return {
    checks: checks,
    cleanup: { ok: !fs.existsSync(runner) && !fs.existsSync(socketPath), detail: ["runner script and socket path removed"] },
  };
}
