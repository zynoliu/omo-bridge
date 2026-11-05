import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Renders the TUI's PTY stream through xterm.js in a page and screenshots it. xterm.js is a real
// terminal emulator: it answers the capability queries an OpenTUI app sends on start, which a bare
// PTY cannot, and its buffer is the rendered frame the scenario asserts on.

const KEYS = {
  Enter: "\r",
  Escape: "\u001b",
  Tab: "\t",
  BSpace: "\u007f",
  Up: "\u001b[A",
  Down: "\u001b[B",
  Right: "\u001b[C",
  Left: "\u001b[D",
};

function asset(name) {
  return readFileSync(join(import.meta.dir, "..", "..", "..", "node_modules", "@xterm", "xterm", name), "utf8");
}

function page() {
  const script = asset("lib/xterm.js");
  const css = asset("css/xterm.css");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}
html,body{margin:0;background:#11111b;height:100%}
#t{height:100%}
</style></head><body><div id="t"></div><script>${script}</script><script>
const term = new Terminal({ cols: ${"__COLS__"}, rows: ${"__ROWS__"}, convertEol: false, allowProposedApi: true, fontFamily: "SF Mono, Menlo, monospace", fontSize: 13, theme: { background: "#11111b", foreground: "#cdd6f4" } });
term.open(document.getElementById("t"));
term.focus();
window.__term = term;
window.__text = () => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i += 1) {
    const line = buffer.getLine(i);
    if (line === undefined) continue;
    lines.push(line.translateToString(true));
  }
  return lines.join("\\n").replace(/\\s+$/u, "");
};
const ws = new WebSocket("ws://" + location.host + "/pty");
ws.onmessage = (event) => term.write(event.data);
window.__send = (data) => ws.send(data);
</script></body></html>`;
}

export async function startXtermTui(options) {
  const repo = options.repo ?? process.cwd();
  const bunExe = options.bunExe ?? "/opt/homebrew/bin/bun";
  const cols = options.cols ?? 120;
  const rows = options.rows ?? 36;
  const sockets = new Set();
  const chunks = [];

  const term = new Bun.Terminal({
    cols,
    rows,
    data(_terminal, chunk) {
      const text = new TextDecoder().decode(chunk);
      chunks.push(text);
      for (const socket of sockets) {
        try {
          socket.send(text);
        } catch {
          // The page is reloading.
        }
      }
    },
  });

  const args = [bunExe, "run", "bin/omo-bridge", "tui"];
  if (options.sessionID !== undefined) args.push("--session", options.sessionID);
  const bunDir = dirname(bunExe);
  const path = (process.env.PATH ?? "")
    .split(":")
    .filter((entry) => entry.length > 0 && entry !== bunDir)
    .join(":");
  const child = Bun.spawn(args, {
    cwd: repo,
    env: {
      ...process.env,
      PATH: path.length > 0 ? `${bunDir}:${path}` : bunDir,
      OMO_BRIDGE_STATE_DIR: options.stateDir,
      OMO_BRIDGE_TUI_BUN: bunExe,
      TERM: "xterm-256color",
    },
    terminal: term,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const html = page().replace("__COLS__", String(cols)).replace("__ROWS__", String(rows));
  const server = Bun.serve({
    port: 0,
    fetch(request, srv) {
      if (srv.upgrade(request)) return undefined;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(_ws, message) {
        term.write(String(message));
      },
    },
  });

  const view = new Bun.WebView({ width: cols * 9 + 32, height: rows * 18 + 32 });
  await view.navigate(`http://127.0.0.1:${server.port}/`);

  let stopped = false;
  return {
    pid: child.pid,
    async write(text) {
      term.write(text);
    },
    async press(key) {
      term.write(KEYS[key] ?? key);
    },
    async text() {
      const value = await view.evaluate("window.__text()");
      return typeof value === "string" ? value : "";
    },
    async transcript() {
      return chunks.join("");
    },
    async waitFor(predicate, timeoutMs = 30_000, intervalMs = 400) {
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
      try {
        const png = await view.screenshot({ type: "png" });
        await Bun.write(path, png);
        return { written: true, path };
      } catch (error) {
        return { written: false, reason: String(error).slice(0, 160) };
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        view.close();
      } catch {
        // Already closed.
      }
      try {
        server.stop(true);
      } catch {
        // Already stopped.
      }
      try {
        child.kill();
      } catch {
        // Already gone.
      }
      const deadline = Date.now() + 10_000;
      while (child.exitCode === null && Date.now() < deadline) await Bun.sleep(100);
      try {
        term.close();
      } catch {
        // Already closed.
      }
    },
  };
}
