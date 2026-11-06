// Live-streaming QA: proves the TUI paints assistant text progressively (before the turn's footer),
// that every live row is re-keyed to its durable id, and that the reply survives as history rows.
//
// The prompt asks for a repeated marker so the pane can be measured without parsing layout: the
// marker count can only grow when assistant text arrives, and tool cards cannot fake it. The user's
// own bubble contributes exactly one occurrence, so growth is measured above that baseline.
const MARKER = "流式测试";
const PROMPT = `请原样重复输出下面这四个字 200 遍，不要调用任何工具，不要解释，直接输出：${MARKER}`;
const PROMPT_PROBE = "200 遍";
const FOOTER = /Build · .+ · \d+(?:\.\d+)?s/u;

function markerCount(frame) {
  return frame.split(MARKER).length - 1;
}

function paneHasUserMessage(frame, text) {
  const lines = frame.split("\n");
  const index = lines.findIndex((line) => line.includes("┃") && line.includes(text));
  if (index < 0) return false;
  const composer = lines.findIndex((line) => line.includes("╹"));
  return composer < 0 || index < composer;
}

function addedLines(before, after) {
  const known = new Set(before.split("\n"));
  return after.split("\n").filter((line) => !known.has(line));
}

function assistantText(messages) {
  return messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === "text").map((part) => String(part.text ?? ""))
        : [],
    )
    .join("");
}

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

export default {
  name: "stream-progressive",
  async run(ctx) {
    const started = Date.now();
    const evidence = ctx.evidenceDir;
    const bridge = await ctx.startBridge({ evidenceDir: evidence });
    const recorder = recordEvents(bridge);
    let tui;
    const checks = { ready: false, submitted: false, progressive: false, rekey: false, ids: false, textOnce: false };
    let sessionID;
    let samples = [];
    let growth = [];
    let history = { assistant: 0, ids: [], text: "" };
    let streamed = { ids: [], deltas: 0, firstDeltaAt: null, firstDurableAt: null };
    try {
      tui = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36 });
      checks.ready = await tui.waitFor(
        (text) => text.includes("Build ·") || text.includes("ctrl+p commands") || text.includes("Search sessions"),
        60_000,
      );

      // Pick an accessible model the way a user would, but through the API so the run does not
      // depend on the /models dialog: the TUI's default pick can 403 on this account.
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
        // The default model stays; the run then reports whatever the host answers.
      }

      const frameBefore = await tui.text();
      await ctx.writeFile("frame-before.txt", frameBefore);

      await tui.write(PROMPT);
      await Bun.sleep(800);
      await tui.press("Enter");

      const submitDeadline = Date.now() + 20_000;
      while (Date.now() < submitDeadline) {
        if (paneHasUserMessage(await tui.text(), PROMPT_PROBE)) {
          checks.submitted = true;
          break;
        }
        await Bun.sleep(300);
      }
      if (!checks.submitted) {
        await tui.press("Enter");
        const retry = Date.now() + 10_000;
        while (Date.now() < retry) {
          if (paneHasUserMessage(await tui.text(), PROMPT_PROBE)) {
            checks.submitted = true;
            break;
          }
          await Bun.sleep(300);
        }
      }

      // Sample the pane until the TURN ends (the execution settles), not until a footer line appears:
      // a multi-step turn paints a footer at every step, so a footer is not the end of the reply.
      const deadline = Date.now() + 180_000;
      const frameSubmitted = await tui.text();
      const baseline = markerCount(frameSubmitted);
      let turnFooter = false;
      while (Date.now() < deadline) {
        const frame = await tui.text();
        turnFooter = addedLines(frameBefore, frame).some((line) => FOOTER.test(line));
        samples.push({ at: Date.now() - started, count: markerCount(frame), footer: turnFooter });
        const settled = recorder.events.some(
          (event) => event.type === "session.execution.succeeded" || event.type === "session.execution.failed",
        );
        if (settled) break;
        await Bun.sleep(200);
      }
      await Bun.sleep(600);
      samples.push({ at: Date.now() - started, count: markerCount(await tui.text()), footer: true });
      await ctx.writeFile("samples.jsonl", samples.map((sample) => JSON.stringify(sample)).join("\n"));
      const frameAfter = await tui.text();
      await ctx.writeFile("frame-after.txt", frameAfter);
      await ctx.writeFile("transcript.txt", await tui.transcript());

      // Progressive means the painted marker count strictly grew above the submitted frame (which
      // already holds the user's own bubble) before the turn's footer appeared.
      let last = baseline;
      for (const sample of samples.slice(0, -1)) {
        if (sample.count > last) {
          growth.push({ at: sample.at, count: sample.count });
          last = sample.count;
        }
      }
      checks.progressive = growth.length >= 1 && last > baseline;

      recorder.stop();
      await recorder.reading;
      await ctx.writeFile("events.jsonl", recorder.events.map((event) => JSON.stringify(event)).join("\n"));

      const startedEvents = recorder.events.filter((event) => event.type === "session.step.started");
      const rekeys = startedEvents.filter((event) => typeof event.data?.replaces === "string");
      const textDeltas = recorder.events.filter((event) => event.type === "session.text.delta");
      const contentIDs = [
        ...new Set(
          recorder.events
            .filter((event) => event.type.startsWith("session.text.") || event.type.startsWith("session.reasoning."))
            .map((event) => event.data?.assistantMessageID),
        ),
      ];

      if (sessionID === undefined) {
        const listed = await fetch(`${bridge.url}/api/session?limit=1`, { headers: bridge.headers }).then((r) => r.json());
        sessionID = listed?.data?.[0]?.id;
      }
      if (sessionID !== undefined) {
        const messages = await ctx.listMessages({ url: bridge.url, headers: bridge.headers, sessionID });
        const assistant = messages.filter((message) => message.type === "assistant");
        history = {
          assistant: assistant.length,
          ids: assistant.map((message) => message.id),
          text: assistantText(messages),
        };
      }

      const firstDelta = textDeltas[0];
      const firstDurable = startedEvents.find((event) => history.ids.includes(event.data?.assistantMessageID));
      streamed = {
        ids: contentIDs,
        deltas: textDeltas.length,
        firstDeltaAt: firstDelta?.at ?? null,
        firstDurableAt: firstDurable?.at ?? null,
      };

      const liveIDs = new Set(rekeys.map((event) => event.data.replaces));
      // Per step: every content delta of a step must precede that step's durable re-key.
      const perStep = rekeys.map((rekey) => {
        const live = rekey.data.replaces;
        const firstContent = recorder.events.find(
          (event) =>
            (event.type.startsWith("session.text.") || event.type.startsWith("session.reasoning.")) &&
            event.data?.assistantMessageID === live,
        );
        return {
          live,
          durable: rekey.data.assistantMessageID,
          firstContentAt: firstContent?.at ?? null,
          durableAt: rekey.at,
          streamedBefore: firstContent !== undefined && firstContent.at < rekey.at,
          deltas: textDeltas.filter((event) => event.data?.assistantMessageID === live).length,
        };
      });
      const contentSteps = perStep.filter((step) => step.firstContentAt !== null);
      const deltasBeforeDurable = contentSteps.length > 0 && contentSteps.every((step) => step.streamedBefore);
      checks.rekey =
        rekeys.length > 0 &&
        rekeys.length === history.assistant &&
        rekeys.every((event) => history.ids.includes(event.data.assistantMessageID));
      checks.ids = contentIDs.every((id) => history.ids.includes(id) || liveIDs.has(id));
      // What the pane painted must not exceed what history serves plus the user's own bubble: a
      // duplicated reply would show every marker twice.
      const frameMarkers = markerCount(frameAfter);
      const historyMarkers = markerCount(history.text);
      checks.textOnce = historyMarkers > 0 && frameMarkers <= historyMarkers + 1;

      let screenshot = { written: false, reason: "not attempted" };
      try {
        screenshot = await tui.screenshot(`${evidence}/frame.png`);
      } catch (error) {
        screenshot = { written: false, reason: String(error).slice(0, 160) };
      }

      const report = {
        scenario: "stream-progressive",
        checks,
        deltasBeforeDurable,
        perStep,
        baseline,
        growth,
        markers: { frame: frameMarkers, history: historyMarkers },
        samples: samples.length,
        turnFooter,
        streamed,
        history: { assistant: history.assistant, ids: history.ids, textLength: history.text.length },
        rekeys: rekeys.map((event) => ({ at: event.at, id: event.data.assistantMessageID, replaces: event.data.replaces })),
        sessionID,
        durations: { totalMs: Date.now() - started },
        exitCode:
          checks.ready &&
          checks.submitted &&
          checks.progressive &&
          checks.rekey &&
          checks.ids &&
          checks.textOnce &&
          deltasBeforeDurable
            ? 0
            : 1,
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
