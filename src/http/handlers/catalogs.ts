import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { validateResponse } from "../../contract/validate";
import type { SenpiModelInfo, SenpiTransport } from "../../senpi/transport";
import { locationInfo, type LocationPublicInfo } from "./fs-location";
import { listSavedPermissions } from "./permission";

// Catalog endpoints answer the TUI's startup reads (model, provider, agent, command, skill, ...).
// Like the session handlers they take (request, url) and read the transport from a module-level seam,
// so the http layer owns no connection and route mounting stays an independent change.
//
// senpi only reports a model list and a model selection. Every other catalog has no senpi capability
// yet; those handlers answer an empty, schema-valid list instead of 404 so the TUI never sees a
// missing endpoint. Catalog items keep the shape the TUI expects from its model/provider endpoints.

const JSON_CONTENT_TYPE = "application/json";
// Model.Info.default / Model.Capabilities.default values the bridge fills in for what senpi does not report.
const DEFAULT_CONTEXT_LIMIT = 200_000;
const DEFAULT_OUTPUT_LIMIT = 32_000;

/** Shape of the slash-command surface senpi reports (`RpcSlashCommand` keeps more source detail). */
export type CatalogCommand = { name: string; description?: string };

export type CatalogTransport = Pick<SenpiTransport, "getAvailableModels" | "setModel"> & {
  getCommands?: () => Promise<readonly CatalogCommand[]>;
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

class HandlerProblem extends Error {
  readonly status: number;
  readonly tag: string;
  readonly fields: Record<string, unknown>;

  constructor(status: number, tag: string, message: string, fields: Record<string, unknown> = {}) {
    super(message);
    this.name = "HandlerProblem";
    this.status = status;
    this.tag = tag;
    this.fields = fields;
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

function errorResponse(status: number, tag: string, message: string, fields: Record<string, unknown> = {}): Response {
  return jsonResponse(status, { _tag: tag, message, ...fields });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function respond(operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HandlerProblem) return errorResponse(error.status, error.tag, error.message, error.fields);
    return errorResponse(503, "ServiceUnavailableError", messageOf(error), { service: "senpi" });
  }
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

function locationFor(url: URL): LocationPublicInfo {
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
  return locationInfo(directory);
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
  return respond(async () => {
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
  return respond(async () => {
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
  return respond(async () => {
    // A fresh array per read keeps callers from mutating the shared row, while the id and order stay stable.
    return jsonResponse(200, { location: locationFor(url), data: [{ ...DEFAULT_AGENT }] });
  });
}

export async function handleCommandList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    const caller = transport;
    const listed = caller?.getCommands === undefined ? [] : await caller.getCommands();
    return jsonResponse(200, { location: locationFor(url), data: listed.map(publicCommand) });
  });
}

export async function handleSkillList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

export async function handleReferenceList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

export async function handleMcpList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

export async function handleMcpResourceCatalog(_request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    // `/api/mcp/resource` answers an Mcp.ResourceCatalog, not a list: the TUI reads `data.resources`.
    return jsonResponse(200, { location: locationFor(url), data: { resources: [], templates: [] } });
  });
}

export async function handleIntegrationList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

export async function handleWebsearchProviders(_request: Request, url: URL): Promise<Response> {
  return respond(async () => jsonResponse(200, { location: locationFor(url), data: [] }));
}

export async function handlePermissionSavedList(_request: Request, url: URL): Promise<Response> {
  return respond(async () => {
    // Saved rules are real bridge state: an "always" reply records them in permission.ts.
    const sessionID = url.searchParams.get("sessionID")?.trim();
    const data = listSavedPermissions(sessionID === undefined || sessionID.length === 0 ? undefined : sessionID);
    return jsonResponse(200, { location: locationFor(url), data });
  });
}

// Pending forms live in form.ts; re-exported so the catalog surface keeps its single import site.
export { handleFormList } from "./form";

function modelSelection(body: unknown): { provider: string; id: string } {
  const record = asRecord(body);
  if (record === undefined) throw invalidRequest("model selection must be an object", "model");
  const nested = asRecord(record.model);
  const source = nested ?? record;
  const provider = asTrimmed(source.provider);
  const id = asTrimmed(source.id);
  if (provider === undefined) throw invalidRequest("model.provider is required", "provider");
  if (id === undefined) throw invalidRequest("model.id is required", "id");
  return { provider, id };
}

export async function handleSessionSwitchModel(request: Request, _url: URL): Promise<Response> {
  return respond(async () => {
    const caller = requireTransport();
    const selection = modelSelection(await readJsonBody(request));
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
  return respond(async () => {
    const sessionID = sessionIdFromPath(url);
    const agent = agentSelection(await readJsonBody(request));
    // senpi has no agent switch and no agent registry: the selection is recorded here so the next
    // turn's prompt options can apply it. Answering 204 keeps the TUI's switch flow working.
    selectedAgents.set(sessionID, agent);
    return noContent();
  });
}
