// The MCP surface the user actually looks at: the TUI's /mcps dialog. It is driven against an isolated
// agent dir that declares one real MCP server, so the bridge has something truthful to project:
// GET /api/mcp must list it, and the dialog must paint its name. Both sides are read in one run,
// because a correct endpoint with an empty dialog (or the reverse) is exactly the defect this covers.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER_NAME = "context7";
const SERVER_URL = "https://mcp.context7.com/mcp";
const DIALOG_TITLE = "MCP servers";
// Copying these keeps the isolated agent dir able to boot a session and paint the home screen; the
// harness's other scenarios inherit the real agent dir, which this one deliberately replaces.
const CARRY_OVER = ["auth.json", "models.json", "models-store.json", "settings.json"];

function seedAgentDir() {
  const agentDir = mkdtempSync(join(tmpdir(), "qa-mcp-agent-"));
  const source = join(process.env.HOME ?? "", ".omo", "agent");
  mkdirSync(agentDir, { recursive: true });
  for (const name of CARRY_OVER) {
    const from = join(source, name);
    if (existsSync(from)) copyFileSync(from, join(agentDir, name));
  }
  writeFileSync(
    join(agentDir, "mcp.json"),
    `${JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: "http", url: SERVER_URL } } }, null, 2)}\n`,
  );
  return agentDir;
}

function frameLines(frame) {
  return frame
    .split("\n")
    .map((line) => line.replace(/[│┃|]/gu, " ").trim())
    .filter((line) => line.length > 0);
}

async function readMcp(bridge, repo) {
  const query = new URLSearchParams({ "location[directory]": repo });
  const response = await fetch(`${bridge.url}/api/mcp?${query}`, { headers: bridge.headers });
  const body = await response.json().catch(() => undefined);
  const rows = Array.isArray(body?.data) ? body.data : [];
  return { status: response.status, rows };
}

export default {
  name: "mcp-list",
  async run(ctx) {
    const started = Date.now();
    const agentDir = seedAgentDir();
    const bridge = await ctx.startBridge({ agentDir, evidenceDir: ctx.evidenceDir });
    let tui;
    try {
      const http = await readMcp(bridge, ctx.repo);
      const httpRow = http.rows.find((row) => row.name === SERVER_NAME);
      const httpStatus = typeof httpRow?.status?.status === "string" ? httpRow.status.status : null;

      tui = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36 });
      const ready = await tui.waitFor(
        (text) => text.includes("OmO ·") || text.includes("ctrl+p commands") || text.includes("Search sessions"),
        60_000,
      );
      // The home screen syncs its location resources asynchronously; opening the dialog before that
      // settles reads an empty list and paints the empty state.
      await Bun.sleep(Number(process.env.QA_MCP_SETTLE_MS ?? 10_000));
      await tui.write("/mcps");
      await Bun.sleep(500);
      await tui.press("Enter");
      const opened = await tui.waitFor((text) => text.includes(DIALOG_TITLE), 15_000, 250);
      await Bun.sleep(800);
      const frame = await tui.text();
      const lines = frameLines(frame);
      const serverVisible = lines.some((line) => line.includes(SERVER_NAME));
      const emptyView = /No MCP servers|No items available|No results found/iu.test(frame);

      const framePath = await ctx.writeFile("frame-mcp.txt", frame);
      await ctx.writeFile("transcript.txt", await tui.transcript());
      const screenshot = await tui.screenshot(`${ctx.evidenceDir}/frame.png`);

      const checks = {
        // The bridge side is the invariant: a configured server must be listed with a status.
        httpListed: http.status === 200 && httpRow !== undefined && httpStatus !== null,
        dialogOpened: opened,
        dialogShowsServer: serverVisible,
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
      const report = {
        scenario: "mcp-list",
        outcome:
          failed.length === 0
            ? "listed"
            : !checks.dialogOpened
              ? "no-dialog"
              : checks.httpListed
                ? "bridge-only"
                : "empty",
        checks,
        failed,
        http: { status: http.status, rows: http.rows.map((row) => ({ name: row.name, status: row.status })) },
        ui: { emptyView, serverVisible, dialogOpened: opened, ready },
        agentDir,
        serverName: SERVER_NAME,
        evidence: { frame: framePath, screenshot },
        durations: { totalMs: Date.now() - started },
        exitCode: failed.length === 0 ? 0 : 1,
      };
      await ctx.writeFile("report.json", JSON.stringify(report, null, 2));
      return { exitCode: report.exitCode, report };
    } finally {
      try {
        await tui?.stop();
      } catch {
        // A TUI that never started has nothing to stop.
      }
      await bridge.stop();
      rmSync(agentDir, { recursive: true, force: true });
    }
  },
};
