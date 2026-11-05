import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config";
import { validateResponse } from "../../src/contract/validate";
import { setCatalogTransport } from "../../src/http/handlers/catalogs";
import { BASIC_USERNAME, createServer, type BridgeServer } from "../../src/http/server";
import type { SenpiModelInfo, SenpiSelectedModel } from "../../src/senpi/transport";

// The integration list is what flips the TUI's model picker and `/connect` dialog from their empty
// state (`packages/tui/src/util/connected-provider.ts` reads `connections.length > 0`). These tests
// mount the real router so the route, the handler and the location envelope are exercised together.

const PASSWORD = "integration-password";
const PROVIDER = "opencode-go";

const MODELS: SenpiModelInfo[] = [
  { provider: PROVIDER, id: "deepseek-v4.1-flash", contextWindow: 128_000, reasoning: false },
];

class FakeCatalogTransport {
  models: SenpiModelInfo[] = [];
  agentDir: string | undefined;

  async getAvailableModels(): Promise<SenpiModelInfo[]> {
    return this.models;
  }

  async setModel(provider: string, id: string): Promise<SenpiSelectedModel> {
    return { provider, id } as SenpiSelectedModel;
  }
}

let server!: BridgeServer;
let base!: string;
let root!: string;
let workdir!: string;
let agentDir!: string;
const transport = new FakeCatalogTransport();

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

function integrationUrl(): string {
  return `${base}/api/integration?location%5Bdirectory%5D=${encodeURIComponent(workdir)}`;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "omo-bridge-integration-"));
  workdir = join(root, "work");
  agentDir = join(root, "agent");
  mkdirSync(workdir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ [PROVIDER]: { type: "api_key", key: "sk-live-DO-NOT-LEAK" } }));

  transport.models = [...MODELS];
  transport.agentDir = agentDir;
  setCatalogTransport(transport);

  server = createServer(
    resolveConfig({ OMO_BRIDGE_PORT: "0", OMO_BRIDGE_PASSWORD: PASSWORD, OMO_BRIDGE_STATE_DIR: join(root, "state") }),
  );
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop(true);
  setCatalogTransport(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("mounted integration route", () => {
  test("GET /api/integration reports a connection when the transport reports models", async () => {
    const response = await fetch(integrationUrl(), { headers: auth() });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Array<{ id: string; connections: unknown[] }> };

    expect(validateResponse("integration.list", body)).toEqual({ ok: true });
    expect(body.data.map((row) => row.id)).toEqual([PROVIDER]);
    // The predicate the TUI applies: `integrations.some(i => i.connections.length > 0)`.
    expect(body.data[0]!.connections).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("DO-NOT-LEAK");
  });

  test("GET /api/integration reports none when the host reports no models", async () => {
    transport.models = [];
    try {
      const response = await fetch(integrationUrl(), { headers: auth() });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: unknown[] };
      expect(body.data).toEqual([]);
      expect(validateResponse("integration.list", body)).toEqual({ ok: true });
    } finally {
      transport.models = [...MODELS];
    }
  });

  test("the connect and credential writes still answer their declared errors", async () => {
    const key = await fetch(`${base}/api/integration/${PROVIDER}/connect/key`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ integrationID: PROVIDER, key: "sk-ignored" }),
    });
    expect(key.status).toBe(409);
    expect(((await key.json()) as Record<string, unknown>)._tag).toBe("IntegrationNotFoundError");

    const oauth = await fetch(`${base}/api/integration/${PROVIDER}/connect/oauth`, {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ integrationID: PROVIDER, methodID: "oauth" }),
    });
    expect(oauth.status).toBe(404);
    expect(((await oauth.json()) as Record<string, unknown>)._tag).toBe("IntegrationAttemptNotFoundError");

    const credential = await fetch(`${base}/api/credential/cred_${PROVIDER}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(credential.status).toBe(409);
    expect(((await credential.json()) as Record<string, unknown>)._tag).toBe("InvalidRequestError");
  });
});
