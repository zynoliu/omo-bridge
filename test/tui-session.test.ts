import { describe, expect, test } from "bun:test";
import { ensureTuiSession, tuiArgs } from "../src/tui-launch";

const BASE = "http://127.0.0.1:4999";
const AUTH = `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`;

type Call = { url: string; method: string; auth: string | null; body?: unknown };

function recorder(respond: (call: Call) => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call: Call = { url, method: init?.method ?? "GET", auth: headers.get("authorization"), body };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetch: fake };
}

describe("tui session bootstrap", () => {
  test("injects --session when the caller did not name one", () => {
    expect(tuiArgs([], "ses_new")).toEqual(["--session", "ses_new"]);
    expect(tuiArgs(["--model", "x"], "ses_new")).toEqual(["--model", "x", "--session", "ses_new"]);
  });

  test("keeps a session the caller already named", () => {
    expect(tuiArgs(["--session", "ses_user"], "ses_new")).toEqual(["--session", "ses_user"]);
    expect(tuiArgs([], undefined)).toEqual([]);
  });

  test("reuses the most recent session instead of opening a new one", async () => {
    const rec = recorder(() =>
      Response.json({ data: [{ id: "ses_recent", location: { directory: "/tmp" } }], cursor: {} }),
    );
    const id = await ensureTuiSession({ url: BASE, password: "secret", fetch: rec.fetch, cwd: "/tmp" });
    expect(id).toBe("ses_recent");
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.method).toBe("GET");
    expect(rec.calls[0]?.url).toContain("/api/session");
    expect(rec.calls[0]?.auth).toBe(AUTH);
  });

  // The TUI publishes every location catalog under the session's `location.directory` and reads it
  // back under its own default location, which comes from the app's process cwd. Landing the launch
  // on a session filed elsewhere splits those keys and empties /models, so a session only counts as
  // reusable when it is filed where the app runs.
  test("skips a more recent session filed outside the TUI's project directory", async () => {
    const rec = recorder(() =>
      Response.json({
        data: [
          { id: "ses_elsewhere", location: { directory: "/tmp/other" } },
          { id: "ses_project", location: { directory: "/tmp/project" } },
        ],
      }),
    );
    const id = await ensureTuiSession({ url: BASE, password: "secret", fetch: rec.fetch, cwd: "/tmp/project" });
    expect(id).toBe("ses_project");
    expect(rec.calls).toHaveLength(1);
  });

  test("creates a session in the project directory when no listed session is filed there", async () => {
    const rec = recorder((call) =>
      call.method === "POST"
        ? Response.json({ data: { id: (call.body as { id: string }).id } })
        : Response.json({ data: [{ id: "ses_elsewhere", location: { directory: "/tmp/other" } }] }),
    );
    const id = await ensureTuiSession({ url: BASE, password: "secret", fetch: rec.fetch, cwd: "/tmp/project" });
    expect(rec.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(rec.calls[1]?.body).toMatchObject({ id, location: { directory: "/tmp/project" } });
  });

  test("creates a session with a client id when the bridge has none", async () => {
    const rec = recorder((call) =>
      call.method === "POST"
        ? Response.json({ data: { id: (call.body as { id: string }).id } })
        : Response.json({ data: [] }),
    );
    const id = await ensureTuiSession({ url: BASE, password: "secret", fetch: rec.fetch, cwd: "/tmp" });
    expect(id).toStartWith("ses_");
    expect(rec.calls.map((call) => call.method)).toEqual(["GET", "POST"]);
    expect(rec.calls[1]?.body).toMatchObject({ id, location: { directory: "/tmp" } });
  });

  test("reports the bridge's refusal instead of launching on a session that does not exist", async () => {
    const rec = recorder(() => new Response("nope", { status: 500 }));
    await expect(ensureTuiSession({ url: BASE, password: "secret", fetch: rec.fetch, cwd: "/tmp" })).rejects.toThrow(
      /500/,
    );
  });
});
