const PANE_COLUMN = 44;
const CHROME =
  /(ctrl\+p|esc to interrupt|shift\+tab|⊙|▀|█|Plugin failed|Run \/plugins|Switched mod|Search sessions|\+ New|\/\p{Script=Han}+ loader)/u;
const ASSISTANT_FOOTER = /Build · .+ · \d+(?:\.\d+)?s/u;
const ERROR_PATTERN = /(Session failed|unexpected error|Failed to|session not found|Connect an integration)/iu;
const USER_ECHO = /^你好$/u;

function paneLines(frame) {
  return frame
    .split("\n")
    .filter((line) => !CHROME.test(line))
    .map((line) => line.slice(PANE_COLUMN).replace(/[┃|]/g, " ").trim())
    .filter((line) => line.length > 0);
}

function addedLines(before, after) {
  const known = new Set(paneLines(before));
  return paneLines(after).filter((line) => !known.has(line));
}

export function classify(before, after) {
  const added = addedLines(before, after);
  const error = added.find((line) => ERROR_PATTERN.test(line));
  if (error !== undefined) return { outcome: "error", line: error };
  const footer = added.find((line) => ASSISTANT_FOOTER.test(line));
  if (footer !== undefined) return { outcome: "reply", line: footer };
  const text = added.find(
    (line) =>
      !USER_ECHO.test(line) &&
      !/^[✓✗●◆◦›»+]/u.test(line) &&
      (line.match(/[\p{L}\p{Script=Han}]/gu) ?? []).length >= 2,
  );
  if (text !== undefined) return { outcome: "reply", line: text };
  return { outcome: "idle", line: "" };
}

export default {
  name: "send-message",
  async run(ctx) {
    const started = Date.now();
    const evidence = ctx.evidenceDir;
    const bridge = await ctx.startBridge({ evidenceDir: evidence });
    const checks = { reply: false, error: false, idle: false };
    let outcome = "idle";
    let matched = "";
    let tui;
    try {
      tui = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36 });
      const ready = await tui.waitFor(
        (text) => text.includes("Build ·") || text.includes("ctrl+p commands") || text.includes("Search sessions"),
        60_000,
      );
      let opened = false;
      if (process.env.QA_OPEN_SESSION !== "0" && (await tui.text()).includes("Search sessions")) {
        await tui.press("Enter");
        opened = await tui.waitFor((text) => text.includes("Build ·") || text.includes("ctrl+p commands"), 20_000);
      }
      const beforeText = await tui.text();
      const frameBefore = await ctx.writeFile("frame-before.txt", beforeText);

      await tui.write("你好");
      await Bun.sleep(800);
      await tui.press("Enter");
      const sentAt = Date.now();

      let frameAfter = await tui.text();
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        frameAfter = await tui.text();
        const verdict = classify(beforeText, frameAfter);
        if (verdict.outcome !== "idle") {
          outcome = verdict.outcome;
          matched = verdict.line;
          break;
        }
        await Bun.sleep(500);
      }
      checks.reply = outcome === "reply";
      checks.error = outcome === "error";
      checks.idle = outcome === "idle";

      const afterPath = await ctx.writeFile("frame-after.txt", frameAfter);
      await ctx.writeFile("transcript.txt", await tui.transcript());

      let screenshot = { written: false, reason: "not attempted" };
      try {
        screenshot = await tui.screenshot(`${evidence}/frame.png`);
      } catch (error) {
        screenshot = { written: false, reason: String(error).slice(0, 160) };
      }

      const report = {
        scenario: "send-message",
        outcome,
        matched,
        checks,
        ready,
        opened,
        openRequested: process.env.QA_OPEN_SESSION !== "0",
        durations: { totalMs: Date.now() - started, replyWaitMs: Date.now() - sentAt },
        exitCode: outcome === "reply" && !checks.error ? 0 : 1,
        renderMode: screenshot.written ? "webview" : "text",
        screenshot: screenshot.written ? screenshot.path : `none (${screenshot.reason})`,
        evidence: {
          before: frameBefore.path,
          after: afterPath.path,
          bridgeLog: bridge.logPath,
          stateDir: bridge.stateDir,
        },
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
