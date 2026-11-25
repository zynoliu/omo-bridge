import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { JsonlFrameDecoder, encodeFrame } from "../../../packages/bridge-core/src/transport.ts";
import { screenText } from "../lib/terminal-screen.ts";

const READY_TIMEOUT_MS = 20_000;
const LAYOUT_TIMEOUT_MS = 30_000;
const PLUGIN_TIMEOUT_MS = 30_000;
const UNLOAD_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 5_000;
const COLUMNS = 120;
const ROWS = 40;
const HOME_MARKERS = ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"];
const PLUGIN_ID = "fixture.bridge-qa";
const PLUGIN_TOKENS = ["qa-plugin d=s1", "c=s1", "st=1", "ui=1", "rf=1", "km=1"];

export type Capture = {
  readonly text: () => string;
  readonly push: (chunk: Uint8Array) => void;
  readonly subscribe: (listener: () => void) => () => void;
};

export function capture(): Capture {
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
export function waitFor(target: Capture, predicate: (text: string) => boolean, timeoutMs: number): Promise<boolean> {
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

function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const poll = () => {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(poll, 50);
    };
    poll();
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  return !Array.isArray(value);
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

/**
 * The cleanup gate for the run HOME: acceptable only when it is a directory this case created and it is not the
 * real user home or anywhere below it. A HOME under the evidence directory fails this on a machine whose evidence
 * lives inside the user home, which is the regression this case exists to catch.
 */
export function homeIsolation(
  home: string,
  runRoot: string,
  realHome: string,
): { readonly ok: boolean; readonly detail: readonly string[] } {
  const real = (value: string) => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const owned = isInside(real(home), real(runRoot));
  const insideUserHome = isInside(real(home), real(realHome));
  return {
    ok: owned && !insideUserHome,
    detail: [
      insideUserHome ? "HOME inside the user home" : "HOME isolated from the user home",
      owned ? "HOME inside the run-owned directory" : "HOME outside the run-owned directory",
    ],
  };
}

function proof(key: Buffer, parts: readonly string[]): string {
  return createHmac("sha256", key).update(parts.join("\n"), "utf8").digest("hex");
}

function hostSession() {
  return {
    status: {
      type: "session_status",
      sessionId: "routing-qa",
      durableSessionId: "s1",
      cwd: "/workspace",
      status: "idle",
    },
    state: { sessionId: "s1", sessionName: "Bridge QA", isStreaming: false },
    messages: {
      messages: [{ role: "user", timestamp: 1, content: "plugin qa" }],
    },
    pending: { inputs: [] },
  };
}

type PeerState = {
  readonly decoder: JsonlFrameDecoder;
  clientNonce?: string;
  serverNonce?: string;
};

export type Peer = {
  readonly socket: string;
  readonly record: string;
  readonly launchId: string;
  readonly server: ReturnType<typeof Bun.listen>;
  readonly observed: {
    infoReceived: boolean;
    serverProofSent: boolean;
    authenticateReceived: boolean;
    clientProofVerified: boolean;
    pulledSessions: boolean;
  };
};

/** Publishes the key record the documented host publishes, then serves both halves of the exchange. */
export function startPeer(directory: string, socketPath: string): Peer {
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

  const session = hostSession();
  const observed = {
    infoReceived: false,
    serverProofSent: false,
    authenticateReceived: false,
    clientProofVerified: false,
    pulledSessions: false,
  };
  const connections = new WeakMap<object, PeerState>();

  const answer = (socket: { write(chunk: Uint8Array): unknown }, frame: Record<string, unknown>) => {
    socket.write(encodeFrame(frame));
  };

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
          const id = typeof parsed.id === "string" ? parsed.id : "";
          const type = typeof parsed.type === "string" ? parsed.type : "";
          if (type === "get_protocol_info") {
            const auth = isRecord(parsed.auth) ? parsed.auth : undefined;
            const clientNonce = auth !== undefined && typeof auth.client_nonce === "string" ? auth.client_nonce : "";
            if (!/^[0-9a-f]{64}$/.test(clientNonce)) {
              answer(socket, { id, type: "response", command: type, success: false, error: "auth_required" });
              continue;
            }
            observed.infoReceived = true;
            state.clientNonce = clientNonce;
            state.serverNonce = randomBytes(32).toString("hex");
            const serverProof = proof(key, ["senpi-rpc-server", launchId, clientNonce, state.serverNonce]);
            observed.serverProofSent = true;
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: true,
              data: { auth: { launch_id: launchId, server_nonce: state.serverNonce, server_proof: serverProof } },
            });
            continue;
          }
          if (type === "authenticate") {
            observed.authenticateReceived = true;
            const received = typeof parsed.client_proof === "string" ? parsed.client_proof : "";
            const expected = proof(key, ["senpi-rpc-client", launchId, state.serverNonce ?? "", state.clientNonce ?? ""]);
            const ok =
              /^[0-9a-f]{64}$/.test(received) &&
              timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(received, "hex"));
            if (ok) observed.clientProofVerified = true;
            answer(socket, { id, type: "response", command: type, success: ok, ...(ok ? {} : { error: "auth_failed" }) });
            continue;
          }
          if (type === "subscribe_sessions") {
            observed.pulledSessions = true;
            answer(socket, {
              id,
              type: "response",
              command: type,
              success: true,
              data: { subscriptionId: "sub-qa", snapshot: [session.status] },
            });
            continue;
          }
          if (type === "get_state") {
            answer(socket, { id, type: "response", command: type, success: true, data: session.state });
            continue;
          }
          if (type === "get_messages") {
            answer(socket, { id, type: "response", command: type, success: true, data: session.messages });
            continue;
          }
          if (type === "get_pending_inputs") {
            answer(socket, { id, type: "response", command: type, success: true, data: session.pending });
            continue;
          }
          answer(socket, { id, type: "response", command: type, success: false, error: "unsupported_command" });
        }
      },
      close() {},
      error() {},
    },
  });

  return { socket: socketPath, record: record, launchId: launchId, server: server, observed: observed };
}

function pluginSource(cleanupPath: string, heartbeatPath: string) {
  return `import { Plugin } from "@opencode/plugin/tui"

let beats = 0

export default Plugin.define({
  id: ${JSON.stringify(PLUGIN_ID)},
  async setup(context) {
    const timer = setInterval(() => {
      beats = beats + 1
      void Bun.write(${JSON.stringify(heartbeatPath)}, String(beats))
    }, 100)
    const [stored, update] = context.storage.store("qa", { initial: { runs: 0 } })
    await update((draft) => {
      draft.runs = draft.runs + 1
    })
    const sessions = context.data.session.list().map((session) => session.id).join(",")
    const listed = await context.client.session.list({})
    const surface = [
      typeof context.ui.dialog.show === "function" ? "ui=1" : "ui=0",
      typeof context.renderer.requestRender === "function" ? "rf=1" : "rf=0",
      typeof context.keymap.layer === "function" ? "km=1" : "km=0",
    ].join(" ")
    context.ui.slot({
      append: "prompt.footer",
      render: () => (
        <text>
          qa-plugin d={sessions} c={listed.data.map((session) => session.id).join(",")} st={stored.runs} {surface}
        </text>
      ),
    })
    return async () => {
      clearInterval(timer)
      await Bun.write(${JSON.stringify(cleanupPath)}, "cleanup ran")
    }
  },
})
`;
}

export function installPluginSource(configDirectory: string, modules: string, name: string, source: string) {
  const directory = path.join(configDirectory, "plugins", name);
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(modules, path.join(directory, "node_modules"));
  fs.writeFileSync(path.join(directory, "tui.tsx"), source, { mode: 0o600 });
  return directory;
}

function findPluginState(root: string, name: string): string | undefined {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findPluginState(target, name);
      if (found !== undefined) return found;
    }
    if (entry.isFile() && entry.name === name) return target;
  }
  return undefined;
}

export function spawnLauncher(qaRoot: string, socketPath: string, recordPath: string, env: Record<string, string | undefined>, target: Capture) {
  return Bun.spawn({
    cmd: [
      process.execPath,
      "--no-install",
      "--no-env-file",
      path.join(qaRoot, "..", "..", "packages", "cli", "src", "bridge-run.ts"),
      "--socket",
      socketPath,
      "--key-record",
      recordPath,
    ],
    // The TUI's JSX runtime resolves through the CLI package's tsconfig, as in `bun run dev`.
    cwd: path.join(qaRoot, "..", "..", "packages", "cli"),
    terminal: {
      cols: COLUMNS,
      rows: ROWS,
      data(_terminal, chunk) {
        target.push(chunk);
      },
    },
    env: env,
  });
}

export async function stop(proc: ReturnType<typeof spawnLauncher>): Promise<string> {
  proc.kill();
  const exited = await Promise.race([
    proc.exited.then(() => true).catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), EXIT_TIMEOUT_MS)),
  ]);
  return exited ? "child exited" : "child did not exit within " + EXIT_TIMEOUT_MS + "ms";
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const socketPath = path.join(context.out, "host.sock");
  // The run's HOME must be a directory this case owns, outside the real user home: the launcher writes
  // config, state and cache there, and an evidence directory that lives inside the user home is not isolation.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-qa-plugin-"));
  const home = path.join(sandbox, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const configHome = path.join(home, ".config");
  const stateHome = path.join(home, ".local", "state");
  const cleanupPath = path.join(home, "qa-plugin-cleanup.txt");
  const heartbeatPath = path.join(home, "qa-plugin-heartbeat.txt");
  const peer = startPeer(context.out, socketPath);
  const evidence = capture();
  const children: ReturnType<typeof spawnLauncher>[] = [];
  const cleanupDetail: string[] = [];
  const artifacts: string[] = [];
  let checks: Check[] = [];
  let pluginDirectory: string | undefined;
  let homeIsolated = false;

  try {
    pluginDirectory = installPluginSource(
      path.join(configHome, "opencode"),
      path.join(context.qaRoot, "..", "..", "packages", "tui", "node_modules"),
      "qa",
      pluginSource(cleanupPath, heartbeatPath),
    );
    const launcher = spawnLauncher(context.qaRoot, socketPath, peer.record, {
      ...process.env,
      TERM: "xterm-256color",
      HOME: home,
      TMPDIR: path.join(context.out, "tmp"),
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: stateHome,
      XDG_CACHE_HOME: path.join(home, ".cache"),
    }, evidence);
    children.push(launcher);

    await waitFor(evidence, (text) => /BRIDGE_STATE=/.test(text), READY_TIMEOUT_MS);
    const launchState = (evidence.text().match(/BRIDGE_STATE=([a-z]+)/) ?? ["", "none"])[1] ?? "none";
    const reportsReady = launchState === "ready";
    const layout = reportsReady && (await waitFor(evidence, (text) => HOME_MARKERS.some((marker) => text.includes(marker)), LAYOUT_TIMEOUT_MS));
    const slotted = layout && (await waitFor(evidence, (text) => text.includes("qa-plugin d=s1"), PLUGIN_TIMEOUT_MS));

    const stateFile = findPluginState(stateHome, "plugin." + PLUGIN_ID + ".qa.json");
    const stored: unknown = stateFile === undefined ? undefined : JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const storageOk = isRecord(stored) && stored.runs === 1;

    const captured = evidence.text();
    fs.writeFileSync(path.join(context.out, "plugin-real-renderer-pty.txt"), captured, { mode: 0o600 });
    artifacts.push("plugin-real-renderer-pty.txt");
    const beforeUnload = await screenText({
      qaRoot: context.qaRoot,
      out: context.out,
      bytes: new TextEncoder().encode(captured),
      cols: COLUMNS,
      rows: ROWS,
    });
    const screenShowsSlot = PLUGIN_TOKENS.every((token) => beforeUnload.includes(token));

    fs.rmSync(pluginDirectory, { recursive: true, force: true });
    const unloadRecorded = await waitForFile(cleanupPath, UNLOAD_TIMEOUT_MS);
    const beatsBefore = fs.existsSync(heartbeatPath) ? Number(fs.readFileSync(heartbeatPath, "utf8")) : 0;
    await Bun.sleep(400);
    const beatsAfter = fs.existsSync(heartbeatPath) ? Number(fs.readFileSync(heartbeatPath, "utf8")) : 0;
    const heartbeatStopped = beatsBefore > 0 && beatsBefore === beatsAfter;
    // A resize forces a full repaint, so the screen shows the live layout rather than whatever rows
    // the incremental updates happened not to touch.
    const before = evidence.text().length;
    const terminal = launcher.terminal;
    if (terminal !== undefined) {
      terminal.resize(COLUMNS - 1, ROWS);
      terminal.resize(COLUMNS, ROWS);
    }
    const repainted = await waitFor(evidence, (text) => text.length > before, 10_000);
    const after = await screenText({
      qaRoot: context.qaRoot,
      out: context.out,
      bytes: new TextEncoder().encode(evidence.text()),
      cols: COLUMNS,
      rows: ROWS,
    });
    const screenCleared = repainted && !after.includes("qa-plugin");
    const layoutAfterUnload = HOME_MARKERS.some((marker) => after.includes(marker));
    fs.writeFileSync(path.join(context.out, "plugin-real-renderer-screen.txt"), beforeUnload + "\n--- after unload ---\n" + after, {
      mode: 0o600,
    });
    artifacts.push("plugin-real-renderer-screen.txt");

    const captureBytes = Buffer.byteLength(captured, "utf8");
    checks = [
      {
        name: "host-proof-exchange",
        expected: "the peer answers get_protocol_info with data.auth and the client returns a valid client_proof",
        observed:
          "info=" +
          String(peer.observed.infoReceived) +
          " serverProof=" +
          String(peer.observed.serverProofSent) +
          " authenticate=" +
          String(peer.observed.authenticateReceived) +
          " clientProof=" +
          String(peer.observed.clientProofVerified),
        pass:
          peer.observed.infoReceived &&
          peer.observed.serverProofSent &&
          peer.observed.authenticateReceived &&
          peer.observed.clientProofVerified,
      },
      {
        name: "launcher-reports-ready",
        expected: "BRIDGE_STATE=ready after the handshake and the host pull, never failed",
        observed: "BRIDGE_STATE=" + launchState + (reportsReady ? "" : " (" + evidence.text().slice(-160).replace(/\s+/g, " ").trim() + ")"),
        pass: reportsReady && peer.observed.pulledSessions,
      },
      {
        name: "main-layout-rendered",
        expected: "the home composer text appears in the PTY stream",
        observed: layout ? "layout marker present" : "no layout marker; screen tail: " + beforeUnload.slice(-200).replace(/\s+/g, " ").trim(),
        pass: layout,
      },
      {
        name: "plugin-slot-rendered-with-bridge-context",
        expected: "the controlled plugin renders a prompt.footer slot with the bridge session, client, storage and host surfaces",
        observed: slotted ? "tokens " + PLUGIN_TOKENS.join(" ") : "marker missing from the stream",
        pass: slotted && screenShowsSlot,
      },
      {
        name: "plugin-storage-persisted",
        expected: "the plugin's durable store reached disk with one run",
        observed: stateFile === undefined ? "no plugin state file" : JSON.stringify(stored),
        pass: storageOk,
      },
      {
        name: "plugin-unloaded-with-resources",
        expected: "removing the plugin runs its cleanup, stops its timer and clears its slot while the TUI stays usable",
        observed:
          "cleanup=" +
          String(unloadRecorded) +
          " heartbeat=" +
          String(beatsBefore) +
          "->" +
          String(beatsAfter) +
          " screenCleared=" +
          String(screenCleared) +
          " layoutKept=" +
          String(layoutAfterUnload),
        pass: unloadRecorded && heartbeatStopped && screenCleared && layoutAfterUnload,
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
    if (pluginDirectory !== undefined && fs.existsSync(pluginDirectory)) {
      fs.rmSync(pluginDirectory, { recursive: true, force: true });
      cleanupDetail.push("plugin directory removed during cleanup");
    }
    const agentDir = path.join(context.out, "agent");
    try {
      fs.rmSync(agentDir, { recursive: true, force: true });
    } catch {
      cleanupDetail.push("agent directory could not be removed");
    }
    const isolation = homeIsolation(home, sandbox, os.homedir());
    homeIsolated = isolation.ok;
    for (const [name, file] of [
      ["plugin-home-cleanup.txt", cleanupPath],
      ["plugin-home-heartbeat.txt", heartbeatPath],
    ] as const) {
      if (!fs.existsSync(file)) continue;
      fs.copyFileSync(file, path.join(context.out, name));
      artifacts.push(name);
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
    cleanupDetail.push(
      fs.existsSync(socketPath) ? "socket still present" : "socket removed",
      fs.existsSync(peer.record) ? "key record still present" : "key record removed",
      fs.existsSync(agentDir) ? "agent directory still present" : "agent directory removed",
      "launch id " + peer.launchId.slice(0, 8) + " (synthetic, generated by this case)",
      "run HOME " + home,
      ...isolation.detail,
      fs.existsSync(sandbox) ? "run HOME still present" : "run HOME removed",
    );
  }

  const cleanupOk =
    homeIsolated &&
    cleanupDetail.every(
      (entry) =>
        !entry.includes("did not exit") &&
        !entry.includes("still present") &&
        !entry.includes("could not") &&
        !entry.includes("inside the user home") &&
        !entry.includes("outside the run-owned directory"),
    );
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts };
}
