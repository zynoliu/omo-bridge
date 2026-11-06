// Session auto-title QA: one real turn must rename the session from its directory name to a
// generated title, and the TUI must paint the new title without reopening the session.
//
// The title is generated as part of the run's settle, after agent_end, so the assertion polls the
// session list for a bounded window instead of sampling the pane once.
const PROMPT = "你好，请用一句话介绍你自己";
const FOOTER = /\S+ · .+ · \d+(?:\.\d+)?s/u;

function recordEvents(bridge) {
  const controller = new AbortController();
  const events = [];
  const reading = (async () => {
    try {
      const response = await fetch(`${bridge.url}/api/event`, { headers: bridge.headers, signal: controller.signal });
      if (!response.ok || response.body === null) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let boundary = buffered.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (typeof event?.type === "string") events.push({ at: Date.now(), type: event.type, data: event.data });
            } catch {
              // A truncated frame is not an event.
            }
          }
          boundary = buffered.indexOf("\n\n");
        }
      }
    } catch {
      // Stopping the bridge closes the stream.
    }
  })();
  return { events, reading, stop: () => controller.abort() };
}

async function sessionTitle(bridge, sessionID) {
  const response = await fetch(`${bridge.url}/api/session?limit=20`, { headers: bridge.headers });
  const body = await response.json();
  const rows = Array.isArray(body?.data) ? body.data : [];
  const row = rows.find((entry) => entry.id === sessionID);
  return row?.title ?? null;
}

export default {
  name: "session-title",
  async run(ctx) {
    const started = Date.now();
    const evidence = ctx.evidenceDir;
    const bridge = await ctx.startBridge({ evidenceDir: evidence });
    const recorder = recordEvents(bridge);
    let tui;
    const checks = { ready: false, submitted: false, renamed: false, event: false, painted: false };
    let sessionID;
    let before = null;
    let after = null;
    try {
      tui = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36 });
      checks.ready = await tui.waitFor(
        (text) => text.includes("OmO ·") || text.includes("ctrl+p commands") || text.includes("Search sessions"),
        60_000,
      );

      try {
        const listed = await fetch(`${bridge.url}/api/session?limit=1`, { headers: bridge.headers }).then((r) => r.json());
        sessionID = listed?.data?.[0]?.id;
        const models = await fetch(`${bridge.url}/api/model`, { headers: bridge.headers }).then((r) => r.json());
        const rows = models?.data ?? [];
        const pick =
          rows.find((row) => row.id === "deepseek-v4.1-flash") ??
          rows.find((row) => String(row.id).includes("deepseek")) ??
          rows[0];
        if (sessionID !== undefined && pick !== undefined) {
          await fetch(`${bridge.url}/api/session/${encodeURIComponent(sessionID)}/model`, {
            method: "POST",
            headers: { ...bridge.headers, "content-type": "application/json" },
            body: JSON.stringify({ model: { providerID: pick.providerID ?? pick.provider, id: pick.id } }),
          });
          await Bun.sleep(800);
        }
      } catch {
        // Keep going: the default model decides whether the turn can answer.
      }

      if (sessionID === undefined) {
        const listed = await fetch(`${bridge.url}/api/session?limit=1`, { headers: bridge.headers }).then((r) => r.json());
        sessionID = listed?.data?.[0]?.id;
      }
      before = sessionID === undefined ? null : await sessionTitle(bridge, sessionID);
      const frameBefore = await tui.text();
      await ctx.writeFile("frame-before.txt", frameBefore);

      await tui.write(PROMPT);
      await Bun.sleep(800);
      await tui.press("Enter");

      const submitDeadline = Date.now() + 20_000;
      while (Date.now() < submitDeadline) {
        if ((await tui.text()).includes("一句话介绍")) {
          checks.submitted = true;
          break;
        }
        await Bun.sleep(300);
      }

      // The title follows the run's settle, so wait for the execution to end and then poll.
      const settleDeadline = Date.now() + 150_000;
      while (Date.now() < settleDeadline) {
        const settled = recorder.events.some(
          (event) => event.type === "session.execution.succeeded" || event.type === "session.execution.failed",
        );
        if (settled) break;
        await Bun.sleep(300);
      }

      const titleDeadline = Date.now() + 90_000;
      while (Date.now() < titleDeadline) {
        after = sessionID === undefined ? null : await sessionTitle(bridge, sessionID);
        if (after !== null && after !== before) break;
        await Bun.sleep(1000);
      }

      const frameAfter = await tui.text();
      await ctx.writeFile("frame-after.txt", frameAfter);
      await ctx.writeFile("transcript.txt", await tui.transcript());

      recorder.stop();
      await recorder.reading;
      await ctx.writeFile("events.jsonl", recorder.events.map((event) => JSON.stringify(event)).join("\n"));

      const renamedEvents = recorder.events.filter((event) => event.type === "session.renamed");
      checks.renamed = before !== null && after !== null && after !== before;
      checks.event =
        renamedEvents.length > 0 &&
        renamedEvents.some((event) => String(event.data?.title ?? "") === String(after ?? ""));
      // The pane must show the new title without a reopen: the sidebar lists it by name.
      checks.painted = after !== null && frameAfter.includes(String(after));

      let screenshot = { written: false, reason: "not attempted" };
      try {
        screenshot = await tui.screenshot(`${evidence}/frame.png`);
      } catch (error) {
        screenshot = { written: false, reason: String(error).slice(0, 160) };
      }

      const report = {
        scenario: "session-title",
        checks,
        sessionID,
        title: { before, after },
        renamedEvents: renamedEvents.map((event) => ({ at: event.at, sessionID: event.data?.sessionID, title: event.data?.title })),
        footerSeen: FOOTER.test(frameAfter),
        durations: { totalMs: Date.now() - started },
        exitCode: checks.ready && checks.submitted && checks.renamed && checks.event && checks.painted ? 0 : 1,
        screenshot: screenshot.written ? screenshot.path : `none (${screenshot.reason})`,
        evidence: { bridgeLog: bridge.logPath, stateDir: bridge.stateDir },
        bridge: { url: bridge.url, port: bridge.port },
      };
      await ctx.writeFile("report.json", JSON.stringify(report, null, 2));
      return { exitCode: report.exitCode, report };
    } finally {
      recorder.stop();
      await tui?.stop();
      await bridge.stop();
    }
  },
};
