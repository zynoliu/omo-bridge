import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { validateResponse } from "../../src/contract/validate";
import { routes } from "../../src/http/routes";
import { SURFACE_FILE, surfaceDocument, type SurfaceEndpoint } from "../../scripts/surface-extract";
import { startSurfaceBridge, type SurfaceBridge } from "../senpi/surface-harness";

const FORK = (process.env.OMO_BRIDGE_OPENCODE_FORK ?? "/Users/zyno/OmO Projects/my-tui/opencode").replace(/\/$/, "");
const fixture = JSON.parse(readFileSync(SURFACE_FILE, "utf8")) as { endpoints: SurfaceEndpoint[] };

const PARAMS: Record<string, string> = {
  messageID: "msg_probe",
  inboxID: "inbox_probe",
  formID: "form_probe",
  requestID: "req_probe",
  integrationID: "anthropic",
  attemptID: "con_probe",
  credentialID: "cred_probe",
  ptyID: "pty_probe",
  hash: "hash_probe",
  server: "demo",
  rpcID: "goal",
  method: "get",
  id: "shell_probe",
  path: "note.txt",
};

type Mounted = { method: string; path: string };

function patternOf(path: string): string[] {
  return path.split("/");
}

function routeMatches(route: Mounted, method: string, path: string): boolean {
  if (route.method !== method) return false;
  const pattern = patternOf(route.path);
  const segments = patternOf(path);
  const wildcard = pattern.at(-1) === "*";
  if (wildcard ? segments.length < pattern.length - 1 : pattern.length !== segments.length) return false;
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index]!;
    if (expected === "*") return true;
    if (expected.startsWith(":")) continue;
    if (expected !== segments[index]) return false;
  }
  return true;
}

const mounted: Mounted[] = [{ method: "GET", path: "/api/info" }, ...routes.map(({ method, path }) => ({ method, path }))];

let bridge: SurfaceBridge;

beforeAll(() => {
  bridge = startSurfaceBridge();
});

afterAll(async () => {
  await bridge?.close();
});

function pathFor(endpoint: SurfaceEndpoint): string {
  let path = endpoint.path;
  for (const [key, value] of Object.entries(PARAMS)) {
    path = path.replaceAll(`:${key}`, encodeURIComponent(value));
  }
  path = path.replaceAll(":sessionID", encodeURIComponent(bridge.sessionID));
  if (endpoint.chain === "session.remove") path = path.replaceAll(encodeURIComponent(bridge.sessionID), encodeURIComponent(bridge.throwawaySessionID));
  return path;
}

function requestPath(endpoint: SurfaceEndpoint): string {
  return `${pathFor(endpoint)}?location%5Bdirectory%5D=${encodeURIComponent(bridge.workdir)}`;
}

describe("TUI surface fixture", () => {
  test("covers every client endpoint the TUI calls", () => {
    expect(fixture.endpoints.length).toBeGreaterThan(0);
    for (const endpoint of fixture.endpoints) {
      expect(endpoint.chain.length).toBeGreaterThan(0);
      expect(endpoint.callSites.length).toBeGreaterThan(0);
    }
  });

  test.skipIf(!existsSync(FORK))("is current with the fork's client and TUI call sites", () => {
    expect(surfaceDocument()).toBe(readFileSync(SURFACE_FILE, "utf8"));
  });
});

describe("TUI surface mounts", () => {
  test("the router mounts every endpoint the TUI calls", () => {
    const unmounted = fixture.endpoints
      .filter((endpoint) => !mounted.some((route) => routeMatches(route, endpoint.method, endpoint.path)))
      .map((endpoint) => `${endpoint.method} ${endpoint.path} (${endpoint.chain})`);
    expect(unmounted).toEqual([]);
  });
});

describe("TUI surface responses", () => {
  for (const endpoint of fixture.endpoints) {
    test(`${endpoint.method} ${endpoint.path}`, async () => {
      const init: RequestInit = {
        method: endpoint.method,
        headers: { ...bridge.auth(), "content-type": "application/json" },
        ...(["POST", "PUT", "PATCH"].includes(endpoint.method) ? { body: "{}" } : {}),
        signal: AbortSignal.timeout(endpoint.sse ? 2_000 : 15_000),
      };
      const response = await fetch(`${bridge.base}${requestPath(endpoint)}`, init);
      const allowed = new Set([endpoint.successStatus, ...endpoint.declaredStatuses]);
      const snippet = endpoint.sse ? "<stream>" : (await response.clone().text()).slice(0, 300);

      if (response.status >= 500) {
        throw new Error(`${endpoint.chain}: ${response.status} is a 5xx (${snippet})`);
      }
      if (!allowed.has(response.status)) {
        throw new Error(
          `${endpoint.chain}: ${response.status} is outside declaredStatuses ${JSON.stringify([...allowed])} (${snippet})`,
        );
      }

      if (endpoint.sse) {
        if (response.status === endpoint.successStatus) {
          expect(response.headers.get("content-type")).toContain("text/event-stream");
        }
        await response.body?.cancel();
        return;
      }
      if (endpoint.binary) {
        if (response.status === endpoint.successStatus) expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
        return;
      }
      if (endpoint.empty) {
        if (response.status === endpoint.successStatus) expect(await response.text()).toBe("");
        return;
      }
      if (response.status !== endpoint.successStatus) return;
      expect(response.headers.get("content-type")).toContain("json");
      const body = (await response.json()) as unknown;
      if (endpoint.schema !== null) {
        expect(validateResponse(endpoint.schema, body)).toEqual({ ok: true });
      }
    });
  }
});
