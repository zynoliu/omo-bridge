import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts";
import { RULES_DOCUMENT_VERSION } from "../../../packages/bridge-core/src/permission-rules.ts";

/**
 * The read-only rules surface on the real TUI, driven in a PTY and read back from an xterm grid.
 *
 * The stand-in host completes the published socket handshake and answers the launcher's startup pulls.
 * The launcher loads `bridge-permissions.json` from its own config directory, so the document the bridge
 * enforces is also what the surface must show. The case runs "View session permission rules" from the
 * command palette on the home screen and holds when the rendered grid lists every rule with the effect
 * that applies.
 */

const READY_TIMEOUT_MS = 25_000;
const SCREEN_TIMEOUT_MS = 20_000;
const EXIT_TIMEOUT_MS = 5_000;
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 60;

const ROUTING_ID = "rpc-rules-1";
const SESSION_TITLE = "rules surface probe";
const ALLOW_RULE = { action: "read", resource: "/work/*", effect: "allow" } as const;
const DENY_RULE = { action: "bash", resource: "*", effect: "deny", reason: "shell is off-limits in this session" } as const;

const PALETTE = "\u0010";
const ENTER = "\r";

const PALETTE_FLAT = squash("Open settings");
const MOUNTED_FLAT = squash("shift+tab");
const COMMAND_FLAT = squash("View bridge permission rules");
const COMMAND_NEEDLE = "bridge permission";
const TITLE_FLAT = squash("Permission rules");
const COUNT_FLAT = squash("2 rules for " + ROUTING_ID);
const ALLOW_FLAT = squash([ALLOW_RULE.effect, ALLOW_RULE.action, ALLOW_RULE.resource].join(" "));
const DENY_FLAT = squash([DENY_RULE.effect, DENY_RULE.action, DENY_RULE.resource].join(" "));
const REASON_FLAT = squash("reason: " + DENY_RULE.reason);

type Capture = {
  readonly text: () => string;
  readonly push: (chunk: Uint8Array) => void;
  readonly subscribe: (listener: () => void) => () => void;
};

function capture(): Capture {
  let buffer = "";
  const listeners = new Set<() => void>();
  return {
    text: () => buffer,
    push(chunk: Uint8Array) {
      buffer += new TextDecoder().decode(chunk);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Resolves on the state change itself; the deadline only bounds how long the case waits. */
function waitForCapture(target: Capture, predicate: (text: string) => boolean, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const listener = () => {
      if (predicate(target.text())) finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const unsubscribe = target.subscribe(listener);
    listener();
  });
}

function plain(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*\u0007/g, "")
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b[PX^_][^\u001b]*\u001b\\/g, "");
}

function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

function flatScreen(text: string): string {
  return squash(plain(text));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function proof(key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  return !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name + ": " + error.message;
  return String(error);
}

type ClientSocket = { write(chunk: Uint8Array): unknown };

type PeerState = {
  readonly decoder: JsonlFrameDecoder;
  clientNonce?: string;
  serverNonce?: string;
};

type Peer = {
  readonly socketPath: string;
  readonly recordPath: string;
  readonly server: ReturnType<typeof Bun.listen>;
  readonly handshake: {
    infoReceived: boolean;
    serverProofSent: boolean;
    authenticateReceived: boolean;
    clientProofVerified: boolean;
  };
  readonly pulls: () => readonly string[];
};

/** Publishes the key record the documented host publishes, then serves the server half of the exchange. */
function startPeer(directory: string, socketPath: string, sessionDirectory: string): Peer {
  const agentDir = path.join(directory, "agent");
  const rpcDir = path.join(agentDir, "rpc");
  const keysDir = path.join(rpcDir, "keys");
  const launchId = randomUUID();
  const record = path.join(keysDir, launchId);
  const key = randomBytes(32);
  fs.mkdirSync(keysDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(agentDir, 0o755);
  fs.chmodSync(rpcDir, 0o755);
  fs.chmodSync(keysDir, 0o700);
  fs.writeFileSync(
    record,
    JSON.stringify({
      version: 1,
      launch_id: launchId,
      key: key.toString("hex"),
      pid: process.pid,
      process_start: null,
      endpoint: socketPath,
      created_at: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  fs.chmodSync(record, 0o600);

  const handshake = {
    infoReceived: false,
    serverProofSent: false,
    authenticateReceived: false,
    clientProofVerified: false,
  };
  const pulls: string[] = [];
  const connections = new WeakMap<object, PeerState>();

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      open() {},
      data(socket, chunk) {
        const state = connections.get(socket) ?? { decoder: new JsonlFrameDecoder() };
        connections.set(socket, state);
        let frames: readonly string[];
        try {
          frames = state.decoder.push(chunk);
        } catch {
          socket.end();
          return;
        }
        for (const line of frames) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (!isRecord(parsed)) continue;
          const id = readString(parsed, "id") ?? "";
          const type = readString(parsed, "type") ?? "";
          const answer = (frame: Record<string, unknown>) => socket.write(encodeFrame(frame));
          if (type === "get_protocol_info") {
            const auth = isRecord(parsed.auth) ? parsed.auth : undefined;
            const clientNonce = auth !== undefined ? (readString(auth, "client_nonce") ?? "") : "";
            if (!/^[0-9a-f]{64}$/.test(clientNonce)) {
              answer({ id, type: "response", command: type, success: false, error: "auth_required" });
              continue;
            }
            handshake.infoReceived = true;
            state.clientNonce = clientNonce;
            state.serverNonce = hex(randomBytes(32));
            const serverProof = proof(key, ["senpi-rpc-server", launchId, clientNonce, state.serverNonce]);
            handshake.serverProofSent = true;
            answer({
              id,
              type: "response",
              command: type,
              success: true,
              data: { auth: { launch_id: launchId, server_nonce: state.serverNonce, server_proof: serverProof } },
            });
            continue;
          }
          if (type === "authenticate") {
            handshake.authenticateReceived = true;
            const received = readString(parsed, "client_proof") ?? "";
            const expected = proof(key, [
              "senpi-rpc-client",
              launchId,
              state.serverNonce ?? "",
              state.clientNonce ?? "",
            ]);
            const ok =
              /^[0-9a-f]{64}$/.test(received) &&
              timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
            if (ok) handshake.clientProofVerified = true;
            answer({ id, type: "response", command: type, success: ok, ...(ok ? {} : { error: "auth_failed" }) });
            continue;
          }
          /* The launcher pulls host state before it reports ready; answering these is what lets the TUI
             reach the session it announces. They are recorded so a missing answer is visible. */
          const pull: Record<string, unknown> | undefined =
            type === "subscribe_sessions"
              ? {
                  subscriptionId: "sub-rules",
                  snapshot: [
                    {
                      type: "session_status",
                      sessionId: ROUTING_ID,
                      durableSessionId: ROUTING_ID,
                      cwd: sessionDirectory,
                      status: "idle",
                    },
                  ],
                }
              : type === "get_state"
                ? { sessionId: ROUTING_ID, sessionName: SESSION_TITLE, cwd: sessionDirectory, isStreaming: false }
                : type === "get_messages"
                  ? { messages: [] }
                  : type === "get_pending_inputs"
                    ? { inputs: [] }
                    : type === "get_entries"
                      ? { entries: [], leafId: null }
                      : type === "get_available_models"
                        ? { models: [] }
                        : undefined;
          if (pull !== undefined) {
            pulls.push(type);
            answer({ id, type: "response", command: type, success: true, data: pull });
            continue;
          }
          answer({ id, type: "response", command: type, success: true, data: {} });
        }
      },
      close() {},
      error() {},
    },
  });

  return {
    socketPath: socketPath,
    recordPath: record,
    server: server,
    handshake: handshake,
    pulls: () => pulls,
  };
}

function spawnLauncher(
  qaRoot: string,
  socketPath: string,
  recordPath: string,
  configDirectory: string,
  stateRoot: string,
  target: Capture,
) {
  const launcherCwd = path.join(qaRoot, "..", "..", "packages", "cli");
  return Bun.spawn({
    cmd: [
      process.execPath,
      "--no-install",
      "--no-env-file",
      path.join(launcherCwd, "src", "bridge-run.ts"),
      "--socket",
      socketPath,
      "--key-record",
      recordPath,
    ],
    // The TUI's JSX runtime resolves through the CLI package's tsconfig, as in `bun run dev`.
    cwd: launcherCwd,
    terminal: {
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      data(_terminal, chunk) {
        target.push(chunk);
      },
    },
    /* The TUI's tab and storage roots are `XDG_STATE_HOME`, so pointing them into the evidence keeps
       persisted tabs from an earlier run out of this screen and leaves the real state untouched. */
    env: {
      ...process.env,
      TERM: "xterm-256color",
      OPENCODE_CONFIG_DIR: configDirectory,
      XDG_STATE_HOME: path.join(stateRoot, "state"),
      XDG_DATA_HOME: path.join(stateRoot, "data"),
      XDG_CACHE_HOME: path.join(stateRoot, "cache"),
    },
  });
}

type Launcher = ReturnType<typeof spawnLauncher>;

async function stop(proc: Launcher): Promise<string> {
  proc.kill();
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ]);
  return exited ? "launcher child exited" : "launcher child did not exit within " + EXIT_TIMEOUT_MS + "ms";
}

function locateXterm(qaRoot: string): { readonly script: string; readonly css: string } {
  const packageRoot = path.join(qaRoot, "node_modules", "@xterm", "xterm");
  const script = path.join(packageRoot, "lib", "xterm.js");
  const css = path.join(packageRoot, "css", "xterm.css");
  if (!fs.existsSync(script)) throw new Error("@xterm/xterm browser bundle is missing: " + script);
  if (!fs.existsSync(css)) throw new Error("@xterm/xterm stylesheet is missing: " + css);
  return { script: script, css: css };
}

/** Replays the captured PTY bytes into a terminal and reads the visible grid back. */
function screenPage(css: string, library: string, captured: string): string {
  const payload = JSON.stringify(captured).replace(/</g, "\\u003c");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge rules screen</title>
<style>${css}
html,body{margin:0;background:#000;}
</style></head>
<body><div id="host"></div>
<script>${library}</script>
<script>window.__captured = ${payload}</script>
<script>
const term = new Terminal({ cols: ${String(TERMINAL_COLS)}, rows: ${String(TERMINAL_ROWS)}, scrollback: 0, allowProposedApi: true });
term.open(document.getElementById("host"));
window.renderScreen = () => new Promise((resolve) => {
  term.reset();
  term.write(window.__captured, () => resolve(true));
});
window.screenText = () => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let row = buffer.viewportY; row < buffer.viewportY + term.rows; row += 1) {
    const line = buffer.getLine(row);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\\n");
};
</script></body></html>`;
}

async function renderScreen(context: CaseContext, captured: string, artifacts: string[]): Promise<string> {
  const { script, css } = locateXterm(context.qaRoot);
  const pagePath = path.join(context.out, "rules-screen.html");
  fs.writeFileSync(pagePath, screenPage(fs.readFileSync(css, "utf8"), fs.readFileSync(script, "utf8"), captured), {
    mode: 0o600,
  });
  artifacts.push("rules-screen.html");
  const view = new Bun.WebView({ width: 1200, height: 1100 });
  try {
    await view.navigate("file://" + pagePath);
    await view.evaluate("window.renderScreen()");
    const text = String(await view.evaluate("window.screenText()"));
    fs.writeFileSync(path.join(context.out, "rules-screen.txt"), text, { mode: 0o600 });
    artifacts.push("rules-screen.txt");
    const shot = await view.screenshot();
    await Bun.write(path.join(context.out, "rules-screen.png"), shot);
    artifacts.push("rules-screen.png");
    return text;
  } finally {
    await view.close();
  }
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock");
  const configDirectory = path.join(context.out, "config");
  fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(configDirectory, "bridge-permissions.json"),
    JSON.stringify({ version: RULES_DOCUMENT_VERSION, sessions: { [ROUTING_ID]: [ALLOW_RULE, DENY_RULE] } }, null, 2) +
      "\n",
    { mode: 0o600 },
  );

  const peer = startPeer(context.out, socketPath, path.join(context.qaRoot, "..", "..", "packages", "cli"));
  const evidence = capture();
  const children: Launcher[] = [];
  const checks: Check[] = [];
  const cleanupDetail: string[] = [];
  const artifacts: string[] = ["config/bridge-permissions.json"];

  try {
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.recordPath, configDirectory, path.join(context.out, "xdg"), evidence);
    children.push(launcher);
    const reported = await waitForCapture(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS);
    const launchState = (plain(evidence.text()).match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none";
    const ready = reported && launchState === "ready";
    const terminal = launcher.terminal;

    /* The launch line is printed before the TUI mounts its key layer, so the first key waits for the
       home footer rather than racing the boot. */
    const mounted = ready && (await waitForCapture(evidence, (text) => flatScreen(text).includes(MOUNTED_FLAT), SCREEN_TIMEOUT_MS));

    /* The command palette is the surface's way in, and it is reachable from the home screen the launcher
       starts on. Each keystroke waits for the screen to show its effect before the next one. */
    if (mounted && terminal !== undefined) terminal.write(PALETTE);
    const paletteOpen =
      mounted && (await waitForCapture(evidence, (text) => flatScreen(text).includes(PALETTE_FLAT), SCREEN_TIMEOUT_MS));
    if (paletteOpen && terminal !== undefined) terminal.write(COMMAND_NEEDLE);
    const commandListed =
      paletteOpen && (await waitForCapture(evidence, (text) => flatScreen(text).includes(COMMAND_FLAT), SCREEN_TIMEOUT_MS));
    if (commandListed && terminal !== undefined) terminal.write(ENTER);
    const dialogShown =
      commandListed && (await waitForCapture(evidence, (text) => flatScreen(text).includes(TITLE_FLAT), SCREEN_TIMEOUT_MS));
    /* The title paints before the rows do, so the snapshot waits for the last rule line and not just the frame. */
    const bodyRendered =
      dialogShown && (await waitForCapture(evidence, (text) => flatScreen(text).includes(REASON_FLAT), SCREEN_TIMEOUT_MS));

    const captured = evidence.text();
    const captureBytes = Buffer.byteLength(captured, "utf8");
    fs.writeFileSync(path.join(context.out, "tui-permission-rules-pty.txt"), captured, { mode: 0o600 });
    artifacts.push("tui-permission-rules-pty.txt");

    const screen = await renderScreen(context, captured, artifacts);
    const screenFlat = squash(screen);
    const screenHas = (flat: string) => screenFlat.includes(flat);
    const rulesRendered = screenHas(TITLE_FLAT) && screenHas(COUNT_FLAT) && screenHas(ALLOW_FLAT) && screenHas(DENY_FLAT) && screenHas(REASON_FLAT);

    checks.push(
      {
        name: "handshake-verified",
        expected: "the peer answers get_protocol_info with data.auth and the client returns a valid client_proof",
        observed:
          "info=" +
          String(peer.handshake.infoReceived) +
          " serverProof=" +
          String(peer.handshake.serverProofSent) +
          " authenticate=" +
          String(peer.handshake.authenticateReceived) +
          " clientProof=" +
          String(peer.handshake.clientProofVerified) +
          " pulls=" +
          JSON.stringify(peer.pulls()),
        pass:
          peer.handshake.infoReceived &&
          peer.handshake.serverProofSent &&
          peer.handshake.authenticateReceived &&
          peer.handshake.clientProofVerified,
      },
      {
        name: "launcher-reports-ready",
        expected: "BRIDGE_STATE=ready after the handshake",
        observed: "BRIDGE_STATE=" + launchState,
        pass: ready,
      },
      {
        name: "command-palette-opened-from-home",
        expected: "ctrl+p opens the command palette on the screen the launcher starts on",
        observed: paletteOpen ? "palette listed its commands" : "no palette; tail: " + flatScreen(evidence.text()).slice(-160),
        pass: paletteOpen,
      },
      {
        name: "palette-lists-the-rules-command",
        expected: "the bridge TUI's command palette offers " + COMMAND_FLAT,
        observed: commandListed ? "command listed" : "not listed; screen tail: " + flatScreen(evidence.text()).slice(-160),
        pass: commandListed,
      },
      {
        name: "rules-dialog-opened",
        expected: "the palette entry opens the rules dialog",
        observed: dialogShown ? "dialog title on the stream" : "no dialog title seen",
        pass: dialogShown,
      },
      {
        name: "rules-body-painted-before-the-snapshot",
        expected: "the deny rule's reason reaches the screen before the grid is read",
        observed: bodyRendered ? "last rule line on the stream" : "the body never finished painting",
        pass: bodyRendered,
      },
      {
        name: "rules-rendered-on-the-terminal-grid",
        expected:
          "the xterm grid lists " +
          [COUNT_FLAT, ALLOW_FLAT, DENY_FLAT].join(", ") +
          " and the deny reason",
        observed: rulesRendered
          ? "all rules, effects and the reason on the grid"
          : "missing: " +
            [
              [TITLE_FLAT, screenHas(TITLE_FLAT)],
              [COUNT_FLAT, screenHas(COUNT_FLAT)],
              [ALLOW_FLAT, screenHas(ALLOW_FLAT)],
              [DENY_FLAT, screenHas(DENY_FLAT)],
              [REASON_FLAT, screenHas(REASON_FLAT)],
            ]
              .filter((entry) => entry[1] === false)
              .map((entry) => String(entry[0]))
              .join(", "),
        pass: rulesRendered,
      },
      {
        name: "pty-evidence-written",
        expected: "a non-empty PTY capture under the evidence directory",
        observed: String(captureBytes) + " bytes",
        pass: captureBytes > 0,
      },
    );
  } finally {
    for (const child of children) cleanupDetail.push(await stop(child));
    peer.server.stop(true);
    for (const target of [socketPath, peer.recordPath]) {
      try {
        fs.unlinkSync(target);
      } catch {
        cleanupDetail.push("already absent: " + path.basename(target));
      }
    }
    const agentDir = path.join(context.out, "agent");
    try {
      fs.rmSync(agentDir, { recursive: true, force: true });
    } catch {
      cleanupDetail.push("agent directory could not be removed");
    }
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.recordPath) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
    );
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: cleanupDetail }, artifacts: artifacts };
}
