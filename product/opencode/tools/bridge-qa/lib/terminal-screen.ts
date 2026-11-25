import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * Renders a captured PTY byte stream through the harness's own @xterm/xterm build and returns the
 * screen text, so a case can assert what a terminal shows after incremental updates instead of
 * searching the raw stream, which still contains text the screen has since overwritten.
 */
export async function screenText(input: {
  readonly qaRoot: string;
  readonly out: string;
  readonly bytes: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  /** When set, the rendered screen is also captured to this PNG path. */
  readonly png?: string;
}): Promise<string> {
  const packageRoot = path.join(input.qaRoot, "node_modules", "@xterm", "xterm");
  const script = path.join(packageRoot, "lib", "xterm.js");
  const css = path.join(packageRoot, "css", "xterm.css");
  if (!existsSync(script)) throw new Error("@xterm/xterm browser bundle is missing: " + script);
  const page = pageFor(readFileSync(css, "utf8"), readFileSync(script, "utf8"), input.cols, input.rows);
  const pagePath = path.join(input.out, "terminal-screen.html");
  writeFileSync(pagePath, page, { mode: 0o600 });
  const view = new Bun.WebView({ width: input.cols * 9, height: input.rows * 18 });
  try {
    await view.navigate("file://" + pagePath);
    await view.evaluate(`window.renderBytes("${Buffer.from(input.bytes).toString("hex")}")`);
    const text = String(await view.evaluate("window.screenText()"));
    if (input.png !== undefined) await Bun.write(input.png, await view.screenshot());
    return text;
  } finally {
    await view.close();
    rmSync(pagePath, { force: true });
  }
}

function pageFor(css: string, library: string, cols: number, rows: number): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>bridge terminal screen</title>
<style>${css}
html,body{margin:0;background:#000;}
</style></head>
<body><div id="host"></div>
<script>${library}</script>
<script>
const term = new Terminal({ cols: ${cols}, rows: ${rows}, allowProposedApi: true });
term.open(document.getElementById("host"));
window.renderBytes = (hex) => new Promise((resolve) => {
  const bytes = new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16)));
  term.reset();
  term.write(bytes, () => resolve(true));
});
window.screenText = () => {
  const buffer = term.buffer.active;
  const lines = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    lines.push(line ? line.translateToString(true) : "");
  }
  return lines.join("\\n");
};
</script></body></html>`;
}
