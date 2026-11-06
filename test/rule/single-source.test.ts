import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleCommandList,
  handleIntegrationList,
  handleSkillList,
  resetSessionAgents,
  setCatalogTransport,
  type CatalogCommand,
  type CatalogTransport,
} from "../../src/http/handlers/catalogs";
import type { SenpiModelInfo, SenpiSelectedModel } from "../../src/senpi/transport";

// Same data read two ways must come out equal. These are rule tests, not route tests: they fail when
// a handler starts serving a second, diverging copy of a dataset the bridge already reads elsewhere.

const WORK_DIR = import.meta.dir;

const MODEL: SenpiModelInfo = {
  provider: "anthropic",
  id: "claude-sonnet-4",
  contextWindow: 200_000,
  reasoning: true,
};

/** senpi reports a skill as a slash command named `skill:<name>` (`rpc-command-surface.ts`). */
const SKILL_NAMESPACE = "skill:";

const SKILL_COMMANDS: CatalogCommand[] = ["pdf", "bun", "debugging", "refactor", "writing"].map((name) => ({
  name: `${SKILL_NAMESPACE}${name}`,
  description: `${name} skill`,
}));

class FakeCatalogTransport implements CatalogTransport {
  constructor(
    readonly commands: readonly CatalogCommand[] = [],
    readonly models: SenpiModelInfo[] = [],
    readonly agentDir?: string,
  ) {}

  async getAvailableModels(): Promise<SenpiModelInfo[]> {
    return this.models;
  }

  async setModel(provider: string, id: string): Promise<SenpiSelectedModel> {
    return { provider, id };
  }

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

type Envelope<T> = {
  location: { directory: string };
  data: T;
};

describe("one data source per read path", () => {
  beforeEach(() => {
    setCatalogTransport(undefined);
    resetSessionAgents();
  });

  afterEach(() => {
    setCatalogTransport(undefined);
  });

  test("the skill list is the skill namespace of the command surface", async () => {
    setCatalogTransport(new FakeCatalogTransport(SKILL_COMMANDS));

    const commands = (await (
      await handleCommandList(get("/api/command"), urlOf("/api/command"))
    ).json()) as Envelope<CatalogCommand[]>;
    const onCommandSurface = commands.data
      .map((command) => command.name)
      .filter((name) => name.startsWith(SKILL_NAMESPACE))
      .map((name) => name.slice(SKILL_NAMESPACE.length))
      .sort();

    const skills = (await (await handleSkillList(get("/api/skill"), urlOf("/api/skill"))).json()) as Envelope<
      Array<{ id: string; name: string }>
    >;
    const onSkillEndpoint = skills.data.map((skill) => skill.name).sort();

    // The fixture must carry skills, otherwise equality would hold for the trivial two-empty case.
    expect(onCommandSurface).toEqual(["bun", "debugging", "pdf", "refactor", "writing"]);
    expect(onSkillEndpoint).toEqual(onCommandSurface);
  });

  test("the integration data does not depend on which location asked for it", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omo-bridge-single-source-"));
    try {
      writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-test" } }));
      setCatalogTransport(new FakeCatalogTransport([], [MODEL], agentDir));

      const read = async (params: Record<string, string>): Promise<Envelope<unknown[]>> =>
        (await (await handleIntegrationList(get("/api/integration", params), urlOf("/api/integration", params))).json()) as Envelope<
          unknown[]
        >;

      const explicit = await read({ "location[directory]": WORK_DIR });
      const other = await read({ "location[directory]": join(WORK_DIR, "..", "..") });
      const fallback = await read({});

      // A non-empty row keeps equality meaningful: two empty lists would satisfy any mutation.
      expect(explicit.data).toHaveLength(1);
      expect(explicit.data).toEqual(fallback.data);
      expect(explicit.data).toEqual(other.data);
      // Only the envelope may answer the caller's location; the dataset itself is location-independent.
      expect(explicit.location.directory).toBe(WORK_DIR);
      expect(explicit.location.directory).not.toBe(fallback.location.directory);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
