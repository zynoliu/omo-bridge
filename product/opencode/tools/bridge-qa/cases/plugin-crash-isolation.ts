import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { screenText } from "../lib/terminal-screen.ts";
import { capture, installPluginSource, spawnLauncher, startPeer, stop, waitFor } from "./plugin-real-renderer.ts";

const READY_TIMEOUT_MS = 20_000;
const LAYOUT_TIMEOUT_MS = 30_000;
const CRASH_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 5_000;
const COLUMNS = 120;
const ROWS = 40;
const HOME_MARKERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"];
const STEADY_MARKER = "qa-steady-alive";

const CRASH_PLUGIN = `import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "fixture.bridge-crash",
  setup(context) {
    context.ui.slot({
      append: "prompt.footer",
      render: () => {
        throw new Error("qa crash: slot render failed")
      },
    })
  },
})
`;

const STEADY_PLUGIN = `import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "fixture.bridge-steady",
  setup(context) {
    context.ui.slot({ append: "prompt.footer", render: () => <text>${STEADY_MARKER}</text> })
  },
})
`;

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock");
  const home = path.join(context.out, "home");
  const configHome = path.join(home, ".config");
  const modules = path.join(context.qaRoot, "..", "..", "packages", "tui", "node_modules");
  const peer = startPeer(context.out, socketPath);
  const evidence = capture();
  const children: ReturnType<typeof spawnLauncher>[] = [];
  const cleanupDetail: string[] = [];
  const artifacts: string[] = [];
  const installed: string[] = [];
  let checks: Check[] = [];

  try {
    installed.push(installPluginSource(path.join(configHome, "opencode"), modules, "crash", CRASH_PLUGIN));
    installed.push(installPluginSource(path.join(configHome, "opencode"), modules, "steady", STEADY_PLUGIN));
    const launcher = spawnLauncher(
      context.qaRoot,
      socketPath,
      peer.record,
      {
        ...process.env,
        TERM: "xterm-256color",
        HOME: home,
        TMPDIR: path.join(context.out, "tmp"),
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        XDG_STATE_HOME: path.join(home, ".local", "state"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
      },
      evidence,
    );
    children.push(launcher);

    await waitFor(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS);
    const launchState = (evidence.text().match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none";
    const reportsReady = launchState === "ready";
    const layout = reportsReady && (await waitFor(evidence, (text) => HOME_MARKERS.some((marker) => text.includes(marker)), LAYOUT_TIMEOUT_MS));
    const crashed =
      layout && (await waitFor(evidence, (text) => text.includes("crashed in slot prompt.footer"), CRASH_TIMEOUT_MS));
    const steady = crashed && (await waitFor(evidence, (text) => text.includes(STEADY_MARKER), CRASH_TIMEOUT_MS));

    // A resize forces a full repaint, so the screen shows the live layout after the failing claim.
    const before = evidence.text().length;
    const terminal = launcher.terminal;
    if (terminal !== undefined) {
      terminal.resize(COLUMNS - 1, ROWS);
      terminal.resize(COLUMNS, ROWS);
    }
    const repainted = await waitFor(evidence, (text) => text.length > before, 10_000);
    const captured = evidence.text();
    fs.writeFileSync(path.join(context.out, "plugin-crash-isolation-pty.txt"), captured, { mode: 0o600 });
    artifacts.push("plugin-crash-isolation-pty.txt");
    const screen = await screenText({
      qaRoot: context.qaRoot,
      out: context.out,
      bytes: new TextEncoder().encode(captured),
      cols: COLUMNS,
      rows: ROWS,
    });
    fs.writeFileSync(path.join(context.out, "plugin-crash-isolation-screen.txt"), screen, { mode: 0o600 });
    artifacts.push("plugin-crash-isolation-screen.txt");
    const screenKeepsLayout = HOME_MARKERS.some((marker) => screen.includes(marker));
    const screenKeepsSteady = screen.includes(STEADY_MARKER);
    const childAlive = launcher.exitCode === null;

    const captureBytes = Buffer.byteLength(captured, "utf8");
    checks = [
      {
        name: "launcher-reports-ready",
        expected: "BRIDGE_STATE=ready after the handshake and the host pull, never failed",
        observed: "BRIDGE_STATE=" + launchState,
        pass: reportsReady,
      },
      {
        name: "crash-contained-by-plugin-boundary",
        expected:
          "a slot render failure is contained by the in-process plugin boundary and reported (this is not a process sandbox: a plugin that crashes the process or blocks the event loop is not contained)",
        observed: crashed ? "the boundary reported the crash" : "no crash report in the stream",
        pass: crashed,
      },
      {
        name: "other-plugin-still-renders",
        expected: "a healthy plugin keeps its slot after another plugin's claim crashes",
        observed: steady && screenKeepsSteady ? "steady slot visible on screen" : "steady slot missing",
        pass: steady && screenKeepsSteady,
      },
      {
        name: "main-ui-usable-after-crash",
        expected: "the home layout stays rendered and the TUI process stays alive",
        observed:
          "layout=" + String(screenKeepsLayout) + " repainted=" + String(repainted) + " childAlive=" + String(childAlive),
        pass: screenKeepsLayout && repainted && childAlive,
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture and the rendered screen under the evidence directory",
        observed: String(captureBytes) + " bytes",
        pass: captureBytes > 0,
      },
    ];
  } finally {
    for (const child of children) cleanupDetail.push(await stop(child));
    peer.server.stop(true);
    cleanupDetail.push("peer listener stopped");
    for (const target of [socketPath, peer.record]) {
      try {
        fs.unlinkSync(target);
      } catch {
        cleanupDetail.push("already absent: " + path.basename(target));
      }
    }
    for (const directory of installed) {
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true });
    }
    const agentDir = path.join(context.out, "agent");
    try {
      fs.rmSync(agentDir, { recursive: true, force: true });
    } catch {
      cleanupDetail.push("agent directory could not be removed");
    }
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.record) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
      "launch id " + peer.launchId.slice(0, 8) + " (synthetic, generated by this case)",
      home.startsWith(os.homedir() + path.sep) ? "HOME inside the user home" : "HOME isolated from the user home",
      "scope: only in-process render and setup failures are contained; there is no plugin sandbox",
    );
  }

  const cleanupOk = cleanupDetail.every(
    (entry) =>
      !entry.includes("did not exit") &&
      !entry.includes("still present") &&
      !entry.includes("could not") &&
      !entry.includes("inside the user home"),
  );
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts };
}
