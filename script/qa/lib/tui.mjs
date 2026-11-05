import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createScreen } from "./frame.mjs";

// The TUI is an OpenTUI app: it opens with capability queries and waits for a real terminal to answer
// them. A bare PTY answers nothing and the screen never leaves the shell banner, so the driver runs the
// app inside tmux, which is a terminal emulator and answers those queries the way xterm does.

const KEYS = {
  Enter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  BSpace: "BSpace",
  Up: "Up",
  Down: "Down",
  Right: "Right",
  Left: "Left",
};

function tmux(...args) {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  return proc;
}

async function tmuxRun(...args) {
  const proc = tmux(...args);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

export async function startTui(options) {
  const repo = options.repo ?? process.cwd();
  const bunExe = options.bunExe ?? "/opt/homebrew/bin/bun";
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 36;
  const name = options.name ?? `qa-${Math.random().toString(36).slice(2, 10)}`;
  const transcriptPath = `${options.evidenceDir ?? "."}/tmux-stream.log`;

  const args = [bunExe, "run", "bin/omo-bridge", "tui"];
  if (options.sessionID !== undefined) args.push("--session", options.sessionID);
  const command = [
    `cd ${JSON.stringify(repo)}`,
    "&&",
    `OMO_BRIDGE_STATE_DIR=${JSON.stringify(options.stateDir)}`,
    `OMO_BRIDGE_TUI_BUN=${JSON.stringify(bunExe)}`,
    `PATH=${JSON.stringify(`${dirname(bunExe)}:${process.env.PATH ?? ""}`)}`,
    "TERM=xterm-256color",
    args.map((value) => JSON.stringify(value)).join(" "),
  ].join(" ");

  await tmuxRun("new-session", "-d", "-s", name, "-x", String(cols), "-y", String(rows), command);
  await Bun.sleep(500);

  let stopped = false;
  const screen = () => {
    const proc = Bun.spawn(["tmux", "capture-pane", "-p", "-J", "-t", name], { stdout: "pipe", stderr: "ignore" });
    const text = new Response(proc.stdout).text();
    return text;
  };
  const ansiScreen = async () => {
    const proc = Bun.spawn(["tmux", "capture-pane", "-e", "-p", "-t", name], { stdout: "pipe", stderr: "ignore" });
    const raw = await new Response(proc.stdout).text();
    await proc.exited;
    return raw;
  };

  return {
    name,
    async write(text) {
      await tmuxRun("send-keys", "-t", name, "-l", text);
    },
    async press(key) {
      await tmuxRun("send-keys", "-t", name, KEYS[key] ?? key);
    },
    async text() {
      const text = await screen();
      return text.replace(/\s+$/u, "");
    },
    lines(text) {
      return (text ?? "").split("\n");
    },
    async transcript() {
      return (await ansiScreen()).replace(/\u001b/g, "\\e");
    },
    async waitFor(predicate, timeoutMs = 30_000, intervalMs = 300) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = await this.text();
        if (predicate(frame)) return true;
        await Bun.sleep(intervalMs);
      }
      return predicate(await this.text());
    },
    async screenshot(path) {
      mkdirSync(dirname(path), { recursive: true });
      const raw = await ansiScreen();
      const screenModel = createScreen(cols, rows);
      screenModel.write(raw);
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#11111b;color:#cdd6f4;font:13px/1.3 "SF Mono",Menlo,monospace}
pre{margin:16px;white-space:pre}
</style></head><body><pre>${screenModel
        .text()
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre></body></html>`;
      if (typeof Bun.WebView !== "function") return { written: false, reason: "Bun.WebView unavailable" };
      const view = new Bun.WebView({ width: cols * 9 + 32, height: rows * 18 + 32 });
      try {
        await view.navigate(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
        const png = await view.screenshot({ type: "png" });
        await Bun.write(path, png);
        return { written: true, path };
      } catch (error) {
        return { written: false, reason: String(error).slice(0, 160) };
      } finally {
        try {
          view.close();
        } catch {
          // Already closed.
        }
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await tmuxRun("pipe-pane", "-t", name);
      await tmuxRun("kill-session", "-t", name);
    },
    transcriptPath,
  };
}
