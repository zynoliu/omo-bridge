import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponse } from "../../src/contract/validate";
import {
  SESSION_STATE_FILE,
  SessionMap,
  decodeCursor,
  encodeCursor,
  projectFor,
  toPublicSessionInfo,
  type SessionListRow,
} from "../../src/model/session-map";

let root: string;
let stateDir: string;
let agentDir: string;
let warnings: string[];

function openMap(): SessionMap {
  return SessionMap.open({ stateDir, agentDir, warn: (message) => warnings.push(message) });
}

function row(overrides: Partial<SessionListRow> & { cwd: string }): SessionListRow {
  return { sessionId: "route-1", ...overrides };
}

function writeSessionFile(id: string, name: string, lines: string[]): string {
  const directory = join(agentDir, "sessions", "--work-project--");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `2026-11-01T00-00-00.000Z_${id}.jsonl`);
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-11-01T00:00:00.000Z",
    cwd: join(root, "project"),
  });
  writeFileSync(file, `${[header, ...lines].join("\n")}\n`);
  return file;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "session-map-"));
  stateDir = join(root, "state");
  agentDir = join(root, "agent");
  warnings = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("durable keys", () => {
  test("prefers durableSessionId, then sessionPath, and never keys on the routing id", () => {
    const map = openMap();
    const durable = map.upsert(
      row({ sessionId: "route-1", durableSessionId: "durable-1", sessionPath: "/sessions/a.jsonl", cwd: join(root, "a") }),
    );
    expect(durable.key).toBe("durable-1");

    const pathKeyed = map.upsert(row({ sessionId: "route-2", sessionPath: "/sessions/b.jsonl", cwd: join(root, "b") }));
    expect(pathKeyed.key).toBe("/sessions/b.jsonl");

    const ephemeral = map.upsert(row({ sessionId: "route-3", cwd: join(root, "c") }));
    expect(ephemeral.key).not.toBe("route-3");
    expect(map.get("route-3")).toBeUndefined();

    map.flush();
    const persisted = JSON.parse(readFileSync(join(stateDir, SESSION_STATE_FILE), "utf8")) as {
      version: number;
      sessions: Array<{ key: string }>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.sessions.map((record) => record.key).sort()).toEqual(["/sessions/b.jsonl", "durable-1"].sort());
  });

  test("drops senpi-only fields from the record and from the persisted file", () => {
    const map = openMap();
    const incoming = {
      sessionId: "route-1",
      durableSessionId: "durable-1",
      cwd: join(root, "project"),
      kind: "interactive",
      context: { workspace: "x" },
      idleMs: 12,
      retain_on_disconnect: true,
    } as unknown as SessionListRow;
    const record = map.upsert(incoming);
    expect(Object.keys(record).sort()).toEqual([
      "cwd",
      "firstSeenAt",
      "key",
      "lastSeenAt",
      "projectID",
      "routingId",
    ]);
    map.flush();
    const raw = readFileSync(join(stateDir, SESSION_STATE_FILE), "utf8");
    expect(raw).not.toContain("kind");
    expect(raw).not.toContain("idleMs");
    expect(raw).not.toContain("retain_on_disconnect");
  });

  test("preserves the archive flag while refreshing routing identity", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project"), name: "Original" }));
    map.rename("durable-1", "Renamed");
    map.archive("durable-1");
    const refreshed = map.upsert(row({ sessionId: "route-9", durableSessionId: "durable-1", cwd: join(root, "project"), name: "Original" }));
    expect(refreshed.name).toBe("Original");
    expect(refreshed.archived).toBe(true);
    expect(refreshed.routingId).toBe("route-9");
  });
});

describe("corrupt state", () => {
  test("warns and rebuilds from disk when sessions.json is not JSON", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, SESSION_STATE_FILE), "{not json");
    const file = writeSessionFile("durable-disk", "Disk session", [
      JSON.stringify({
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-11-01T00:00:01.000Z",
        message: { role: "user", content: "Fix the login flow", timestamp: 1761955201000 },
      }),
      JSON.stringify({
        type: "session_info",
        id: "i1",
        parentId: "u1",
        timestamp: "2026-11-01T00:00:02.000Z",
        name: "Login flow",
      }),
      "!!! not json !!!",
    ]);

    const map = openMap();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(SESSION_STATE_FILE);

    const record = map.get("durable-disk");
    expect(record).toBeDefined();
    expect(record?.sessionPath).toBe(file);
    expect(record?.cwd).toBe(join(root, "project"));
    expect(record?.name).toBe("Login flow");
    expect(record?.firstSeenAt).toBe("2026-11-01T00:00:00.000Z");

    map.flush();
    const persisted = JSON.parse(readFileSync(join(stateDir, SESSION_STATE_FILE), "utf8")) as {
      sessions: Array<{ key: string }>;
    };
    expect(persisted.sessions.map((entry) => entry.key)).toEqual(["durable-disk"]);
  });

  test("warns and rebuilds when sessions.json is valid JSON of the wrong shape", () => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, SESSION_STATE_FILE), JSON.stringify({ sessions: "nope" }));
    const map = openMap();
    expect(warnings).toHaveLength(1);
    expect(map.size).toBe(0);
  });

  test("counts unparseable lines and skips files with no session header", () => {
    writeSessionFile("durable-disk", "Disk session", ["", "{broken", "also broken"]);
    const headerless = join(agentDir, "sessions", "--other--", "no-header.jsonl");
    mkdirSync(join(agentDir, "sessions", "--other--"), { recursive: true });
    writeFileSync(headerless, `${JSON.stringify({ type: "message", id: "x" })}\n`);

    const map = openMap();
    const rebuilt = map.rebuildFromDisk();
    expect(rebuilt.files).toBe(2);
    expect(rebuilt.records).toBe(1);
    expect(rebuilt.skippedFiles).toBe(1);
    expect(rebuilt.skippedEntries).toBe(2);
  });
});

describe("flush", () => {
  test("writes sessions.json atomically with mode 0600 and no temp file", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project") }));
    map.flush();

    expect(readdirSync(stateDir)).toEqual([SESSION_STATE_FILE]);
    expect(statSync(join(stateDir, SESSION_STATE_FILE)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(readFileSync(join(stateDir, SESSION_STATE_FILE), "utf8")) as {
      version: number;
      sessions: unknown[];
    };
    expect(persisted.version).toBe(1);
    expect(persisted.sessions).toHaveLength(1);
  });

  test("creates a missing state directory and round-trips through open()", () => {
    const first = openMap();
    first.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project"), name: "Kept" }));
    first.archive("durable-1");
    first.flush();

    const second = openMap();
    expect(warnings).toEqual([]);
    const record = second.get("durable-1");
    expect(record?.name).toBe("Kept");
    expect(record?.archived).toBe(true);
    expect(record?.archivedAt).toBeDefined();
  });
});

describe("list", () => {
  test("orders by lastSeenAt desc then key asc and pages with opaque cursors", () => {
    const map = openMap();
    const seenAt = (second: number): string => `2026-11-05T00:00:0${second}.000Z`;
    map.upsert(row({ durableSessionId: "b", cwd: join(root, "b") }), seenAt(1));
    map.upsert(row({ durableSessionId: "a", cwd: join(root, "a") }), seenAt(1));
    map.upsert(row({ durableSessionId: "c", cwd: join(root, "c") }), seenAt(3));
    map.upsert(row({ durableSessionId: "d", cwd: join(root, "d") }), seenAt(2));
    map.upsert(row({ durableSessionId: "e", cwd: join(root, "e") }), seenAt(5));

    const all = map.list().data.map((record) => record.key);
    expect(all).toEqual(["e", "c", "d", "a", "b"]);

    const collected: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = map.list({ limit: 2, ...(cursor === undefined ? {} : { cursor }) });
      collected.push(...result.data.map((record) => record.key));
      cursor = result.cursor.next;
      if (cursor === undefined) break;
    }
    expect(collected).toEqual(all);
    expect(new Set(collected).size).toBe(all.length);
  });

  test("emits a previous cursor for later pages and ignores an invalid cursor", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "a", cwd: join(root, "a") }), "2026-11-05T00:00:01.000Z");
    map.upsert(row({ durableSessionId: "b", cwd: join(root, "b") }), "2026-11-05T00:00:02.000Z");
    map.upsert(row({ durableSessionId: "c", cwd: join(root, "c") }), "2026-11-05T00:00:03.000Z");

    const first = map.list({ limit: 2 });
    expect(first.cursor.next).toBeDefined();
    const second = map.list({ limit: 2, cursor: first.cursor.next });
    expect(decodeCursor(second.cursor.previous)).toBe(0);
    expect(second.data.map((record) => record.key)).toEqual(["a"]);

    expect(map.list({ limit: 2, cursor: "not-a-cursor" }).data.map((record) => record.key)).toEqual(["c", "b"]);
    expect(decodeCursor(encodeCursor(3))).toBe(3);
  });

  test("hides archived sessions unless asked", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "live", cwd: join(root, "live") }));
    map.upsert(row({ durableSessionId: "gone", cwd: join(root, "gone") }));
    map.archive("gone");

    expect(map.list().data.map((record) => record.key)).toEqual(["live"]);
    expect(map.list({ includeArchived: true }).data.map((record) => record.key).sort()).toEqual(["gone", "live"]);
    expect(map.archive("gone", false)?.archived).toBeUndefined();
    expect(map.list().data.map((record) => record.key).sort()).toEqual(["gone", "live"]);
  });
});

describe("project identity", () => {
  test("is stable across symlinked paths and trailing separators", () => {
    const real = join(root, "real-project");
    mkdirSync(real, { recursive: true });
    const link = join(root, "link-project");
    symlinkSync(real, link, "dir");

    const direct = projectFor(real);
    const throughLink = projectFor(link);
    const trailing = projectFor(`${real}/`);

    expect(throughLink.canonical).toBe(direct.canonical);
    expect(throughLink.id).toBe(direct.id);
    expect(trailing.id).toBe(direct.id);
    expect(direct.id).toMatch(/^[0-9a-f]{16}$/);
    expect(throughLink.directory).toBe(link);
  });

  test("maps a record onto the opencode public session shape", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project"), name: "Bridge" }));
    const record = map.get("durable-1");
    expect(record).toBeDefined();
    const info = toPublicSessionInfo(record!);
    expect(info.id).toBe("durable-1");
    expect(info.title).toBe("Bridge");
    expect(info.location).toEqual({ directory: join(root, "project") });
    expect(info.projectID).toBe(projectFor(join(root, "project")).id);
    expect(Number.isInteger(info.time.created)).toBe(true);
    expect(Number.isInteger(info.time.updated)).toBe(true);
    expect(info.time.created).toBeGreaterThan(0);
    expect(info.time).not.toHaveProperty("archived");
    expect(validateResponse("session.publicInfo", info)).toEqual({ ok: true });
  });

  test("archived records carry time.archived in epoch millis", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project") }));
    map.archive("durable-1");

    const info = toPublicSessionInfo(map.get("durable-1")!);
    expect(Number.isInteger(info.time.archived)).toBe(true);
    expect(info.time.archived).toBeGreaterThan(0);
    expect(validateResponse("session.publicInfo", info)).toEqual({ ok: true });

    map.archive("durable-1", false);
    expect(toPublicSessionInfo(map.get("durable-1")!).time.archived).toBeUndefined();
  });

  test("falls back to the directory name as the title", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project") }));
    expect(toPublicSessionInfo(map.get("durable-1")!).title).toBe("project");
  });
});

describe("mutations", () => {
  test("get returns copies so callers cannot corrupt the map", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project") }));
    const copy = map.get("durable-1")!;
    copy.name = "mutated";
    expect(map.get("durable-1")?.name).toBeUndefined();
  });

  test("rename trims the title and remove drops the record", () => {
    const map = openMap();
    map.upsert(row({ durableSessionId: "durable-1", cwd: join(root, "project") }));
    expect(map.rename("durable-1", "  Spaced  ")?.name).toBe("Spaced");
    expect(map.rename("missing", "x")).toBeUndefined();
    expect(map.remove("durable-1")).toBe(true);
    expect(map.remove("durable-1")).toBe(false);
    expect(map.get("durable-1")).toBeUndefined();
  });
});
