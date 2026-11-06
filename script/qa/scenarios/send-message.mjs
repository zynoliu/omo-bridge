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

// The user's first complaint: the answer must render below the message it answers. A turn that paints
// its reply above the user's own bubble is a defect even though both are present.
function replyOrder(frame, text) {
  const lines = frame.split("\n");
  const user = lines.findIndex((line) => line.includes("┃") && line.replace(/[┃|]/gu, " ").trim().endsWith(text));
  const reply = lines.findIndex((line) => ASSISTANT_FOOTER.test(line));
  if (user < 0 || reply < 0) return { ordered: false, userIndex: user, replyIndex: reply };
  return { ordered: user < reply, userIndex: user, replyIndex: reply };
}

// A session mounted while idle paints no assistant footer, so the reload falls back to the first
// assistant entry row; a footer-anchored frame still uses it.
const ASSISTANT_ENTRY = /(?:\+ Thought|Thought ·|✓ todo|◐ todo)/u;

function paintOrder(frame, text) {
  const anchored = replyOrder(frame, text);
  if (anchored.replyIndex >= 0) return anchored;
  const lines = frame.split("\n");
  const user = lines.findIndex((line) => line.includes("┃") && line.replace(/[┃|]/gu, " ").trim().endsWith(text));
  const entry = lines.findIndex((line) => ASSISTANT_ENTRY.test(line));
  if (user < 0 || entry < 0) return { ordered: false, userIndex: user, replyIndex: entry };
  return { ordered: user < entry, userIndex: user, replyIndex: entry };
}

function addedLines(before, after) {
  const known = new Set(paneLines(before));
  return paneLines(after).filter((line) => !known.has(line));
}

// What each direction serves, read from the same bridge the TUI just used. The client asks for
// `order=desc` and reverses it; comparing the painted frame against these rows attributes a wrong
// order to the pagination the server serves or to the client that assembles it.
async function servedOrder(bridge, sessionID, order) {
  const response = await fetch(
    `${bridge.url}/api/session/${encodeURIComponent(sessionID)}/message?limit=50&order=${order}`,
    { headers: bridge.headers },
  );
  const body = await response.json();
  const data = Array.isArray(body?.data) ? body.data : [];
  return {
    status: response.status,
    cursor: body?.cursor ?? null,
    rows: data.map((message, index) => ({
      index,
      id: message.id,
      type: message.type,
      text: String(message.text ?? "").slice(0, 60),
    })),
  };
}

// Records the bridge's event stream for the whole run. The client's store is built from these
// frames, so their order (and whether `session.inbox.*` ever arrives) is part of the evidence.
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
      // Stopping the bridge closes the stream; that is how this recorder ends on every run.
    }
  })();
  return { events, reading, stop: () => controller.abort() };
}

export function classify(before, after) {
  const added = addedLines(before, after);
  const error = added.find((line) => ERROR_PATTERN.test(line));
  if (error !== undefined) return { outcome: "error", line: error };
  const footer = added.find((line) => ASSISTANT_FOOTER.test(line));
  if (footer !== undefined) return { outcome: "reply", line: footer };
  return { outcome: "idle", line: "" };
}

const PROVIDER_ERROR = "provider-error";

/**
 * Points the launcher at `test/senpi/fake-host.ts`. The launcher probes `omo host ensure` first; that
 * probe exits non-zero for the fake, so `ensurePrivateHost` falls back to spawning it with
 * `--listen unix://<private socket>` and the bridge talks to the fake for the whole run. The fake
 * accepts a prompt and ends its turn with the host's `agent_end.failure` shape.
 */
async function installFakeHostBinary(ctx, evidenceDir) {
  const wrapper = `${evidenceDir}/fake-host-omo`;
  await Bun.write(wrapper, `#!/bin/sh\nexec "${ctx.bunExe}" "${ctx.repo}/test/senpi/fake-host.ts" "$@"\n`);
  await Bun.$`chmod +x ${wrapper}`.quiet();
  const previous = process.env.OMO_BRIDGE_OMO_BIN;
  process.env.OMO_BRIDGE_OMO_BIN = wrapper;
  return () => {
    if (previous === undefined) delete process.env.OMO_BRIDGE_OMO_BIN;
    else process.env.OMO_BRIDGE_OMO_BIN = previous;
  };
}

/** What the bridge kept of the injected failure: its log line and the event the frames produced. */
async function providerErrorEvidence(bridge, events) {
  let log = "";
  try {
    log = await Bun.file(bridge.logPath).text();
  } catch {
    // The log is written by the launcher; a run that never started leaves none.
  }
  const logLine = log.split("\n").find((line) => line.includes("session.execution.failed")) ?? "";
  const failed = events.find((event) => event.type === "session.execution.failed");
  return {
    bridgeLogLine: logLine,
    retained: {
      provider: /\bprovider=/.test(logLine),
      model: /\bmodel=/.test(logLine),
      code: /\bcode=/.test(logLine),
    },
    event: failed?.data ?? null,
  };
}

export default {
  name: "send-message",
  async run(ctx) {
    const started = Date.now();
    const evidence = ctx.evidenceDir;
    const restoreOmoBin = ctx.fault === PROVIDER_ERROR ? await installFakeHostBinary(ctx, evidence) : undefined;
    const bridge = await ctx.startBridge({ evidenceDir: evidence });
    const recorder = recordEvents(bridge);
    const checks = { reply: false, error: false, idle: false, order: false };
    let orderApi = { desc: null, asc: null };
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
      const replyWindowMs = Number(process.env.QA_REPLY_WAIT_MS ?? 90_000);
      const deadline = Date.now() + replyWindowMs;
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
      const order = replyOrder(frameAfter, "你好");
      checks.order = order.ordered;

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
          const [desc, asc] = await Promise.all([
            servedOrder(bridge, sessionID, "desc"),
            servedOrder(bridge, sessionID, "asc"),
          ]);
          orderApi = { desc, asc };
          await ctx.writeFile("messages-desc.json", JSON.stringify(desc, null, 2));
          await ctx.writeFile("messages-asc.json", JSON.stringify(asc, null, 2));
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

      // A fresh mount reads the same session once and paints what the server serves. If that frame
      // is ordered, the served order is sound and the live run's frame was assembled, not served.
      let reload = { attempted: false, order: null, frame: null, error: null };
      if (ctx.fault === undefined && sessionID !== undefined) {
        reload.attempted = true;
        await tui.stop();
        let reopened;
        try {
          reopened = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36, sessionID });
          await reopened.waitFor((text) => text.includes("你好"), 60_000);
          const reloadText = await reopened.text();
          const written = await ctx.writeFile("frame-reload.txt", reloadText);
          reload = { attempted: true, order: paintOrder(reloadText, "你好"), frame: written.path, error: null };
        } catch (error) {
          reload = { attempted: true, order: null, frame: null, error: String(error).slice(0, 160) };
        } finally {
          await reopened?.stop();
        }
        tui = undefined;
      }

      recorder.stop();
      await recorder.reading;
      const eventTypes = recorder.events.map((event) => event.type);
      await ctx.writeFile("events.jsonl", recorder.events.map((event) => JSON.stringify(event)).join("\n"));
      const events = {
        total: eventTypes.length,
        inbox: eventTypes.filter((type) => type.startsWith("session.inbox")),
        types: eventTypes,
      };

      const report = {
        scenario: "send-message",
        outcome,
        matched,
        checks,
        order,
        orderApi,
        reload,
        events: { total: events.total, inbox: events.inbox, types: events.types.slice(0, 80) },
        ready,
        opened,
        submitted,
        openRequested: process.env.QA_OPEN_SESSION !== "0",
        fault: ctx.fault ?? null,
        providerError: ctx.fault === PROVIDER_ERROR ? await providerErrorEvidence(bridge, recorder.events) : null,
        sessionID,
        history,
        durations: { totalMs: Date.now() - started, replyWaitMs: Date.now() - sentAt },
        // A painted footer is not enough: the message must have reached the pane as a submitted bubble
        // (`submitted`) and the bridge's own history must carry the assistant row the frame claims
        // (`history.assistant > 0`), otherwise a stale or local-only frame can pass as a reply.
        exitCode: outcome === "reply" && !checks.error && checks.order && submitted && history.assistant > 0 ? 0 : 1,
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
      recorder.stop();
      await tui?.stop();
      await bridge.stop();
      restoreOmoBin?.();
    }
  },
};
