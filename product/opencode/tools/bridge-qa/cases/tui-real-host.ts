import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { openSocketGateway } from "../../bridge-dev/socket-gateway.ts";
import type { SocketGateway } from "../../bridge-dev/socket-gateway.ts";

const IMAGE = "bridge-host-official:5.1.75";
const CONTAINER_SOCKET = "/home/bridge/.omo/agent/rpc/rpc.sock";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const key = process.env.BRIDGE_QA_MODEL_KEY;
  const scratch = mkdtempSync(path.join(tmpdir(), "bridge-tui-host-"));
  const container = "bridge-qa-tui-" + String(Date.now());
  let gateway: SocketGateway | undefined;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let screen = "";

  try {
    const args = ["run", "-d", "--name", container];
    if (key !== undefined && key.length > 0) args.push("-e", "OPENCODE_API_KEY=" + key);
    docker([...args, IMAGE, "sleep", "infinity"]);
    /* The artifact's own default session model is one this deployment's key may not use, so the host is
       pointed at an allowed model before anything is started; otherwise a turn ends in a provider 403. */
    docker([
      "exec",
      container,
      "bash",
      "-lc",
      "mkdir -p /home/bridge/.omo/agent && printf '{\"defaultModel\":\"opencode-go/deepseek-v4.1-flash\"}' > /home/bridge/.omo/agent/settings.json",
    ]);
    const started = docker(["exec", container, "omo", "daemon", "run", "--json"]);
    record("host-daemon-starts", "lifecycle ready", started.slice(0, 90), started.includes('"lifecycle":"ready"'));

    const keysDir = path.join(scratch, "agent", "rpc", "keys");
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    for (const dir of [path.join(scratch, "agent"), path.join(scratch, "agent", "rpc"), keysDir]) chmodSync(dir, 0o700);
    const name = docker(["exec", container, "ls", "/home/bridge/.omo/agent/rpc/keys"]).trim().split("\n")[0];
    const keyRecord = path.join(keysDir, name ?? "");
    docker(["cp", container + ":/home/bridge/.omo/agent/rpc/keys/" + String(name), keyRecord]);
    chmodSync(keyRecord, 0o600);

    gateway = await openSocketGateway({
      socketPath: path.join(scratch, "bridge.sock"),
      container: container,
      containerSocket: CONTAINER_SOCKET,
    });

    /* The TUI runs on a real PTY, exactly as a user would start it; its own state roots stay in the
       scratch directory so nothing lands in the user's HOME. */
    proc = Bun.spawn({
      /* `@opentui/solid/preload` registers the JSX runtime the TUI is written against; bun only picks it
         up from the bunfig.toml of its working directory, so the CLI package is the cwd here. */
      cmd: [
        process.execPath,
        "--no-install",
        "--no-env-file",
        path.join(process.cwd(), "packages", "cli", "src", "bridge-run.ts"),
        "--socket",
        gateway.socketPath,
        "--key-record",
        keyRecord,
      ],
      cwd: path.join(process.cwd(), "packages", "cli"),
      terminal: {
        cols: 120,
        rows: 40,
        data(_terminal, chunk) {
          screen += new TextDecoder().decode(chunk);
        },
      },
      env: {
        ...process.env,
        TERM: "xterm-256color",
        HOME: scratch,
        XDG_DATA_HOME: path.join(scratch, "data"),
        XDG_STATE_HOME: path.join(scratch, "state"),
        XDG_CACHE_HOME: path.join(scratch, "cache"),
        XDG_CONFIG_HOME: path.join(scratch, "config"),
      },
    });

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !screen.includes("BRIDGE_STATE=")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    record("launcher-reports-ready", "BRIDGE_STATE=ready", (screen.match(/BRIDGE_STATE=[a-z_]+/) ?? ["none"])[0], screen.includes("BRIDGE_STATE=ready"));

    /* Anything drawn after the handshake is the TUI itself: a blank terminal would prove nothing. */
    const drawnDeadline = Date.now() + 30_000;
    const before = screen.length;
    while (Date.now() < drawnDeadline && screen.length - before < 200) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    record("tui-draws-on-the-terminal", "more than 200 bytes of terminal output after connect", String(screen.length - before), screen.length - before >= 200);

    if (key !== undefined && key.length > 0) {
    /* Typing before the composer exists is lost, so the input waits for the UI to settle instead of
       racing the first draw. */
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    proc.terminal?.write("Say OK and nothing else.\r");
    const answerDeadline = Date.now() + 120_000;
    while (Date.now() < answerDeadline && !/\bOK\b/.test(screen.slice(before))) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    record("assistant-answer-rendered", "OK in the terminal", String(/\bOK\b/.test(screen.slice(before))), /\bOK\b/.test(screen.slice(before)));
    }
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 200), false);
  } finally {
    /* The captured terminal is evidence: a case that failed must leave what the screen actually showed. */
    try {
      writeFileSync(path.join(context.out, "screen.txt"), screen);
    } catch {
      /* the output directory not being writable is not the case's failure */
    }
    try {
      proc?.kill();
    } catch {
      /* the process may already have exited */
    }
    if (gateway !== undefined) {
      detail.push("gateway closed with " + String(gateway.open()) + " forwarded connection(s)");
      await gateway.close();
    }
    try {
      docker(["rm", "-f", container]);
      detail.push("container " + container + " removed");
    } catch {
      detail.push("container " + container + " could not be removed");
    }
    rmSync(scratch, { recursive: true, force: true });
    detail.push("staged key record and scratch roots removed");
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
