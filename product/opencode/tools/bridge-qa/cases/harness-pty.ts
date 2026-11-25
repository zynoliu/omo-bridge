import * as fs from "node:fs";
import * as path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";

const ESC = "\u001b";
const EXPECTED_SEQUENCE = ESC + "[31m中" + ESC + "[0m";
const ENTER = "\r";
const PTY_TIMEOUT_MS = 10_000;
const RENDER_TIMEOUT_MS = 20_000;

function hexOf(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

function locateXterm(qaRoot: string): { readonly script: string; readonly css: string } {
  const packageRoot = path.join(qaRoot, "node_modules", "@xterm", "xterm");
  const script = path.join(packageRoot, "lib", "xterm.js");
  const css = path.join(packageRoot, "css", "xterm.css");
  if (!fs.existsSync(script)) throw new Error("@xterm/xterm browser bundle is missing: " + script);
  if (!fs.existsSync(css)) throw new Error("@xterm/xterm stylesheet is missing: " + css);
  return { script: script, css: css };
}

const PAGE_TEMPLATE = (css: string, library: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge harness pty</title>
<style>${css}
html,body{margin:0;background:#000;}
</style></head>
<body><div id="host"></div>
<script>${library}</script>
<script>
const term = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
term.open(document.getElementById("host"));
window.renderBytes = (hex) => new Promise((resolve) => {
  const bytes = new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16)));
  term.reset();
  term.write(bytes, () => resolve(true));
});
window.scanCells = () => {
  const matches = [];
  const buffer = term.buffer.active;
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    for (let column = 0; column < line.length; column += 1) {
      const cell = line.getCell(column);
      if (!cell) continue;
      const chars = cell.getChars();
      if (chars.includes("中")) {
        matches.push({ row: row, column: column, width: cell.getWidth(), fg: cell.getFgColor(), palette: cell.isFgPalette() });
      }
    }
  }
  return { matches: matches, cols: term.cols, rows: term.rows };
};
</script></body></html>`;

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const artifacts: string[] = [];

  let received = "";
  let seenResolve: ((value: boolean) => void) | undefined;
  const seen = new Promise<boolean>((resolve) => {
    seenResolve = resolve;
  });

  const proc = Bun.spawn({
    cmd: ["/bin/sh", "-c", "IFS= read -r _ || exit 3; printf '\\033[31m中\\033[0m\\n'"],
    terminal: {
      cols: 80,
      rows: 24,
      data(_terminal, chunk) {
        received += new TextDecoder().decode(chunk);
        if (received.includes(EXPECTED_SEQUENCE)) seenResolve?.(true);
      },
    },
    env: { ...process.env, TERM: "xterm-256color" },
  });

  let view: Bun.WebView | undefined;
  const cleanupDetail: string[] = [];

  try {
    proc.terminal.write(ENTER);

    const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PTY_TIMEOUT_MS));
    const observed = await Promise.race([seen, timer]);
    checks.push({
      name: "pty-executes-after-enter",
      expected: "the PTY emits ESC[31m中ESC[0m only after the agent sends Enter",
      observed: observed ? "sequence observed" : JSON.stringify(received.slice(-120)),
      pass: observed,
    });

    fs.writeFileSync(path.join(context.out, "pty-capture.txt"), received, { mode: 0o600 });
    artifacts.push("pty-capture.txt");

    const { script, css } = locateXterm(context.qaRoot);
    const page = PAGE_TEMPLATE(fs.readFileSync(css, "utf8"), fs.readFileSync(script, "utf8"));
    const pagePath = path.join(context.out, "harness.html");
    fs.writeFileSync(pagePath, page, { mode: 0o600 });
    artifacts.push("harness.html");

    view = new Bun.WebView({ width: 800, height: 320 });
    await view.navigate("file://" + pagePath);
    await view.evaluate("window.renderBytes(\"" + hexOf(received) + "\")");

    const scan = (await view.evaluate("JSON.stringify(window.scanCells())")) as string;
    const cells = JSON.parse(scan) as { matches: { row: number; column: number; width: number; fg: number; palette: boolean }[] };
    const redCells = cells.matches.filter((cell) => cell.palette && cell.fg === 1);
    const widest = cells.matches.map((cell) => cell.width).sort((a, b) => b - a)[0] ?? 0;

    checks.push({
      name: "xterm-renders-cjk-wide",
      expected: "a 中 cell occupies two columns",
      observed: "max width " + String(widest) + " across " + String(cells.matches.length) + " match(es)",
      pass: widest === 2,
    });
    checks.push({
      name: "xterm-renders-red-foreground",
      expected: "at least one 中 cell carries palette colour 1 (red)",
      observed: String(redCells.length) + " red cell(s)",
      pass: redCells.length > 0,
    });

    const shot = await view.screenshot();
    const pngPath = path.join(context.out, "terminal.png");
    await Bun.write(pngPath, shot);
    artifacts.push("terminal.png");
    const pngBytes = fs.statSync(pngPath).size;
    checks.push({
      name: "screenshot-captured",
      expected: "a non-empty PNG under the evidence directory",
      observed: String(pngBytes) + " bytes",
      pass: pngBytes > 1024,
    });
  } finally {
    try {
      proc.kill();
    } catch {
      detail.push("pty kill raised");
    }
    const ptyGone = await Promise.race([
      proc.exited.then(() => true).catch(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    cleanupDetail.push(ptyGone ? "pty child exited" : "pty child did not exit within 5s");
    if (view) {
      await view.close();
      cleanupDetail.push("webview closed");
    }
    cleanupDetail.push(...detail);
  }

  const cleanupOk = cleanupDetail.every((entry) => !entry.includes("did not exit") && !entry.includes("raised"));
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts };
}
