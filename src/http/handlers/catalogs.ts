import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { validateResponse } from "../../contract/validate";
import { storedCredentialMethod } from "../../senpi/credentials";
import type { SenpiModelInfo, SenpiTransport } from "../../senpi/transport";
import { locationRef, type LocationPublicRef } from "./fs-location";
import { listMcpServers } from "./mcp-config";
import { listSavedPermissions } from "./permission";
import { HandlerProblem, jsonResponse, noContent, respond } from "./problem";
import { attachSessionTarget, getSessionManagementTransport, requireKnownSession } from "./session-write";

// Catalog endpoints answer the TUI's startup reads (model, provider, agent, command, skill, ...).
// Like the session handlers they take (request, url) and read the transport from a module-level seam,
// so the http layer owns no connection and route mounting stays an independent change.
//
// senpi only reports a model list and a model selection. Every other catalog has no senpi capability
// yet; those handlers answer an empty, schema-valid list instead of 404 so the TUI never sees a
// missing endpoint. Catalog items keep the shape the TUI expects from its model/provider endpoints.

// Model.Info.default / Model.Capabilities.default values the bridge fills in for what senpi does not report.
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_OUTPUT_LIMIT = 32_000;

/** Shape of the slash-command surface senpi reports (`RpcSlashCommand` keeps more source detail). */
export type CatalogCommand = {
  name: string;
  description?: string;
  /** `RpcSlashCommand.sourceInfo`: the file backing the command, e.g. a skill's SKILL.md. */
  sourceInfo?: { path?: string };
};

/** One row of GET /api/skill: the TUI decodes it as `Skill.Info` (`packages/schema/src/skill.ts`). */
export type CatalogSkill = {
  id: string;
  name: string;
  description?: string;
  path: string;
  content: string;
};

/** senpi names a skill command `skill:<name>` on the slash-command surface. */
const SKILL_COMMAND_PREFIX = "skill:";

export type CatalogTransport = Pick<SenpiTransport, "getAvailableModels" | "setModel"> & {
  getCommands?: () => Promise<readonly CatalogCommand[]>;
  /**
   * The agent directory whose `auth.json` backs the host's providers. A caller without one can report
   * models but not credentials, so the integration list stays empty for it.
   */
  readonly agentDir?: string;
};

/** One row of GET /api/model: the TUI decodes it as `Model.Info` (`packages/schema/src/model.ts`). */
export type CatalogModel = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: unknown[];
  time: { released: number };
  cost: unknown[];
  status: "alpha" | "beta" | "deprecated" | "active";
  enabled: boolean;
  limit: { context: number; output: number };
};

export type CatalogProvider = { id: string; name: string };

/** One connection row of `Integration.Info` (`packages/schema/src/connection.ts`). */
export type CatalogCredentialConnection = {
  type: "credential";
  id: string;
  label: string;
  method: "key" | "oauth";
};

/**
 * One row of GET /api/integration: the TUI decodes it as `Integration.Info`
 * (`packages/schema/src/integration.ts`). `methods` is always empty on purpose: senpi exposes no
 * connect flow the bridge could honor, so offering a method would promise an action that must fail.
 * The connect routes keep their declared errors; only this listing is backed by real state.
 */
export type CatalogIntegration = {
  id: string;
  name: string;
  methods: [];
  connections: CatalogCredentialConnection[];
};

/** One row of GET /api/agent: the TUI decodes it as `Agent.Info` (`packages/schema/src/agent.ts`). */
export type CatalogAgent = {
  id: string;
  name: string;
  request: { settings: Record<string, unknown>; headers: Record<string, string>; body: Record<string, unknown> };
  description: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  permissions: Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }>;
};

// The TUI cannot submit a prompt while `local.agent.current()` is null, so the bridge always serves
// one primary agent. senpi has no agent registry; this row is the projection the next turn's prompt
// options use, and it is a constant so repeated reads agree.
const DEFAULT_AGENT: CatalogAgent = {
  id: "build",
  name: "Build",
  request: { settings: {}, headers: {}, body: {} },
  description: "Default agent for bridge sessions",
  mode: "primary",
  hidden: false,
  permissions: [
    { action: "*", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
  ],
};

let transport: CatalogTransport | undefined;

export function setCatalogTransport(next: CatalogTransport | undefined): void {
  transport = next;
}

export function getCatalogTransport(): CatalogTransport | undefined {
  return transport;
}

// Agents are a bridge-side projection: senpi has no per-session agent switch, so the selection is
// remembered here for the next turn and nothing is sent over the wire.
const selectedAgents = new Map<string, string>();

export function getSessionAgent(sessionID: string): string | undefined {
  return selectedAgents.get(sessionID);
}

export function resetSessionAgents(): void {
  selectedAgents.clear();
}

function requireTransport(): CatalogTransport {
  if (transport === undefined) {
    throw new HandlerProblem(503, "ServiceUnavailableError", "no senpi transport is wired into the http layer", {
      service: "senpi",
    });
  }
  return transport;
}

function invalidRequest(message: string, field: string): HandlerProblem {
  return new HandlerProblem(400, "InvalidRequestError", message, { field });
}

function requestedDirectory(url: URL): string {
  const raw = url.searchParams.get("location[directory]")?.trim();
  if (raw === undefined || raw.length === 0) return process.cwd();
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

function locationFor(url: URL): LocationPublicRef {
  const directory = requestedDirectory(url);
  let stats;
  try {
    stats = statSync(directory);
  } catch {
    throw new HandlerProblem(404, "FileNotFoundError", `directory not found: ${directory}`, { directory });
  }
  if (!stats.isDirectory()) {
    throw new HandlerProblem(400, "InvalidRequestError", `not a directory: ${directory}`, { directory });
  }
  return locationRef(directory);
}

function publicModel(model: SenpiModelInfo): CatalogModel {
  return {
    id: model.id,
    modelID: model.id,
    providerID: model.provider,
    name: model.id,
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.contextWindow ?? DEFAULT_CONTEXT_LIMIT, output: DEFAULT_OUTPUT_LIMIT },
  };
}

function publicCommand(command: CatalogCommand): CatalogCommand {
  return {
    name: command.name,
    ...(command.description === undefined ? {} : { description: command.description }),
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) throw invalidRequest("request body is required", "body");
  try {
    return JSON.parse(text);
  } catch {
    throw invalidRequest("request body must be JSON", "body");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function pathSegments(url: URL): string[] {
  return url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));
}

function sessionIdFromPath(url: URL): string {
  const segments = pathSegments(url);
  const at = segments.indexOf("session");
  const sessionID = at >= 0 ? segments[at + 1] : undefined;
  if (sessionID === undefined || sessionID.length === 0) {
    throw invalidRequest(`no session id in path ${url.pathname}`, "sessionID");
  }
  return sessionID;
}

function requireModelList(caller: CatalogTransport): Promise<SenpiModelInfo[]> {
  return caller.getAvailableModels();
}

export async function handleModelList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const data = (await requireModelList(requireTransport())).map(publicModel);
    // A row the TUI could not decode is a bridge bug: fail loudly instead of emitting an invalid body.
    for (const item of data) {
      const result = validateResponse("model.info", item);
      if (!result.ok) {
        throw new HandlerProblem(500, "InternalError", `model ${item.id} is not a Model.Info`, {
          errors: result.errors,
        });
      }
    }
    return jsonResponse(200, { location: locationFor(url), data });
  });
}

export async function handleProviderList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const models = await requireModelList(requireTransport());
    const seen = new Set<string>();
    const data: CatalogProvider[] = [];
    for (const model of models) {
      if (seen.has(model.provider)) continue;
      seen.add(model.provider);
      data.push({ id: model.provider, name: model.provider });
    }
    return jsonResponse(200, { location: locationFor(url), data });
  });
}

export async function handleAgentList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    // A fresh array per read keeps callers from mutating the shared row, while the id and order stay stable.
    return jsonResponse(200, { location: locationFor(url), data: [{ ...DEFAULT_AGENT }] });
  });
}

export async function handleCommandList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = transport;
    const listed = caller?.getCommands === undefined ? [] : await caller.getCommands();
    return jsonResponse(200, { location: locationFor(url), data: listed.map(publicCommand) });
  });
}

function publicSkill(command: CatalogCommand): CatalogSkill {
  const name = command.name.slice(SKILL_COMMAND_PREFIX.length);
  return {
    id: name,
    name,
    ...(command.description === undefined ? {} : { description: command.description }),
    // The surface names the skill's file, not its body: an invocation loads the body host-side, and
    // `skill://<id>/SKILL.md` is the URI upstream uses for a skill the surface carries no file for.
    path: command.sourceInfo?.path ?? `skill://${name}/SKILL.md`,
    content: "",
  };
}

export async function handleSkillList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    // Skills are the command surface's `skill:` namespace: one read path instead of a second registry.
    const caller = transport;
    const listed = caller?.getCommands === undefined ? [] : await caller.getCommands();
    const data = listed
      .filter((command) => command.name.length > SKILL_COMMAND_PREFIX.length && command.name.startsWith(SKILL_COMMAND_PREFIX))
      .map(publicSkill);
    return jsonResponse(200, { location: locationFor(url), data });
  });
}

export async function handleReferenceList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

export async function handleMcpList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const location = locationFor(url);
    const agentDir = transport?.agentDir;
    // A caller without an agent directory has no configuration to report; the empty list is the
    // truthful answer here, not an outage.
    if (agentDir === undefined) return jsonResponse(200, { location, data: [] });
    return jsonResponse(200, { location, data: listMcpServers(agentDir, location.directory) });
  });
}

export async function handleMcpResourceCatalog(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    // `/api/mcp/resource` answers an Mcp.ResourceCatalog, not a list: the TUI reads `data.resources`.
    return jsonResponse(200, { location: locationFor(url), data: { resources: [], templates: [] } });
  });
}

/**
 * A provider is connected when the host reports at least one model for it AND the agent directory's
 * credential store holds key material for it. Both halves come from real state: the model list is the
 * host's own catalog, the credential store is the file the host signs in with. A provider missing
 * either half is not reported as connected, so `/models` legitimately stays on its connect view.
 */
function connectedIntegrations(models: readonly SenpiModelInfo[], agentDir: string): CatalogIntegration[] {
  const providerIDs = new Set<string>();
  for (const model of models) {
    if (model.provider.length > 0) providerIDs.add(model.provider);
  }
  const integrations: CatalogIntegration[] = [];
  for (const providerID of providerIDs) {
    const method = storedCredentialMethod(agentDir, providerID);
    if (method === undefined) continue;
    integrations.push({
      id: providerID,
      name: providerID,
      methods: [],
      connections: [
        {
          type: "credential",
          id: `cred_${providerID}`,
          label: method === "key" ? "API key" : "OAuth",
          method,
        },
      ],
    });
  }
  return integrations;
}

export async function handleIntegrationList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const location = locationFor(url);
    const caller = transport;
    if (caller === undefined) return jsonResponse(200, { location, data: [] });
    const agentDir = caller.agentDir;
    if (agentDir === undefined) return jsonResponse(200, { location, data: [] });
    const models = await requireModelList(caller);
    const body = { location, data: connectedIntegrations(models, agentDir) };
    // The TUI decodes this body as Integration.Info rows; a row it could not decode is a bridge bug,
    // so fail loudly instead of answering a body the client would reject mid-startup.
    const result = validateResponse("integration.list", body);
    if (!result.ok) {
      throw new HandlerProblem(500, "InternalError", "the integration list is not an integration.list", {
        errors: result.errors,
      });
    }
    return jsonResponse(200, body);
  });
}

// `plugin.list` declares `Location.response(Schema.Array(Plugin.Info))`
// (`packages/protocol/src/groups/plugin.ts:12`), which the TUI reads as `{location, data}`
// (`packages/tui/src/plugin/context.tsx:540`). senpi has no plugin registry and the bridge loads no
// server plugins, so the empty inventory is the truthful answer rather than a missing route.
export async function handlePluginList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

// `plugin.check` re-reads the same inventory: the bridge loads no server plugins, so there is no
// package source to re-check and the truthful answer is the empty list `plugin.list` serves.
export async function handlePluginCheck(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

// `model.default` declares `Location.response(Schema.UndefinedOr(Model.Info))`: the host reports no
// default model, so the body carries the location and no `data`. The TUI falls back when it is absent.
export async function handleModelDefault(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => jsonResponse(200, { location: locationFor(url) }));
}

export async function handleWebsearchProviders(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

export async function handlePermissionSavedList(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    // Saved rules are real bridge state: an "always" reply records them in permission.ts.
    const sessionID = url.searchParams.get("sessionID")?.trim();
    const data = listSavedPermissions(sessionID === undefined || sessionID.length === 0 ? undefined : sessionID);
    return jsonResponse(200, { location: locationFor(url), data });
  });
}

// Pending forms live in form.ts; re-exported so the catalog surface keeps its single import site.
export { handleFormList } from "./form";

// `Model.Ref` (`packages/schema/src/model.ts`) names the provider `providerID`; senpi's own frames call
// it `provider`. Accept both spellings so the TUI's switchModel payload reaches `setModel` unchanged.
function modelSelection(body: unknown): { provider: string; id: string } {
  const record = asRecord(body);
  if (record === undefined) throw invalidRequest("model selection must be an object", "model");
  const nested = asRecord(record.model);
  const source = nested ?? record;
  const provider = asTrimmed(source.providerID) ?? asTrimmed(source.provider);
  const id = asTrimmed(source.id) ?? asTrimmed(source.modelID);
  if (provider === undefined) throw invalidRequest("model.providerID is required", "providerID");
  if (id === undefined) throw invalidRequest("model.id is required", "id");
  return { provider, id };
}

export async function handleSessionSwitchModel(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const caller = requireTransport();
    const selection = modelSelection(await readJsonBody(request));
    // setModel applies to the transport's open session; a switch for any other session must attach
    // it first or the selection lands in the wrong transcript.
    const management = getSessionManagementTransport();
    if (management !== undefined) await attachSessionTarget(management, sessionIdFromPath(url));
    // The selected-model event is emitted by the event pipeline from senpi's own state change.
    await caller.setModel(selection.provider, selection.id);
    return noContent();
  });
}

function agentSelection(body: unknown): string {
  const record = asRecord(body);
  if (record === undefined) throw invalidRequest("agent selection must be an object", "body");
  const agent = asTrimmed(record.agent);
  if (agent === undefined) throw invalidRequest("agent is required", "agent");
  return agent;
}

export async function handleSessionSwitchAgent(request: Request, url: URL): Promise<Response> {
  return respond(url, async () => {
    const sessionID = sessionIdFromPath(url);
    await requireKnownSession(sessionID);
    const agent = agentSelection(await readJsonBody(request));
    // senpi has no agent switch and no agent registry: the selection is recorded here so the next
    // turn's prompt options can apply it. Answering 204 keeps the TUI's switch flow working.
    selectedAgents.set(sessionID, agent);
    return noContent();
  });
}
