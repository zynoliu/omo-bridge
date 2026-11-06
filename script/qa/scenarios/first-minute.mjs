// The user's first minute: seven slash surfaces opened on the home screen before anything else. Each
// one is judged on two independent axes, in the same run, so a bridge that answers empty and a TUI
// that paints its own sentence cannot hide behind each other:
//
//   uiResult       what the frame shows after the command
//                    content         at least one row the surface exists to list
//                    not-wired       dialog opens with zero rows and only DialogSelect's generic
//                                    "No items available" fallback (`ui/dialog-select.tsx:750-753`)
//                    tui-copy-owned  zero rows and a surface-specific sentence the TUI authors, which
//                                    claims a state the bridge does not back
//                    failed          an error sentence reached the frame
//   bridgeVerdict  what the bridge answered when asked for that surface
//                    data            the read served rows
//                    empty-declared  the read served its declared empty value ([] or null)
//                    refused         the surface's action got the declared error tag back
//                    (from GET /api/bridge/capabilities plus one live probe per surface)
//
// The expectations below are pinned from the frame + ledger evidence captured during task 13, not
// derived from the frame being judged: a surface that changes its answer turns this scenario red.

const { writeFile } = await import("node:fs/promises");
const { join } = await import("node:path");

// The plan words this surface `/mcp`; the TUI registers the command as `mcps` (`app.tsx:972`), and
// typing `/mcp` only surfaces that suggestion in autocomplete, so the scenario drives the real one.
const MCP_SLASH = "/mcps";
const MCP_TITLES = ["MCP servers", "Search MCP servers"];

const GENERIC_EMPTY = "No items available";
const USAGE_COPY = "Sign in to OpenCode Console";
const WORKTREE_COPY = "No worktrees available";
const ERROR_LINE = /Could not load|Failed to load|not supported by the omo-native engine/iu;

const SURFACES = [
  {
    surface: "models",
    slash: "/models",
    titles: ["Search models", "Select model", "Free models"],
    family: "integration",
    expectUi: "content",
    expectVerdict: "data",
    // The connected picker lists the host's models; a Free branch paints a different heading but no
    // rows, so "content" still requires a served model name to be on screen.
    names: "models",
  },
  {
    surface: "connect",
    slash: "/connect",
    titles: ["Connect an integration"],
    family: "integration",
    expectUi: "content",
    expectVerdict: "data",
    names: "integrations",
  },
  {
    surface: "skills",
    slash: "/skills",
    titles: ["Skills"],
    family: "skills",
    expectUi: "content",
    expectVerdict: "data",
    names: "skills",
  },
  {
    surface: "mcp",
    slash: MCP_SLASH,
    titles: MCP_TITLES,
    family: "mcp",
    expectUi: "not-wired",
    expectVerdict: "empty-declared",
  },
  {
    surface: "plugins",
    slash: "/plugins",
    titles: ["Plugins"],
    family: "plugins",
    expectUi: "content",
    expectVerdict: "empty-declared",
    // Rows here are TUI-owned (builtins / installed TUI plugins), so no bridge name can be matched;
    // DialogSelect groups rows under a runtime heading, which is the structural "a row exists" mark.
    rowHeading: "TUI",
  },
  {
    surface: "usage",
    slash: "/usage",
    titles: ["Usage"],
    family: "usage",
    expectUi: "tui-copy-owned",
    expectVerdict: "empty-declared",
    copy: USAGE_COPY,
  },
  {
    surface: "worktree",
    slash: "/worktrees",
    titles: ["Worktrees"],
    family: "worktree",
    expectUi: "tui-copy-owned",
    expectVerdict: "refused",
    copy: WORKTREE_COPY,
  },
];

function lines(frame) {
  return frame
    .split("\n")
    .map((line) => line.replace(/[│┃|]/gu, " ").trim())
    .filter((line) => line.length > 0);
}

function rowsOf(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function namesOf(rows, field) {
  return rows.map((row) => row?.[field] ?? row?.name ?? row?.id).filter((name) => typeof name === "string" && name.length > 0);
}

async function readBridge(bridge, path, init) {
  const response = await fetch(`${bridge.url}${path}`, { headers: bridge.headers, ...init });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return {
    method: init?.method ?? "GET",
    path: path.split("?")[0],
    status: response.status,
    body,
    rows: rowsOf(body),
  };
}

function verdictOf(probe) {
  if (probe.refusal !== undefined) return "refused";
  if (probe.observedRows > 0) return "data";
  return "empty-declared";
}

// One probe per surface, taken before the TUI starts so the verdict never depends on what the dialog
// painted. `directory` is the repo the harness runs from: the same location the TUI's default key
// resolves to once the launcher files its session there (task 11).
async function probeSurfaces(bridge, repo) {
  const query = new URLSearchParams({ "location[directory]": repo });
  const at = (path) => `${path}?${query}`;

  const models = await readBridge(bridge, at("/api/model"));
  const integrations = await readBridge(bridge, at("/api/integration"));
  const skills = await readBridge(bridge, at("/api/skill"));
  const mcp = await readBridge(bridge, at("/api/mcp"));
  const plugins = await readBridge(bridge, at("/api/plugin"));
  const usage = await readBridge(bridge, at("/api/experimental/usage/limits"));
  const worktreeList = await readBridge(bridge, `/api/worktree?${new URLSearchParams({ projectID: "first-minute" })}`);
  // The list is a declared empty; the dialog's own actions are what the bridge refuses.
  const worktreeCreate = await readBridge(bridge, "/api/worktree", {
    method: "POST",
    headers: { ...bridge.headers, "content-type": "application/json" },
    body: JSON.stringify({ projectID: "first-minute", name: "first-minute" }),
  });

  const probes = {
    models: {
      calls: [models, integrations],
      observedRows: models.rows.length,
      names: namesOf(models.rows, "name"),
    },
    connect: {
      calls: [integrations],
      observedRows: integrations.rows.length,
      names: namesOf(integrations.rows, "name"),
    },
    skills: {
      calls: [skills],
      observedRows: skills.rows.length,
      names: namesOf(skills.rows, "id"),
    },
    mcp: { calls: [mcp], observedRows: mcp.rows.length },
    plugins: { calls: [plugins], observedRows: plugins.rows.length },
    usage: { calls: [usage], observedRows: usage.rows.length },
    worktree: {
      calls: [worktreeList, worktreeCreate],
      observedRows: worktreeList.rows.length,
      refusal: {
        status: worktreeCreate.status,
        tag: typeof worktreeCreate.body?._tag === "string" ? worktreeCreate.body._tag : undefined,
      },
    },
  };
  for (const [name, probe] of Object.entries(probes)) {
    const expected = SURFACES.find((surface) => surface.surface === name).expectVerdict;
    const actual = verdictOf(probe);
    if (actual !== expected) {
      throw new Error(`surface ${name}: probe says ${actual}, scenario pins ${expected}`);
    }
    probe.verdict = actual;
  }
  return probes;
}

function ledgerFamily(ledger, family) {
  const entry = ledger.find((row) => row?.family === family);
  if (entry === undefined) throw new Error(`capability ledger has no family ${family}`);
  return { family: entry.family, capability: entry.capability };
}

function visibleNames(frame, names) {
  return names.filter((name) => frame.includes(name));
}

function classify(surface, frame, probe, opened) {
  if (!opened) return { uiResult: "not-wired", matched: [] };
  if (ERROR_LINE.test(frame)) return { uiResult: "failed", matched: [] };
  const named = surface.names === undefined ? [] : visibleNames(frame, probe.names);
  if (named.length > 0) {
    return { uiResult: "content", matched: named.slice(0, 10) };
  }
  if (surface.rowHeading !== undefined && lines(frame).some((line) => line.split(/\s+/u).includes(surface.rowHeading))) {
    return { uiResult: "content", matched: [surface.rowHeading] };
  }
  if (surface.copy !== undefined && frame.includes(surface.copy)) {
    return { uiResult: "tui-copy-owned", matched: [surface.copy] };
  }
  if (frame.includes(GENERIC_EMPTY)) return { uiResult: "not-wired", matched: [GENERIC_EMPTY] };
  // Zero rows and no sentence of either kind: the dialog opened and said nothing. That is the
  // not-wired outcome, not a failure, because no error text reached the frame.
  return { uiResult: "not-wired", matched: [] };
}

async function openSurface(tui, surface) {
  // The prompt keeps a failed command's text; ctrl+u is `input.delete.to.line.start`. It is only sent
  // while no dialog is focused, and never on an empty prompt it could leak into.
  await tui.write("\u0015");
  await Bun.sleep(200);
  await tui.write(surface.slash);
  await Bun.sleep(400);
  await tui.press("Enter");
  const opened = await tui.waitFor(
    (text) => surface.titles.some((title) => text.includes(title)),
    15_000,
    250,
  );
  await Bun.sleep(800);
  const frame = await tui.text();
  await tui.press("Escape");
  await tui.waitFor((text) => !surface.titles.some((title) => text.includes(title)), 8_000, 250);
  await Bun.sleep(300);
  return { opened, frame };
}

export default {
  name: "first-minute",
  async run(ctx) {
    const started = Date.now();
    const evidence = ctx.evidenceDir;
    const bridge = await ctx.startBridge({ evidenceDir: evidence });
    let tui;
    try {
      const capabilities = await readBridge(bridge, "/api/bridge/capabilities");
      const ledger = Array.isArray(capabilities.body?.data) ? capabilities.body.data : [];
      if (ledger.length === 0) throw new Error("GET /api/bridge/capabilities served no families");
      const probes = await probeSurfaces(bridge, ctx.repo);

      const frames = {};
      let screenshot = { written: false, reason: "not attempted" };
      tui = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36 });
      const ready = await tui.waitFor(
        (text) => text.includes("Build ·") || text.includes("ctrl+p commands") || text.includes("Search sessions"),
        60_000,
      );
      const before = await ctx.writeFile("frame-before.txt", await tui.text());
      // The home screen syncs its location resources asynchronously; a dialog opened before that
      // settles can read an empty catalog that the bridge does serve.
      await Bun.sleep(Number(process.env.QA_FIRST_MINUTE_SETTLE_MS ?? 10_000));

      const results = [];
      for (const surface of SURFACES) {
        const { opened, frame } = await openSurface(tui, surface);
        const framePath = await ctx.writeFile(`frame-${surface.surface}.txt`, frame);
        if (surface.surface === "models" && opened) {
          screenshot = await tui.screenshot(join(evidence, "frame.png")).catch((error) => ({
            written: false,
            reason: String(error).slice(0, 160),
          }));
        }
        const judged = classify(surface, frame, probes[surface.surface], opened);
        const ledgerEntry = ledgerFamily(ledger, surface.family);
        const verdictMatch = probes[surface.surface].verdict === surface.expectVerdict;
        results.push({
          surface: surface.surface,
          slash: surface.slash,
          uiResult: judged.uiResult,
          bridgeVerdict: probes[surface.surface].verdict,
          ledger: ledgerEntry,
          expected: { uiResult: surface.expectUi, bridgeVerdict: surface.expectVerdict },
          ok: judged.uiResult === surface.expectUi && verdictMatch,
          evidence: {
            frame: framePath.path,
            opened,
            matched: judged.matched,
            bridge: probes[surface.surface].calls.map((call) => ({
              request: `${call.method} ${call.path}`,
              status: call.status,
              rows: call.rows.length,
              nullData: call.body?.data === null,
            })),
          },
        });
      }
      await ctx.writeFile("transcript.txt", await tui.transcript());

      const byName = new Map(results.map((row) => [row.surface, row]));
      const skills = byName.get("skills");
      const skillIds = probes.skills.names;
      const fiveIds = skillIds.length === 5;
      const allSkillIdsVisible = skills.uiResult === "content" && skillIds.every((id) => skills.evidence.matched.includes(id));
      const complete = results.length === SURFACES.length && results.every(
        (row) =>
          ["content", "not-wired", "tui-copy-owned", "failed"].includes(row.uiResult) &&
          ["data", "refused", "empty-declared"].includes(row.bridgeVerdict) &&
          row.evidence.frame.length > 0,
      );
      const checks = {
        surfacesComplete: complete,
        allPromptedSurfacesMatchPins: results.every((row) => row.ok),
        modelsContent: byName.get("models").uiResult === "content",
        skillsContent: skills.uiResult === "content",
        skillsFiveIds: fiveIds,
        skillsAllIdsVisible: allSkillIdsVisible,
        // The ledger is the authority for a degraded family: capability false must never be answered
        // as data. `/skills` is checked separately below because its ledger row is stale.
        usageVerdictMatchesLedger: byName.get("usage").ledger.capability === false && byName.get("usage").bridgeVerdict !== "data",
        worktreeVerdictMatchesLedger: byName.get("worktree").ledger.capability === false && byName.get("worktree").bridgeVerdict !== "data",
      };
      const findings = [];
      if (byName.get("skills").ledger.capability !== (byName.get("skills").bridgeVerdict === "data")) {
        findings.push(
          `capability ledger still marks skills capability=false ("senpi has no skill discovery"), but GET /api/skill served ${skillIds.length} rows and the dialog listed them; task 16 must sync the ledger row.`,
        );
      }
      const exitCode = Object.values(checks).every(Boolean) ? 0 : 1;

      const report = {
        scenario: "first-minute",
        ready,
        surfaces: results,
        checks,
        findings,
        ledger: {
          request: "GET /api/bridge/capabilities",
          served: ledger.length,
          families: results.map((row) => row.ledger.family),
        },
        skillIds,
        exitCode,
        durations: { totalMs: Date.now() - started },
        renderMode: screenshot.written ? "webview" : "text",
        screenshot: screenshot.written ? screenshot.path : `none (${screenshot.reason})`,
        evidence: { before: before.path, bridgeLog: bridge.logPath, stateDir: bridge.stateDir },
        bridge: { url: bridge.url, port: bridge.port },
      };
      await writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
      return { exitCode, report };
    } finally {
      await tui?.stop();
      await bridge.stop();
    }
  },
};
