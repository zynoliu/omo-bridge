import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../../src/config";
import { createServer, type BridgeServer } from "../../src/http/server";
import { setSessionReadTransport } from "../../src/http/handlers/sessions";
import { setSessionWriteTransport } from "../../src/http/handlers/prompt";
import { setSessionManagementStore, setSessionManagementTransport, sessionManagementStore } from "../../src/http/handlers/session-write";
import { setCatalogTransport } from "../../src/http/handlers/catalogs";
import { SessionMap } from "../../src/model/session-map";

// Drives the bridge with the real my-tui client instead of hand-written fetch calls: a wrong envelope,
// a wrong status or an ignored request field fails here rather than in the user's terminal. Skipped
// unless OMO_BRIDGE_E2E_TUI_DIR names the fork checkout, so a fresh clone still passes.

const tuiDir = process.env.OMO_BRIDGE_E2E_TUI_DIR?.trim();
const clientEntry = tuiDir === undefined ? undefined : join(tuiDir, "packages/client/src/promise/index.ts");
const available = clientEntry !== undefined && existsSync(clientEntry);
const PASSWORD = "e2e-password";
const WORK_DIR = "/tmp";

type PromiseClient = {
  session: {
    create(input?: { id?: string; title?: string; location?: { directory: string } }): Promise<{ id: string }>;
    get(input: { sessionID: string }): Promise<{ id: string; location?: { directory?: string } }>;
    switchModel(input: { sessionID: string; model: { providerID: string; id: string } }): Promise<unknown>;
    messages(input: { sessionID: string; limit?: number; order?: "asc" | "desc" }): Promise<{
      data: Array<{ id: string; type: string; text?: string }>;
      cursor: { next?: string; previous?: string };
    }>;
  };
  message: {
    list(input: { sessionID: string; limit?: number; order?: "asc" | "desc" }): Promise<{
      data: Array<{ id: string; type: string; text?: string }>;
      cursor: { next?: string; previous?: string };
    }>;
  };
  location: { get(input?: { location?: { directory: string } }): Promise<{ directory?: string }> };
  integration: { list(input?: { location?: { directory: string } }): Promise<{ data: Array<{ connections: unknown[] }> }> };
};

let server: BridgeServer;
let base: string;
let client: PromiseClient;
let transport: Record<string, unknown>;
let agentDir: string;

function rows(): Array<Record<string, unknown>> {
  return [
    { sessionId: "rpc-e2e", durableSessionId: "durable-e2e", cwd: WORK_DIR, sessionPath: join(WORK_DIR, "e2e.jsonl") },
  ];
}

beforeAll(async () => {
  server = createServer(resolveConfig({ OMO_BRIDGE_PORT: "0", OMO_BRIDGE_PASSWORD: PASSWORD }));
  base = `http://127.0.0.1:${server.port}`;
  if (!available) return;
  const { OpenCode } = await import(clientEntry as string);
  client = OpenCode.make({
    baseUrl: base,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${PASSWORD}`, "utf8").toString("base64")}` },
  }) as PromiseClient;
});

afterAll(async () => {
  await server.stop(true);
});

describe.skipIf(!available)("the real my-tui client against the bridge", () => {
  beforeAll(() => {
    agentDir = mkdtempSync(join(tmpdir(), "e2e-agent-"));
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api_key", key: "sk-e2e" } }));
    let attached: string | undefined;
    transport = {
      listSessions: async () => rows(),
      getState: async () => ({ sessionId: "rpc-e2e", isStreaming: false, lifecycle: "idle" }),
      getEntries: async () => ({ entries: [], cursor: undefined }),
      getMessages: async () => [],
      openSession: async () => {
        attached = "rpc-e2e";
        (transport as { sessionId?: string }).sessionId = attached;
        return { sessionId: "rpc-e2e" };
      },
      getAvailableModels: async () => [
        { provider: "opencode-go", id: "deepseek-v4.1-flash", contextWindow: 100000, reasoning: false },
      ],
      setModel: async () => undefined,
      getCommands: async () => [],
      setSessionName: async () => undefined,
      agentDir,
    };
    setSessionReadTransport(transport as never);
    setSessionWriteTransport(transport as never);
    setSessionManagementTransport(transport as never);
    setCatalogTransport(transport as never);
    setSessionManagementStore(sessionManagementStore(SessionMap.open({ stateDir: mkdtempSync(join(tmpdir(), "e2e-map-")), agentDir: tmpdir() })));
  });

  test("a session created with a client-minted id answers every later call", async () => {
    const created = await client.session.create({ id: "ses_01hxe2e", title: "E2E", location: { directory: WORK_DIR } });
    expect(created.id).toBe("ses_01hxe2e");

    const fetched = await client.session.get({ sessionID: "ses_01hxe2e" });
    expect(fetched.id).toBe("ses_01hxe2e");

    await expect(
      client.session.switchModel({ sessionID: "ses_01hxe2e", model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" } }),
    ).resolves.toBeUndefined();

    const messages = await client.message.list({ sessionID: "ses_01hxe2e", order: "desc" });
    expect(Array.isArray(messages.data)).toBe(true);
  });

  test("location.get parses as a bare location", async () => {
    const location = await client.location.get({ location: { directory: WORK_DIR } });
    expect(location.directory).toBe(WORK_DIR);
  });

  test("integration.list reports a connected provider the client predicate accepts", async () => {
    const integrations = await client.integration.list({ location: { directory: WORK_DIR } });
    expect(integrations.data.some((integration) => integration.connections.length > 0)).toBe(true);
  });
});
