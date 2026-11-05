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

function paneHasUserMessage(frame, text) {
  const lines = frame.split("\n");
  const index = lines.findIndex((line) => line.includes("┃") && line.includes(text));
  if (index < 0) return false;
  // The composer sits at the bottom; a submitted message renders above it inside the pane.
  const composer = lines.findIndex((line) => line.includes("╹"));
  return composer < 0 || index < composer;
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
      tui = await ctx.startTui({
        stateDir: bridge.stateDir,
        cols: 120,
        rows: 36,
        ...(ctx.fault === "bogus-session" ? { sessionID: `ses_qa_missing_${Date.now().toString(36)}` } : {}),
      });
      const ready = await tui.waitFor(
        (text) => text.includes("Build ·") || text.includes("ctrl+p commands") || text.includes("Search sessions"),
        60_000,
      );
      // The launcher opens a session before starting the app, so the composer is already live: this
      // mirrors the user's literal flow (launch, type, Enter) with no extra keystroke.
      const opened = (await tui.text()).includes("┃");
      if (process.env.QA_OPEN_SESSION === "0") {
        opened;
      }
      const beforeText = await tui.text();
      const frameBefore = await ctx.writeFile("frame-before.txt", beforeText);

      if (ctx.fault === "bridge-down") {
        await bridge.stop();
        await Bun.sleep(500);
      }
      if (ctx.fault === "host-down") {
        const hosts = Bun.spawn(["pgrep", "-f", `${bridge.stateDir}/senpi.sock`], { stdout: "pipe" });
        const pids = (await new Response(hosts.stdout).text()).split("\n").map((v) => Number.parseInt(v, 10));
        for (const pid of pids) {
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // Already gone.
            }
          }
        }
        await Bun.sleep(1000);
      }
      if (ctx.fault === "bogus-session") {
        await Bun.sleep(1500);
      }

      await tui.write("你好");
      await Bun.sleep(800);
      await tui.press("Enter");
      const sentAt = Date.now();

      let submitted = false;
      const submitDeadline = Date.now() + 15_000;
      while (Date.now() < submitDeadline) {
        if (paneHasUserMessage(await tui.text(), "你好")) {
          submitted = true;
          break;
        }
        await Bun.sleep(500);
      }
      if (!submitted && process.env.QA_OPEN_SESSION !== "0") {
        await tui.press("Enter");
        const retryDeadline = Date.now() + 10_000;
        while (Date.now() < retryDeadline) {
          if (paneHasUserMessage(await tui.text(), "你好")) {
            submitted = true;
            break;
          }
          await Bun.sleep(500);
        }
      }

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

      let sessionID;
      let history = { total: 0, assistant: 0, lastText: "" };
      try {
        const sessions = await fetch(`${bridge.url}/api/session?limit=1`, { headers: bridge.headers }).then((r) => r.json());
        sessionID = sessions?.data?.[0]?.id;
        if (sessionID !== undefined) {
          const messages = await ctx.listMessages({ url: bridge.url, headers: bridge.headers, sessionID });
          const assistant = messages.filter((message) => message.type === "assistant");
          history = {
            total: messages.length,
            assistant: assistant.length,
            lastText: String(assistant[0]?.text ?? "").slice(0, 200),
          };
        }
      } catch (error) {
        history = { total: 0, assistant: 0, lastText: `unavailable: ${String(error).slice(0, 80)}` };
      }

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
        submitted,
        openRequested: process.env.QA_OPEN_SESSION !== "0",
        fault: ctx.fault ?? null,
        sessionID,
        history,
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
