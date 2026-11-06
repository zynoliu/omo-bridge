// Two sessions must never see each other's turns. Synthetic messages make this deterministic: no
// model call is involved, so a failure here is always a bridge routing bug, never a provider hiccup.

const MARKER_A = "ALPHA-ISOLATION-MARKER";
const MARKER_B = "BETA-ISOLATION-MARKER";

async function createSession(bridge, id, directory) {
  const response = await fetch(`${bridge.url}/api/session`, {
    method: "POST",
    headers: { ...bridge.headers, "content-type": "application/json" },
    body: JSON.stringify({ id, title: id, location: { directory } }),
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, id: typeof body?.data?.id === "string" ? body.data.id : undefined };
}

async function synthetic(bridge, id, text) {
  const response = await fetch(`${bridge.url}/api/session/${encodeURIComponent(id)}/synthetic`, {
    method: "POST",
    headers: { ...bridge.headers, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return response.status;
}

async function listedCount(bridge) {
  const response = await fetch(`${bridge.url}/api/session?limit=200`, { headers: bridge.headers });
  const body = await response.json().catch(() => ({}));
  return Array.isArray(body?.data) ? body.data.length : -1;
}

async function texts(bridge, id) {
  const response = await fetch(`${bridge.url}/api/session/${encodeURIComponent(id)}/message?limit=50&order=asc`, {
    headers: bridge.headers,
  });
  const body = await response.json().catch(() => ({}));
  const rows = Array.isArray(body?.data) ? body.data : [];
  return { status: response.status, texts: rows.map((row) => String(row.text ?? "")) };
}

function marked(list, marker) {
  return list.filter((text) => text.includes(marker)).length;
}

export default {
  name: "isolation",
  async run(ctx) {
    const started = Date.now();
    const bridge = await ctx.startBridge({ evidenceDir: ctx.evidenceDir });
    try {
      const stamp = Date.now().toString(36);
      const a = { id: `ses_iso_a${stamp}`, marker: MARKER_A };
      const b = { id: `ses_iso_b${stamp}`, marker: MARKER_B };

      const before = await listedCount(bridge);
      const created = { a: await createSession(bridge, a.id, ctx.repo), b: await createSession(bridge, b.id, ctx.repo) };
      const after = await listedCount(bridge);
      const postedA = await synthetic(bridge, a.id, a.marker);
      const postedB = await synthetic(bridge, b.id, b.marker);

      const readA = await texts(bridge, a.id);
      const readB = await texts(bridge, b.id);
      const listed = await fetch(`${bridge.url}/api/session?limit=50`, { headers: bridge.headers });
      const listBody = await listed.json().catch(() => ({}));
      const listedIds = (Array.isArray(listBody?.data) ? listBody.data : []).map((row) => row.id);

      const checks = {
        created: created.a.status === 200 && created.b.status === 200,
        posted: postedA === 200 && postedB === 200,
        bothListed: after - before === 2,
        aHasOnlyA: marked(readA.texts, a.marker) === 1 && marked(readA.texts, b.marker) === 0,
        bHasOnlyB: marked(readB.texts, b.marker) === 1 && marked(readB.texts, a.marker) === 0,
      };
      const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);

      const report = {
        scenario: "isolation",
        outcome: failed.length === 0 ? "isolated" : "leaked",
        failed,
        checks,
        sessions: { a: a.id, b: b.id, listedBefore: before, listedAfter: after, sample: listedIds.slice(0, 6) },
        seen: { a: readA.texts, b: readB.texts },
        durations: { totalMs: Date.now() - started },
        exitCode: failed.length === 0 ? 0 : 1,
      };
      await ctx.writeFile("report.json", JSON.stringify(report, null, 2));
      return { exitCode: report.exitCode, report };
    } finally {
      await bridge.stop();
    }
  },
};
