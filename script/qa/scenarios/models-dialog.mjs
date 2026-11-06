// The user's first-minute check: open /models on the home screen and see whether the dialog lists
// anything. The bridge can answer /api/model correctly and the dialog still render "No results found",
// so this scenario reads both sides in one run: the catalog the bridge serves, and the frame the TUI
// paints after the slash command.

const DIALOG_TITLE = "Select model";
// Under the `new-designs` experiment the dialog gives its header row to the search input
// (`dialog-select.tsx:688,715`), so the connected picker paints this placeholder instead of its
// title (`dialog-model.tsx:208,215`). Only one of the two is ever on screen.
const CONNECTED_DIALOG_TITLE = "Search models";
const FREE_DIALOG_TITLE = "Free models";
const EMPTY_VIEW = /No (results found|items available)/iu;

function frameLines(frame) {
  return frame
    .split("\n")
    .map((line) => line.replace(/[│┃|]/gu, " ").trim())
    .filter((line) => line.length > 0);
}

function visibleModels(frame, names) {
  const lines = frameLines(frame);
  return names.filter((name) => lines.some((line) => line.includes(name)));
}

async function catalog(bridge, repo) {
  const query = new URLSearchParams({ "location[directory]": repo });
  const read = async (path) => {
    const response = await fetch(`${bridge.url}${path}`, { headers: bridge.headers });
    const body = await response.json().catch(() => undefined);
    return { status: response.status, body };
  };
  const models = await read(`/api/model?${query}`);
  const providers = await read(`/api/provider?${query}`);
  const integrations = await read(`/api/integration?${query}`);
  return {
    modelStatus: models.status,
    models: Array.isArray(models.body?.data) ? models.body.data : [],
    providerStatus: providers.status,
    providers: Array.isArray(providers.body?.data) ? providers.body.data : [],
    integrationStatus: integrations.status,
    integrations: Array.isArray(integrations.body?.data) ? integrations.body.data : [],
  };
}

export default {
  name: "models-dialog",
  async run(ctx) {
    const started = Date.now();
    const evidence = ctx.evidenceDir;
    const bridge = await ctx.startBridge({ evidenceDir: evidence });
    let tui;
    try {
      const before = await catalog(bridge, ctx.repo);
      const names = before.models.map((model) => model.name).filter((name) => typeof name === "string" && name.length > 0);

      tui = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36 });
      const ready = await tui.waitFor(
        (text) => text.includes("OmO ·") || text.includes("ctrl+p commands") || text.includes("Search sessions"),
        60_000,
      );
      const frameBefore = await ctx.writeFile("frame-before.txt", await tui.text());

      // The home screen syncs its location resources asynchronously; opening the dialog before the
      // first sync settles reads an empty integration list and paints the free-models branch.
      await Bun.sleep(Number(process.env.QA_MODELS_SETTLE_MS ?? 10_000));
      await tui.write("/models");
      await Bun.sleep(500);
      const typed = await tui.text();
      await tui.press("Enter");

      const opened = await tui.waitFor(
        (text) =>
          text.includes(DIALOG_TITLE) || text.includes(CONNECTED_DIALOG_TITLE) || text.includes(FREE_DIALOG_TITLE),
        15_000,
        250,
      );
      await Bun.sleep(700);
      const frameAfter = await tui.text();
      const visible = visibleModels(frameAfter, names);
      const emptyView = EMPTY_VIEW.test(frameAfter);
      const dialogTitle = frameAfter.includes(FREE_DIALOG_TITLE)
        ? FREE_DIALOG_TITLE
        : frameAfter.includes(CONNECTED_DIALOG_TITLE)
          ? CONNECTED_DIALOG_TITLE
          : frameAfter.includes(DIALOG_TITLE)
            ? DIALOG_TITLE
            : null;
      const outcome = !opened ? "no-dialog" : dialogTitle === FREE_DIALOG_TITLE ? (emptyView ? "free-empty" : "free") : visible.length > 0 ? "models" : emptyView ? "empty" : "unpopulated";

      const afterPath = await ctx.writeFile("frame-after.txt", frameAfter);
      await ctx.writeFile("frame-typed.txt", typed);

      // The user's other first-minute check: /connect must list the provider the bridge reports.
      await tui.press("Escape");
      await Bun.sleep(600);
      await tui.write("/connect");
      await Bun.sleep(400);
      await tui.press("Enter");
      const connectOpened = await tui.waitFor((text) => text.includes("Connect an integration"), 15_000, 250);
      await Bun.sleep(700);
      const connectFrame = await tui.text();
      const connectNames = before.integrations.map((row) => row.name ?? row.id).filter((name) => typeof name === "string");
      const connect = {
        opened: connectOpened,
        emptyView: /No integrations (available|found)/u.test(connectFrame),
        visible: connectNames.filter((name) => connectFrame.includes(name)),
      };
      const connectPath = await ctx.writeFile("frame-connect.txt", connectFrame);
      await ctx.writeFile("transcript.txt", await tui.transcript());
      const screenshot = await tui.screenshot(`${evidence}/frame.png`).catch((error) => ({
        written: false,
        reason: String(error).slice(0, 160),
      }));

      const report = {
        scenario: "models-dialog",
        outcome,
        ready,
        dialogOpened: opened,
        dialogTitle,
        emptyView,
        connect,
        catalog: {
          modelStatus: before.modelStatus,
          models: before.models.length,
          providerStatus: before.providerStatus,
          providers: before.providers.length,
          integrationStatus: before.integrationStatus,
          integrations: before.integrations.length,
        },
        modelNames: names.slice(0, 10),
        visibleModels: visible.slice(0, 10),
        exitCode: outcome === "models" ? 0 : 1,
        durations: { totalMs: Date.now() - started },
        renderMode: screenshot.written ? "webview" : "text",
        screenshot: screenshot.written ? screenshot.path : `none (${screenshot.reason})`,
        evidence: { before: frameBefore.path, after: afterPath.path, connect: connectPath.path, bridgeLog: bridge.logPath, stateDir: bridge.stateDir },
        bridge: { url: bridge.url, port: bridge.port },
      };
      await ctx.writeFile("report.json", JSON.stringify(report, null, 2));
      return { exitCode: report.exitCode, report };
    } finally {
      await tui?.stop();
      await bridge.stop();
    }
  },
};
