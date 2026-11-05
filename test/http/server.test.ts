import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveConfig } from "../../src/config";
import { validateResponse } from "../../src/contract/validate";
import { BASIC_USERNAME, BRIDGE_PROTOCOL_VERSION, createServer, type BridgeServer } from "../../src/http/server";

const PASSWORD = "test-password";

let server!: BridgeServer;
let base: string;

beforeAll(() => {
  server = createServer(resolveConfig({ OMO_BRIDGE_PORT: "0", OMO_BRIDGE_PASSWORD: PASSWORD }));
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
});

function auth(username: string = BASIC_USERNAME, password: string = PASSWORD): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}` };
}

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${path}`, { headers });
}

async function expectUnauthorized(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe('Basic realm="opencode"');
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as Record<string, unknown>;
  expect(body._tag).toBe("UnauthorizedError");
  expect(typeof body.message).toBe("string");
}

describe("GET /api/info", () => {
  test("valid credentials return a 200 body that satisfies the server.info contract", async () => {
    const response = await get("/api/info", auth());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as Record<string, unknown>;
    expect(validateResponse("server.info", body)).toEqual({ ok: true });
    expect(body.version).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(body.pid).toBe(process.pid);
    expect(body.urls).toEqual([`http://127.0.0.1:${server.port}`]);
    expect(body.capabilities).toEqual({ persistentPty: false });
    expect(typeof (body.paths as Record<string, unknown>).tmp).toBe("string");
  });

  test("missing Authorization header returns 401", async () => {
    await expectUnauthorized(await get("/api/info"));
  });

  test("wrong password returns 401", async () => {
    await expectUnauthorized(await get("/api/info", auth(BASIC_USERNAME, "wrong")));
  });

  test("wrong username returns 401 even with the right password", async () => {
    await expectUnauthorized(await get("/api/info", auth("opencode2", PASSWORD)));
    await expectUnauthorized(await get("/api/info", auth("OpenCode", PASSWORD)));
  });

  test("non-Basic authorization scheme returns 401", async () => {
    await expectUnauthorized(await get("/api/info", { authorization: "Bearer token" }));
  });

  test("wrong method on the known path returns 405", async () => {
    const response = await fetch(`${base}/api/info`, { method: "POST", headers: auth() });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body._tag).toBe("MethodNotAllowedError");
    expect(typeof body.message).toBe("string");
  });
});

describe("routing", () => {
  test("unknown path returns 404 with an error envelope", async () => {
    const response = await get("/api/nope", auth());
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body._tag).toBe("NotFoundError");
    expect(typeof body.message).toBe("string");
  });

  test("paths are matched exactly, so a trailing slash is not the info route", async () => {
    const response = await get("/api/info/", auth());
    expect(response.status).toBe(404);
  });

  test("authentication is enforced before routing", async () => {
    await expectUnauthorized(await get("/api/nope"));
  });
});
