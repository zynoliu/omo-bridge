import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertErrorEnvelope, validateResponse } from "../../src/contract/validate";
import {
  getSessionAgent,
  handleAgentList,
  handleCommandList,
  handleFormList,
  handleIntegrationList,
  handleMcpList,
  handleMcpResourceCatalog,
  handleModelList,
  handlePermissionSavedList,
  handlePluginList,
  handleProviderList,
  handleReferenceList,
  handleSessionSwitchAgent,
  handleSessionSwitchModel,
  handleSkillList,
  handleWebsearchProviders,
  resetSessionAgents,
  setCatalogTransport,
  type CatalogCommand,
} from "../../src/http/handlers/catalogs";
import type { SenpiModelInfo, SenpiSelectedModel } from "../../src/senpi/transport";

const WORK_DIR = import.meta.dir;

const MODELS: SenpiModelInfo[] = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4",
    contextWindow: 200_000,
    reasoning: true,
    supportedThinkingLevels: ["low", "medium", "high"],
  },
  { provider: "openai", id: "gpt-5", contextWindow: 400_000, reasoning: false },
];

class FakeCatalogTransport {
  models: SenpiModelInfo[] = [];
  agentDir: string | undefined;
  readonly setModelCalls: Array<{ provider: string; id: string }> = [];
  failure: Error | undefined;

  async getAvailableModels(): Promise<SenpiModelInfo[]> {
    if (this.failure !== undefined) throw this.failure;
    return this.models;
  }

  async setModel(provider: string, id: string): Promise<SenpiSelectedModel> {
    this.setModelCalls.push({ provider, id });
    return { provider, id };
  }
}

class FakeCommandTransport extends FakeCatalogTransport {
  commands: readonly CatalogCommand[] = [];

  async getCommands(): Promise<readonly CatalogCommand[]> {
    return this.commands;
  }
}

function urlOf(path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`http://bridge.test${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function get(path: string, params: Record<string, string> = {}): Request {
  return new Request(urlOf(path, params));
}

function post(path: string, body: unknown): Request {
  return new Request(`http://bridge.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

type Envelope<T> = { location: { directory: string; project: { id: string; directory: string; canonical: string } }; data: T };

beforeEach(() => {
  setCatalogTransport(undefined);
  resetSessionAgents();
});

afterEach(() => {
  setCatalogTransport(undefined);
  resetSessionAgents();
});

describe("handleModelList", () => {
  test("projects senpi models into the catalog shape with the location envelope", async () => {
    setCatalogTransport(Object.assign(new FakeCatalogTransport(), { models: MODELS }));
    const response = await handleModelList(get("/api/model"), urlOf("/api/model", { "location[directory]": WORK_DIR }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = (await response.json()) as Envelope<unknown[]>;
    expect(body.location.directory).toBe(WORK_DIR);
    expect(validateResponse("location.publicInfo", body.location)).toEqual({ ok: true });
    expect(body.data).toEqual([
      {
        id: "claude-sonnet-4",
        modelID: "claude-sonnet-4",
        providerID: "anthropic",
        name: "claude-sonnet-4",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200_000, output: 32_000 },
      },
      {
        id: "gpt-5",
        modelID: "gpt-5",
        providerID: "openai",
        name: "gpt-5",
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        variants: [],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 400_000, output: 32_000 },
      },
    ]);
    for (const item of body.data) expect(validateResponse("model.info", item)).toEqual({ ok: true });
  });

  test("the old contextWindow-shaped item no longer satisfies the model contract", () => {
    const legacy = {
      id: "anthropic/claude-sonnet-4",
      provider: "anthropic",
      name: "claude-sonnet-4",
      contextWindow: 200_000,
      reasoning: true,
    };
    expect(validateResponse("model.info", legacy).ok).toBe(false);
  });

  test("an empty model list stays an empty array", async () => {
    setCatalogTransport(new FakeCatalogTransport());
    const response = await handleModelList(get("/api/model"), urlOf("/api/model"));
    const body = (await response.json()) as Envelope<unknown>;
    expect(response.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  test("answers 503 when no transport is wired", async () => {
    const response = await handleModelList(get("/api/model"), urlOf("/api/model"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body._tag).toBe("ServiceUnavailableError");
    expect(() => assertErrorEnvelope(body)).not.toThrow();
  });

  test("a transport failure becomes a 503 error envelope", async () => {
    const failing = new FakeCatalogTransport();
    failing.failure = new Error("senpi socket closed");
    setCatalogTransport(failing);
    const response = await handleModelList(get("/api/model"), urlOf("/api/model"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body._tag).toBe("ServiceUnavailableError");
    expect(body.message).toContain("senpi socket closed");
  });

  test("an unknown location directory answers 404 FileNotFoundError", async () => {
    setCatalogTransport(new FakeCatalogTransport());
    const missing = join(WORK_DIR, "no-such-directory");
    const response = await handleModelList(get("/api/model"), urlOf("/api/model", { "location[directory]": missing }));
    expect(response.status).toBe(404);
    expect(((await response.json()) as Record<string, unknown>)._tag).toBe("FileNotFoundError");
  });
});

describe("handleProviderList", () => {
  test("dedupes providers from the model list in first-seen order", async () => {
    setCatalogTransport(
      Object.assign(new FakeCatalogTransport(), {
        models: [
          MODELS[0]!,
          MODELS[1]!,
          { ...MODELS[0]!, id: "claude-opus-4", contextWindow: 500_000 },
          { provider: "google", id: "gemini-3", contextWindow: 1_000_000, reasoning: true },
        ],
      }),
    );
    const response = await handleProviderList(get("/api/provider"), urlOf("/api/provider", { "location[directory]": WORK_DIR }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<Array<{ id: string; name: string }>>;
    expect(body.data).toEqual([
      { id: "anthropic", name: "anthropic" },
      { id: "openai", name: "openai" },
      { id: "google", name: "google" },
    ]);
  });

  test("no models means no providers, not null", async () => {
    setCatalogTransport(new FakeCatalogTransport());
    const body = (await (await handleProviderList(get("/api/provider"), urlOf("/api/provider"))).json()) as Envelope<unknown>;
    expect(body.data).toEqual([]);
  });
});

describe("handleIntegrationList", () => {
  let agentDir: string;

  function store(file: string, value: unknown): void {
    writeFileSync(join(agentDir, file), JSON.stringify(value));
  }

  function transportWith(models: SenpiModelInfo[], dir: string | undefined): FakeCatalogTransport {
    return Object.assign(new FakeCatalogTransport(), { models, agentDir: dir });
  }

  const integrations = (body: Envelope<unknown>): Array<Record<string, unknown>> =>
    body.data as Array<Record<string, unknown>>;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "omo-bridge-cred-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("reports the provider the host serves and the store holds a credential for", async () => {
    store("auth.json", { anthropic: { type: "api_key", key: "sk-ant-test-DO-NOT-LEAK" } });
    setCatalogTransport(transportWith(MODELS, agentDir));
    const response = await handleIntegrationList(
      get("/api/integration"),
      urlOf("/api/integration", { "location[directory]": WORK_DIR }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    expect(integrations(body)).toEqual([
      {
        id: "anthropic",
        name: "anthropic",
        methods: [],
        connections: [{ type: "credential", id: "cred_anthropic", label: "API key", method: "key" }],
      },
    ]);
    expect(validateResponse("integration.list", body)).toEqual({ ok: true });
    // Only presence is read from the credential store: no stored key may reach the response.
    expect(JSON.stringify(body)).not.toContain("DO-NOT-LEAK");
  });

  test("keeps a provider out of the list when the store holds no credential for it", async () => {
    store("auth.json", { anthropic: { type: "api_key", key: "sk-ant-test" } });
    setCatalogTransport(transportWith(MODELS, agentDir));
    const body = (await (
      await handleIntegrationList(get("/api/integration"), urlOf("/api/integration"))
    ).json()) as Envelope<unknown>;

    // MODELS also names openai; only the provider with a stored credential is connected.
    expect(integrations(body).map((row) => row.id)).toEqual(["anthropic"]);
  });

  test("reports nothing when the host serves no models even if a credential exists", async () => {
    store("auth.json", { anthropic: { type: "api_key", key: "sk-ant-test" } });
    setCatalogTransport(transportWith([], agentDir));
    const response = await handleIntegrationList(get("/api/integration"), urlOf("/api/integration"));
    const body = (await response.json()) as Envelope<unknown>;

    expect(response.status).toBe(200);
    expect(integrations(body)).toEqual([]);
    expect(validateResponse("integration.list", body)).toEqual({ ok: true });
  });

  test("reports nothing when the store has an entry without key material", async () => {
    store("auth.json", { anthropic: { type: "api_key" } });
    setCatalogTransport(transportWith([MODELS[0]!], agentDir));
    const body = (await (
      await handleIntegrationList(get("/api/integration"), urlOf("/api/integration"))
    ).json()) as Envelope<unknown>;

    expect(integrations(body)).toEqual([]);
  });

  test("reads a pooled credential whose flat fields are empty through its account slot", async () => {
    store("auth.json", {
      anthropic: { type: "api_key", accounts: [{ name: "default", key: "sk-ant-pooled" }] },
    });
    setCatalogTransport(transportWith([MODELS[0]!], agentDir));
    const body = (await (
      await handleIntegrationList(get("/api/integration"), urlOf("/api/integration"))
    ).json()) as Envelope<unknown>;

    expect(integrations(body)[0]!.connections).toEqual([
      { type: "credential", id: "cred_anthropic", label: "API key", method: "key" },
    ]);
  });

  test("names an oauth credential as such and reports nothing without a credential store", async () => {
    store("auth.json", { anthropic: { type: "oauth", access: "at-test", refresh: "rt-test" } });
    setCatalogTransport(transportWith([MODELS[0]!], agentDir));
    const oauth = (await (
      await handleIntegrationList(get("/api/integration"), urlOf("/api/integration"))
    ).json()) as Envelope<unknown>;
    expect(integrations(oauth)[0]!.connections).toEqual([
      { type: "credential", id: "cred_anthropic", label: "OAuth", method: "oauth" },
    ]);

    setCatalogTransport(transportWith([MODELS[0]!], undefined));
    const noStore = (await (
      await handleIntegrationList(get("/api/integration"), urlOf("/api/integration"))
    ).json()) as Envelope<unknown>;
    expect(integrations(noStore)).toEqual([]);
  });
});

describe("handleAgentList", () => {
  test("serves one primary agent the TUI can select without a transport", async () => {
    const response = await handleAgentList(get("/api/agent"), urlOf("/api/agent", { "location[directory]": WORK_DIR }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<Array<Record<string, unknown>>>;
    expect(validateResponse("location.publicInfo", body.location)).toEqual({ ok: true });
    expect(body.data).toHaveLength(1);

    const agent = body.data[0]!;
    expect(agent).toMatchObject({ id: "build", name: "Build", mode: "primary", hidden: false });
    expect(agent.request).toEqual({ settings: {}, headers: {}, body: {} });
    expect(agent.permissions).toEqual([
      { action: "*", resource: "*", effect: "allow" },
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      { action: "read", resource: "*.env.example", effect: "allow" },
    ]);
  });

  test("keeps the agent id and order stable across reads", async () => {
    const first = (await (await handleAgentList(get("/api/agent"), urlOf("/api/agent"))).json()) as Envelope<unknown[]>;
    const second = (await (await handleAgentList(get("/api/agent"), urlOf("/api/agent"))).json()) as Envelope<unknown[]>;
    expect(first.data).toEqual(second.data);
    expect((first.data[0] as { id: string }).id).toBe("build");
  });
});

describe("empty catalogs", () => {
  const listHandlers: Array<[string, (request: Request, url: URL) => Promise<Response>]> = [
    ["/api/skill", handleSkillList],
    ["/api/reference", handleReferenceList],
    ["/api/mcp", handleMcpList],
    ["/api/integration", handleIntegrationList],
    ["/api/websearch/provider", handleWebsearchProviders],
    ["/api/permission/saved", handlePermissionSavedList],
    ["/api/plugin", handlePluginList],
    ["/api/form", handleFormList],
    ["/api/command", handleCommandList],
  ];

  for (const [path, handler] of listHandlers) {
    test(`${path} answers an empty array`, async () => {
      const response = await handler(get(path), urlOf(path, { "location[directory]": WORK_DIR }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Envelope<unknown>;
      expect(body.data).toEqual([]);
      expect(validateResponse("location.publicInfo", body.location)).toEqual({ ok: true });
    });
  }

  test("/api/mcp/resource answers an Mcp.ResourceCatalog, not a bare list", async () => {
    const response = await handleMcpResourceCatalog(
      get("/api/mcp/resource"),
      urlOf("/api/mcp/resource", { "location[directory]": WORK_DIR }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<{ resources: unknown[]; templates: unknown[] }>;
    expect(body.data).toEqual({ resources: [], templates: [] });
  });

  test("/api/plugin answers the empty plugin.list envelope the TUI reads at startup", async () => {
    const response = await handlePluginList(get("/api/plugin"), urlOf("/api/plugin", { "location[directory]": WORK_DIR }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown[]>;
    expect(body.data).toEqual([]);
    expect(validateResponse("plugin.list", body)).toEqual({ ok: true });
  });
});

describe("handleCommandList", () => {
  test("maps the senpi command surface and omits an absent description", async () => {
    const transport = new FakeCommandTransport();
    transport.commands = [
      { name: "compact", description: "Compact the session" },
      { name: "init" },
    ];
    setCatalogTransport(transport);
    const response = await handleCommandList(get("/api/command"), urlOf("/api/command", { "location[directory]": WORK_DIR }));
    const body = (await response.json()) as Envelope<CatalogCommand[]>;
    expect(body.data).toEqual([{ name: "compact", description: "Compact the session" }, { name: "init" }]);
    expect(body.data[1]).not.toHaveProperty("description");
  });

  test("a transport without a command surface answers an empty array", async () => {
    setCatalogTransport(Object.assign(new FakeCatalogTransport(), { models: MODELS }));
    const body = (await (await handleCommandList(get("/api/command"), urlOf("/api/command"))).json()) as Envelope<unknown>;
    expect(body.data).toEqual([]);
  });
});

describe("handleSessionSwitchModel", () => {
  test("calls setModel with the TUI's nested Model.Ref and answers 204", async () => {
    const transport = new FakeCatalogTransport();
    setCatalogTransport(transport);
    const response = await handleSessionSwitchModel(
      post("/api/session/ses-1/model", { model: { providerID: "anthropic", id: "claude-sonnet-4" } }),
      urlOf("/api/session/ses-1/model"),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(transport.setModelCalls).toEqual([{ provider: "anthropic", id: "claude-sonnet-4" }]);
  });

  test("accepts a flat provider/id body", async () => {
    const transport = new FakeCatalogTransport();
    setCatalogTransport(transport);
    const response = await handleSessionSwitchModel(
      post("/api/session/ses-1/model", { provider: "openai", id: "gpt-5" }),
      urlOf("/api/session/ses-1/model"),
    );
    expect(response.status).toBe(204);
    expect(transport.setModelCalls).toEqual([{ provider: "openai", id: "gpt-5" }]);
  });

  test("rejects an incomplete selection before touching the transport", async () => {
    const transport = new FakeCatalogTransport();
    setCatalogTransport(transport);
    const response = await handleSessionSwitchModel(
      post("/api/session/ses-1/model", { model: { provider: "anthropic" } }),
      urlOf("/api/session/ses-1/model"),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)._tag).toBe("InvalidRequestError");
    expect(transport.setModelCalls).toEqual([]);
  });

  test("answers 503 without a transport", async () => {
    const response = await handleSessionSwitchModel(
      post("/api/session/ses-1/model", { provider: "openai", id: "gpt-5" }),
      urlOf("/api/session/ses-1/model"),
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>)._tag).toBe("ServiceUnavailableError");
  });
});

describe("handleSessionSwitchAgent", () => {
  test("records the agent and answers a no-op 204", async () => {
    const transport = new FakeCatalogTransport();
    setCatalogTransport(transport);
    const response = await handleSessionSwitchAgent(
      post("/api/session/ses-1/agent", { agent: "build" }),
      urlOf("/api/session/ses-1/agent"),
    );
    expect(response.status).toBe(204);
    expect(getSessionAgent("ses-1")).toBe("build");
    expect(transport.setModelCalls).toEqual([]);
  });

  test("requires an agent name", async () => {
    const response = await handleSessionSwitchAgent(post("/api/session/ses-1/agent", {}), urlOf("/api/session/ses-1/agent"));
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>)._tag).toBe("InvalidRequestError");
  });

  test("requires a session id in the path", async () => {
    const response = await handleSessionSwitchAgent(post("/api/agent", { agent: "build" }), urlOf("/api/agent"));
    expect(response.status).toBe(400);
  });

  test("works without a transport because nothing goes on the wire", async () => {
    const response = await handleSessionSwitchAgent(
      post("/api/session/ses-2/agent", { agent: "plan" }),
      urlOf("/api/session/ses-2/agent"),
    );
    expect(response.status).toBe(204);
    expect(getSessionAgent("ses-2")).toBe("plan");
  });
});
