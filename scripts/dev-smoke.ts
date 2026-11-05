import { resolveConfig } from "../src/config";
import { createServer } from "../src/http/server";

const PASSWORD = "smoke-password";

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function expectStatus(label: string, response: Response, expected: number): Promise<Response> {
  if (response.status !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${response.status} (${await response.text()})`);
  }
  return response;
}

const config = resolveConfig({
  OMO_BRIDGE_PORT: "0",
  OMO_BRIDGE_HOST: "127.0.0.1",
  OMO_BRIDGE_PASSWORD: PASSWORD,
});
const server = createServer(config);

try {
  const base = `http://127.0.0.1:${server.port}`;

  await expectStatus("no auth", await fetch(`${base}/api/info`), 401);
  await expectStatus("wrong password", await fetch(`${base}/api/info`, { headers: { authorization: basic("opencode", "wrong") } }), 401);

  const authorized = await expectStatus("valid auth", await fetch(`${base}/api/info`, { headers: { authorization: basic("opencode", PASSWORD) } }), 200);
  const body = (await authorized.json()) as Record<string, unknown>;
  if (typeof body.version !== "string" || body.version.length === 0) throw new Error(`unexpected version: ${JSON.stringify(body.version)}`);
  if (typeof body.pid !== "number") throw new Error(`unexpected pid: ${JSON.stringify(body.pid)}`);

  await expectStatus("unknown route", await fetch(`${base}/api/nope`, { headers: { authorization: basic("opencode", PASSWORD) } }), 404);

  console.log(`dev-smoke: ok (version=${body.version} pid=${body.pid} port=${server.port})`);
} catch (error) {
  console.error(`dev-smoke: FAILED: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await server.stop(true);
}
