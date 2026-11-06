import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FORK = (process.env.OMO_BRIDGE_OPENCODE_FORK ?? "/Users/zyno/OmO Projects/my-tui/opencode").replace(/\/$/, "");
const SCHEMA_DIR = process.env.OMO_BRIDGE_CONTRACTS_OPENCODE_DIR ?? join(REPO_ROOT, "contracts", "opencode");
const MAX_DEPTH = 8;

export type JsonSchema = Record<string, unknown>;

/**
 * The envelope an endpoint wraps its payload in. The bridge serves the same envelopes the fork's
 * `HttpApiEndpoint` declarations use, so the wrapper is derived here rather than hand-written per
 * endpoint:
 * - `data`                -> `{ data: T }`
 * - `dataArray`           -> `{ data: T[] }`
 * - `recordData`          -> `{ data: Record<string, T> }`
 * - `locationOnly`        -> `{ location: Location.PublicRef }`
 * - `locationData`        -> `{ location: Location.PublicRef, data: T }`
 * - `locationDataArray`   -> `{ location: Location.PublicRef, data: T[] }`
 * - `locationDataNullable`-> `{ location: Location.PublicRef, data: T | null }`
 * - `array`               -> `T[]`
 */
type Wrap =
  | "data"
  | "dataArray"
  | "recordData"
  | "locationOnly"
  | "locationData"
  | "locationDataArray"
  | "locationDataNullable"
  | "array";

type Endpoint =
  | { id: string; kind: "decl"; file: string; name: string; note: string; wrap?: Wrap }
  | { id: string; kind: "annotate"; file: string; identifier: string; note: string; wrap?: Wrap }
  | { id: string; kind: "errors"; file: string; note: string }
  | { id: string; kind: "event"; file: string; type: string; note: string };

export const ENDPOINTS: Endpoint[] = [
  {
    id: "server.info",
    kind: "decl",
    file: "packages/protocol/src/groups/server.ts",
    name: "ServerInfo",
    note: "success body of GET /api/info",
  },
  {
    id: "session.publicInfo",
    kind: "decl",
    file: "packages/protocol/src/groups/session.ts",
    name: "PublicSessionInfo",
    note: "Session.Info with location narrowed to Location.PublicRef; session.list rows",
  },
  {
    id: "session.v1Info",
    kind: "decl",
    file: "packages/schema/src/v1/session.ts",
    name: "SessionInfo",
    note: "v1 session shape still served to older clients",
  },
  {
    id: "session.messages",
    kind: "annotate",
    file: "packages/protocol/src/groups/message.ts",
    identifier: "SessionMessagesResponse",
    note: "success body of GET /api/session/:sessionID/message",
  },
  {
    id: "permission.request",
    kind: "decl",
    file: "packages/schema/src/permission.ts",
    name: "Request",
    note: "pending permission request",
  },
  {
    id: "form.info",
    kind: "decl",
    file: "packages/schema/src/form.ts",
    name: "Info",
    note: "pending form description",
  },
  {
    id: "location.publicInfo",
    kind: "decl",
    file: "packages/schema/src/location.ts",
    name: "PublicInfo",
    note: "success body of GET /api/location",
  },
  {
    id: "model.info",
    kind: "decl",
    file: "packages/schema/src/model.ts",
    name: "Info",
    note: "success body rows of GET /api/model",
  },
  {
    id: "error.envelope",
    kind: "errors",
    file: "packages/protocol/src/errors.ts",
    note: "tagged error envelope shared by every failing endpoint",
  },

  // --- session reads -------------------------------------------------------------------------
  {
    id: "session.list",
    kind: "annotate",
    file: "packages/protocol/src/groups/session.ts",
    identifier: "SessionsResponse",
    note: "success body of GET /api/session (data + cursor)",
  },
  {
    id: "session.get",
    kind: "decl",
    file: "packages/protocol/src/groups/session.ts",
    name: "PublicSessionInfo",
    wrap: "data",
    note: "success body of GET /api/session/:sessionID",
  },
  {
    id: "session.create",
    kind: "decl",
    file: "packages/protocol/src/groups/session.ts",
    name: "PublicSessionInfo",
    wrap: "data",
    note: "success body of POST /api/session",
  },
  {
    id: "session.fork",
    kind: "decl",
    file: "packages/protocol/src/groups/session.ts",
    name: "PublicSessionInfo",
    wrap: "data",
    note: "success body of POST /api/session/:sessionID/fork",
  },
  {
    id: "session.active",
    kind: "annotate",
    file: "packages/protocol/src/groups/session.ts",
    identifier: "SessionActive",
    wrap: "recordData",
    note: "success body of GET /api/session/active (session id -> running marker)",
  },
  {
    id: "session.message.get",
    kind: "decl",
    file: "packages/protocol/src/groups/message.ts",
    name: "PublicSessionMessage",
    wrap: "data",
    note: "success body of GET /api/session/:sessionID/message/:messageID",
  },
  {
    id: "session.inbox.list",
    kind: "annotate",
    file: "packages/protocol/src/groups/session.ts",
    identifier: "Session.Inbox.Info",
    wrap: "dataArray",
    note: "success body of GET /api/session/:sessionID/inbox",
  },
  {
    id: "session.diff",
    kind: "decl",
    file: "packages/schema/src/file-diff.ts",
    name: "Info",
    wrap: "dataArray",
    note: "success body of GET /api/session/:sessionID/diff",
  },

  // --- interaction surfaces -------------------------------------------------------------------
  {
    id: "permission.list",
    kind: "decl",
    file: "packages/schema/src/permission.ts",
    name: "Request",
    wrap: "dataArray",
    note: "success body of GET /api/session/:sessionID/permission",
  },
  {
    id: "form.list",
    kind: "decl",
    file: "packages/schema/src/form.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/form",
  },
  {
    id: "form.session.list",
    kind: "decl",
    file: "packages/schema/src/form.ts",
    name: "Info",
    wrap: "dataArray",
    note: "success body of GET /api/session/:sessionID/form",
  },

  // --- startup catalogs -----------------------------------------------------------------------
  {
    id: "model.list",
    kind: "decl",
    file: "packages/schema/src/model.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/model",
  },
  {
    id: "agent.list",
    kind: "decl",
    file: "packages/schema/src/agent.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/agent",
  },
  {
    id: "command.list",
    kind: "decl",
    file: "packages/schema/src/command.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/command",
  },
  {
    id: "skill.list",
    kind: "decl",
    file: "packages/schema/src/skill.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/skill",
  },
  {
    id: "reference.list",
    kind: "decl",
    file: "packages/schema/src/reference.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/reference",
  },
  {
    id: "mcp.list",
    kind: "decl",
    file: "packages/schema/src/mcp.ts",
    name: "Server",
    wrap: "locationDataArray",
    note: "success body of GET /api/mcp",
  },
  {
    id: "mcp.resourceCatalog",
    kind: "decl",
    file: "packages/schema/src/mcp.ts",
    name: "ResourceCatalog",
    wrap: "locationData",
    note: "success body of GET /api/mcp/resource",
  },
  {
    id: "integration.list",
    kind: "decl",
    file: "packages/schema/src/integration.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/integration",
  },
  {
    id: "plugin.list",
    kind: "decl",
    file: "packages/schema/src/plugin.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/plugin (empty: senpi has no plugin registry)",
  },

  // --- filesystem, location, project, vcs, config ---------------------------------------------
  {
    id: "fs.list",
    kind: "decl",
    file: "packages/schema/src/filesystem.ts",
    name: "Entry",
    wrap: "locationDataArray",
    note: "success body of GET /api/fs/list",
  },
  {
    id: "fs.find",
    kind: "decl",
    file: "packages/schema/src/filesystem.ts",
    name: "Entry",
    wrap: "locationDataArray",
    note: "success body of GET /api/fs/find",
  },
  {
    id: "location.get",
    kind: "decl",
    file: "packages/schema/src/location.ts",
    name: "PublicInfo",
    // `location.get` declares `success: Location.PublicInfo` with no `Location.response(...)`
    // wrapper (`packages/protocol/src/groups/location.ts:36`), so the body is the location itself.
    // Its siblings fs.list/vcs.get do use the envelope; wrapping this one is what crashed the TUI.
    note: "success body of GET /api/location (a bare Location.PublicInfo, no location envelope)",
  },
  {
    id: "project.list",
    kind: "decl",
    file: "packages/schema/src/project.ts",
    name: "Info",
    wrap: "array",
    note: "success body of GET /api/project (a bare array, no location envelope)",
  },
  {
    id: "vcs.get",
    kind: "decl",
    file: "packages/schema/src/vcs.ts",
    name: "Info",
    wrap: "locationData",
    note: "success body of GET /api/vcs",
  },
  {
    id: "vcs.base",
    kind: "decl",
    file: "packages/schema/src/vcs.ts",
    name: "Base",
    wrap: "locationDataNullable",
    note: "success body of GET /api/vcs/base (null when no base is resolvable)",
  },
  {
    id: "vcs.diff",
    kind: "decl",
    file: "packages/schema/src/file-diff.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/vcs/diff",
  },
  {
    id: "config.get",
    kind: "decl",
    file: "packages/schema/src/config.ts",
    name: "Entry",
    wrap: "array",
    note: "success body of GET /api/config (a bare array, no location envelope)",
  },

  // --- shell ----------------------------------------------------------------------------------
  {
    id: "shell.list",
    kind: "decl",
    file: "packages/schema/src/shell.ts",
    name: "Info",
    wrap: "locationDataArray",
    note: "success body of GET /api/shell",
  },
  {
    id: "shell.get",
    kind: "decl",
    file: "packages/schema/src/shell.ts",
    name: "Info",
    wrap: "locationData",
    note: "success body of GET /api/shell/:id",
  },
  {
    id: "shell.output",
    kind: "decl",
    file: "packages/schema/src/shell.ts",
    name: "Output",
    wrap: "locationData",
    note: "success body of GET /api/shell/:id/output",
  },

  // --- degraded families ----------------------------------------------------------------------
  {
    id: "worktree.list",
    kind: "decl",
    file: "packages/schema/src/worktree.ts",
    name: "Directory",
    wrap: "array",
    note: "success body of GET /api/worktree (a bare array)",
  },
  {
    id: "persistentPty.list",
    kind: "decl",
    file: "packages/schema/src/persistent-pty.ts",
    name: "Info",
    wrap: "dataArray",
    note: "success body of GET /api/experimental/session/:sessionID/terminal",
  },
  {
    id: "migration.status",
    kind: "decl",
    file: "packages/protocol/src/groups/migration.ts",
    name: "V1MigrationStatus",
    note: "success body of GET /api/experimental/migration/v1",
  },
  {
    id: "usage.limits",
    kind: "decl",
    file: "packages/schema/src/usage-limits.ts",
    name: "Info",
    wrap: "locationDataNullable",
    note: "success body of GET /api/experimental/usage/limits (data is null when signed out)",
  },

  // --- event frames ---------------------------------------------------------------------------
  // The bridge publishes these types on GET /api/event. The frame envelope modelled below is the
  // one the TUI reads (`{ id, type, created, data }` in packages/tui/src/context/event.ts); the
  // fork's own durable envelope additionally carries `durable`, which the bridge does not emit.
  {
    id: "event.server.connected",
    kind: "event",
    file: "packages/schema/src/server-event.ts",
    type: "server.connected",
    note: "first frame of every event stream",
  },
  {
    id: "event.session.execution.started",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.execution.started",
    note: "agent_start opened a run",
  },
  {
    id: "event.session.execution.succeeded",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.execution.succeeded",
    note: "agent_end without failure or abort",
  },
  {
    id: "event.session.execution.failed",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.execution.failed",
    note: "agent_end with a failure record",
  },
  {
    id: "event.session.execution.interrupted",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.execution.interrupted",
    note: "agent_end with aborted=true",
  },
  {
    id: "event.session.step.started",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.step.started",
    note: "assistant message opened",
  },
  {
    id: "event.session.step.streamed",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.step.streamed",
    note: "provider response boundary inside a run",
  },
  {
    id: "event.session.step.ended",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.step.ended",
    note: "assistant message closed with usage",
  },
  {
    id: "event.session.text.started",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.text.started",
    note: "text block opened",
  },
  {
    id: "event.session.text.delta",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.text.delta",
    note: "text fragment (live only)",
  },
  {
    id: "event.session.text.ended",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.text.ended",
    note: "text block closed",
  },
  {
    id: "event.session.reasoning.started",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.reasoning.started",
    note: "reasoning block opened",
  },
  {
    id: "event.session.reasoning.delta",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.reasoning.delta",
    note: "reasoning fragment (live only)",
  },
  {
    id: "event.session.reasoning.ended",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.reasoning.ended",
    note: "reasoning block closed",
  },
  {
    id: "event.session.tool.input.started",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.tool.input.started",
    note: "tool call announced",
  },
  {
    id: "event.session.tool.input.delta",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.tool.input.delta",
    note: "tool argument fragment (live only)",
  },
  {
    id: "event.session.tool.input.ended",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.tool.input.ended",
    note: "tool arguments settled",
  },
  {
    id: "event.session.usage.updated",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.usage.updated",
    note: "run usage totals",
  },
  {
    id: "event.session.compaction.started",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.compaction.started",
    note: "compaction began",
  },
  {
    id: "event.session.shell.started",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.shell.started",
    note: "shell command registered",
  },
  {
    id: "event.session.shell.ended",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.shell.ended",
    note: "shell command settled with its output page",
  },
  {
    id: "event.session.inbox.enqueued",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.inbox.enqueued",
    note: "queued input admitted",
  },
  {
    id: "event.session.inbox.cancelled",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.inbox.cancelled",
    note: "queued input cancelled",
  },
  {
    id: "event.session.inbox.delivery.changed",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.inbox.delivery.changed",
    note: "queued input delivery switched",
  },
  {
    id: "event.session.renamed",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.renamed",
    note: "session title changed",
  },
  {
    id: "event.session.archived",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.archived",
    note: "session archived",
  },
  {
    id: "event.session.unarchived",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.unarchived",
    note: "session unarchived",
  },
  {
    id: "event.session.metadata.updated",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.metadata.updated",
    note: "session metadata replaced",
  },
  {
    id: "event.session.permissions",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.permissions",
    note: "session permission ruleset replaced",
  },
  {
    id: "event.session.deleted",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.deleted",
    note: "session deleted",
  },
  {
    id: "event.session.moved",
    kind: "event",
    file: "packages/schema/src/session-event.ts",
    type: "session.moved",
    note: "session moved to another directory",
  },
  {
    id: "event.permission.asked",
    kind: "event",
    file: "packages/schema/src/permission.ts",
    type: "permission.asked",
    note: "permission prompt opened",
  },
  {
    id: "event.permission.replied",
    kind: "event",
    file: "packages/schema/src/permission.ts",
    type: "permission.replied",
    note: "permission prompt answered",
  },
  {
    id: "event.form.created",
    kind: "event",
    file: "packages/schema/src/form.ts",
    type: "form.created",
    note: "form prompt opened",
  },
  {
    id: "event.form.replied",
    kind: "event",
    file: "packages/schema/src/form.ts",
    type: "form.replied",
    note: "form prompt answered",
  },
  {
    id: "event.form.cancelled",
    kind: "event",
    file: "packages/schema/src/form.ts",
    type: "form.cancelled",
    note: "form prompt cancelled",
  },
];

type Ctx = { module: string; depth: number; chain: string[] };

type EvalResult = { schema: JsonSchema; optional: boolean };

type Field = { name: string; expr: ts.Expression; optional: boolean; module: string };

const sourceCache = new Map<string, ts.SourceFile>();

function source(rel: string): ts.SourceFile {
  const abs = resolve(FORK, rel);
  const cached = sourceCache.get(abs);
  if (cached) return cached;
  if (!existsSync(abs)) throw new Error(`fork source missing: ${rel}`);
  const file = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  sourceCache.set(abs, file);
  return file;
}

function lineOf(rel: string, node: ts.Node): number {
  const sf = source(rel);
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function textOf(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function relFromSpec(fromRel: string, spec: string): string | null {
  if (spec.startsWith("@opencode/schema/")) return `packages/schema/src/${spec.slice("@opencode/schema/".length)}.ts`;
  if (spec === "@opencode/schema") return "packages/schema/src/index.ts";
  if (spec.startsWith(".")) return resolve(dirname(resolve(FORK, fromRel)), spec).replace(/\.js$/, ".ts").slice(FORK.length + 1);
  return null;
}

function findVariable(rel: string, name: string): ts.VariableDeclaration | undefined {
  for (const st of source(rel).statements) {
    if (ts.isVariableStatement(st)) {
      for (const decl of st.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
      }
    }
  }
  return undefined;
}

// Name lookup across module boundaries: a local declaration wins, then the import binding is
// followed, and a re-exported module variable (`export { X }` next to `import { X }`) resolves to
// the module that declares it. The owning module travels with the declaration, because every
// field expression must be evaluated in the module that wrote it.
function resolveVariable(rel: string, name: string, seen: Set<string> = new Set()): { decl: ts.VariableDeclaration; module: string } | undefined {
  const key = `${rel}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const local = findVariable(rel, name);
  if (local) return { decl: local, module: rel };
  // Event schemas share field fragments declared inside the surrounding `namespace` (session-event's
  // `ToolBase`), so a name that is not at the top level still belongs to this file.
  const nested = findNestedVariable(rel, name);
  if (nested) return { decl: nested, module: rel };
  const binding = lookupImport(rel, name);
  if (binding && binding.kind === "named" && binding.module) {
    return resolveVariable(binding.module, binding.imported, seen);
  }
  return undefined;
}

function findNestedVariable(rel: string, name: string): ts.VariableDeclaration | undefined {
  let found: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isModuleDeclaration(node) && node.body && ts.isModuleBlock(node.body)) {
      for (const st of node.body.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const decl of st.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name) {
            found = decl;
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source(rel));
  return found;
}

function findClass(rel: string, name: string): ts.ClassDeclaration | undefined {
  for (const st of source(rel).statements) {
    if (ts.isClassDeclaration(st) && st.name?.text === name) return st;
  }
  return undefined;
}

type Binding =
  | { kind: "named"; module: string | null; imported: string }
  | { kind: "namespace"; module: string | null };

function lookupImport(rel: string, name: string): Binding | undefined {
  for (const st of source(rel).statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const clause = st.importClause;
    if (!clause) continue;
    const mod = relFromSpec(rel, st.moduleSpecifier.text);
    if (clause.name?.text === name) return { kind: "named", module: mod, imported: "default" };
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) return { kind: "namespace", module: mod };
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) {
        if (el.name.text === name) return { kind: "named", module: mod, imported: el.propertyName?.text ?? el.name.text };
      }
    }
  }
  return undefined;
}

const NAMESPACE_SCALARS: Record<string, JsonSchema> = {
  String: { type: "string" },
  Int: { type: "integer" },
  Finite: { type: "number" },
  Number: { type: "number" },
  Boolean: { type: "boolean" },
  Unknown: {},
  Any: {},
  Json: {},
  Null: { type: "null" },
  Trim: { type: "string" },
  DurationFromString: { type: "string" },
};

const IMPORTED_SCALARS: Record<string, JsonSchema> = {
  AbsolutePath: { type: "string" },
  RelativePath: { type: "string" },
  // The wire value: the encode side of `Schema.Finite.pipe(decodeTo(DateTimeUtc))` is epoch millis.
  DateTimeUtcFromMillis: { type: "number" },
  PositiveInt: { type: "integer", minimum: 1 },
  NonNegativeInt: { type: "integer", minimum: 0 },
};

const SCHEMA_METHODS = new Set([
  "annotate",
  "annotateMerge",
  "check",
  "brand",
  "pipe",
  "statics",
  "withStatics",
  "toTaggedUnion",
  "mapFields",
  "decodeTo",
  "encodeTo",
]);

const SCHEMA_NAMESPACE_METHODS = new Set([
  "Struct",
  "StructWithRest",
  "optional",
  "Array",
  "ArrayEnsure",
  "NonEmptyArray",
  "Union",
  "NullOr",
  "UndefinedOr",
  "Literal",
  "Literals",
  "Record",
  "TemplateLiteral",
  "tag",
  "fromJsonString",
  "Class",
  "TaggedError",
  "String",
  "Int",
  "Finite",
  "Number",
  "Boolean",
  "Unknown",
  "Any",
  "Json",
  "Null",
]);

function opaque(reason: string): EvalResult {
  return { schema: { $comment: `unresolved: ${reason}` }, optional: false };
}

function isNamespace(expr: ts.Expression, name: string): boolean {
  return ts.isIdentifier(expr) && expr.text === name;
}

function isOptionalMarker(expr: ts.Expression): boolean {
  if (ts.isIdentifier(expr)) return expr.text === "optional";
  return ts.isPropertyAccessExpression(expr) && isNamespace(expr.expression, "Schema") && expr.name.text === "optional";
}

function peelSchemaMethods(expr: ts.Expression): ts.Expression {
  let node = expr;
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const recv = node.expression.expression;
    const method = node.expression.name.text;
    if (!SCHEMA_METHODS.has(method)) break;
    if (ts.isIdentifier(recv) && (recv.text === "Schema" || recv.text === "Struct")) break;
    node = recv;
  }
  return node;
}

function namespaceFn(expr: ts.Expression): { ns: string; fn: string } | null {
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return null;
  return { ns: expr.expression.text, fn: expr.name.text };
}

function reexportNamespaceTarget(rel: string, name: string): string | null {
  for (const st of source(rel).statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || !st.exportClause) continue;
    if (!ts.isNamespaceExport(st.exportClause) || st.exportClause.name.text !== name) continue;
    return relFromSpec(rel, st.moduleSpecifier.text);
  }
  return null;
}

// `import { Session } from "@opencode/schema/session"` binds a module namespace
// declared as `export * as Session from "./session.js"` in that module's own file.
function namespaceModuleFor(rel: string, name: string): string | null {
  const direct = reexportNamespaceTarget(rel, name);
  if (direct) return direct;
  const binding = lookupImport(rel, name);
  if (!binding) return null;
  if (binding.kind === "namespace") return binding.module;
  if (!binding.module) return null;
  return reexportNamespaceTarget(binding.module, binding.imported) ?? binding.module;
}

function schemaDeclFor(expr: ts.Expression, ctx: Ctx): { decl: ts.VariableDeclaration; module: string } | null {
  if (ts.isIdentifier(expr)) {
    const local = findVariable(ctx.module, expr.text);
    if (local) return { decl: local, module: ctx.module };
    const binding = lookupImport(ctx.module, expr.text);
    if (binding && binding.kind === "named" && binding.module) {
      const decl = findVariable(binding.module, binding.imported);
      if (decl) return { decl, module: binding.module };
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const module = namespaceModuleFor(ctx.module, expr.expression.text);
    if (!module) return null;
    const decl = findVariable(module, expr.name.text);
    return decl ? { decl, module } : null;
  }
  return null;
}

function classFields(cls: ts.ClassDeclaration, ctx: Ctx): Field[] | null {
  const heritage = cls.heritageClauses?.[0]?.types?.[0]?.expression;
  if (!heritage || !ts.isCallExpression(heritage) || !heritage.arguments[0]) return null;
  return fieldsFrom(heritage.arguments[0], ctx);
}

function fieldsFromNames(node: ts.Expression, ctx: Ctx): Field[] | null {
  if (ts.isIdentifier(node)) {
    const resolved = resolveVariable(ctx.module, node.text);
    if (resolved?.decl.initializer) {
      return fieldsFrom(resolved.decl.initializer, { module: resolved.module, depth: ctx.depth + 1, chain: ctx.chain });
    }
    const cls = findClass(ctx.module, node.text);
    if (cls) return classFields(cls, { ...ctx, depth: ctx.depth + 1 });
    const binding = lookupImport(ctx.module, node.text);
    if (binding && binding.kind === "named" && binding.module) {
      const imported = findClass(binding.module, binding.imported);
      if (imported) return classFields(imported, { module: binding.module, depth: ctx.depth + 1, chain: ctx.chain });
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const module = namespaceModuleFor(ctx.module, node.expression.text);
    if (!module) return null;
    const resolved = resolveVariable(module, node.name.text);
    if (resolved?.decl.initializer) {
      return fieldsFrom(resolved.decl.initializer, { module: resolved.module, depth: ctx.depth + 1, chain: ctx.chain });
    }
    const cls = findClass(module, node.name.text);
    if (cls) return classFields(cls, { module, depth: ctx.depth + 1, chain: ctx.chain });
  }
  return null;
}

function fieldsFrom(node: ts.Expression, ctx: Ctx): Field[] | null {
  if (ts.isObjectLiteralExpression(node)) {
    const out: Field[] = [];
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : prop.name.getText();
        out.push({ name, expr: prop.initializer, optional: isOptionalMarker(prop.initializer), module: ctx.module });
        continue;
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        out.push({ name: prop.name.text, expr: prop.name, optional: false, module: ctx.module });
        continue;
      }
      if (ts.isSpreadAssignment(prop)) {
        const sub = fieldsFrom(prop.expression, ctx);
        if (!sub) throw new Error(`${ctx.module}:${lineOf(ctx.module, prop)} cannot resolve spread ${textOf(prop.expression)}`);
        out.push(...sub);
        continue;
      }
      throw new Error(`${ctx.module}:${lineOf(ctx.module, prop)} unsupported struct member ${textOf(prop)}`);
    }
    return out;
  }
  const peeled = peelSchemaMethods(node);
  if (peeled !== node) return fieldsFrom(peeled, ctx);
  if (ts.isCallExpression(node)) {
    const fn = namespaceFn(node.expression);
    if (fn?.ns === "Struct" && (fn.fn === "omit" || fn.fn === "pick") && node.arguments[0] && node.arguments[1] && ts.isArrayLiteralExpression(node.arguments[1])) {
      const base = fieldsFrom(node.arguments[0], ctx);
      if (!base) return null;
      const keys = new Set(node.arguments[1].elements.filter(ts.isStringLiteral).map((el) => el.text));
      return fn.fn === "omit" ? base.filter((f) => !keys.has(f.name)) : base.filter((f) => keys.has(f.name));
    }
    if (fn?.ns === "Schema" && (fn.fn === "Struct" || fn.fn === "Class") && node.arguments[0]) return fieldsFrom(node.arguments[0], ctx);
    if (fn?.ns === "Schema" && fn.fn === "StructWithRest" && node.arguments[0]) return fieldsFrom(node.arguments[0], ctx);
    if (ts.isCallExpression(node.expression)) {
      const inner = namespaceFn(node.expression.expression);
      if (inner?.ns === "Schema" && inner.fn === "Class" && node.arguments[0]) return fieldsFrom(node.arguments[0], ctx);
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "schema") {
    // `Provider.Settings.schema.fields`: the owner is a schema declaration, and its `.schema` view
    // exposes the same fields; resolve through the declaration instead of the member expression.
    const owner = schemaDeclFor(node.expression, ctx);
    if (owner?.decl.initializer) {
      return fieldsFrom(owner.decl.initializer, { module: owner.module, depth: ctx.depth + 1, chain: ctx.chain });
    }
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "fields") return fieldsFrom(node.expression, ctx);
  return fieldsFromNames(node, ctx);
}

function buildStruct(fields: Field[], ctx: Ctx): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    const result = evalExpr(field.expr, { module: field.module, depth: ctx.depth, chain: ctx.chain });
    properties[field.name] = result.schema;
    if (!field.optional && !result.optional && !required.includes(field.name)) required.push(field.name);
  }
  // A declared struct is closed: a response that grows a field the fork's schema does not declare
  // is drift, and the contract test proves it by rejecting a sample with one extra key.
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function evalVariable(decl: ts.VariableDeclaration, module: string, ctx: Ctx): EvalResult {
  const name = ts.isIdentifier(decl.name) ? decl.name.text : "destructured";
  const key = `${module}#${name}`;
  if (ctx.chain.includes(key)) return opaque(`recursive ${name}`);
  if (!decl.initializer) return opaque(name);
  if (ctx.depth >= MAX_DEPTH) return opaque(`${name} (depth limit)`);
  return evalExpr(decl.initializer, { module, depth: ctx.depth + 1, chain: [...ctx.chain, key] });
}

function evalRef(expr: ts.Expression, module: string, ctx: Ctx): EvalResult {
  const name = ts.isIdentifier(expr) ? expr.text : expr.getText();
  const resolved = resolveVariable(module, name);
  if (resolved) return evalVariable(resolved.decl, resolved.module, ctx);
  const binding = lookupImport(module, name);
  if (binding) {
    if (binding.kind === "named" && binding.module) {
      const cls = findClass(binding.module, binding.imported);
      if (cls) {
        const fields = classFields(cls, { module: binding.module, depth: ctx.depth + 1, chain: ctx.chain });
        if (fields) return { schema: buildStruct(fields, { module: binding.module, depth: ctx.depth + 1, chain: ctx.chain }), optional: false };
      }
    }
    return opaque(name);
  }
  const cls = findClass(module, name);
  if (cls) {
    const fields = classFields(cls, ctx);
    if (fields) return { schema: buildStruct(fields, ctx), optional: false };
  }
  return opaque(name);
}

function evalQualified(expr: ts.PropertyAccessExpression, ctx: Ctx): EvalResult {
  const left = expr.expression;
  const member = expr.name.text;
  if (ts.isIdentifier(left)) {
    // `Overlays.headers` where `Overlays` is a plain object of schema fields (config overrides use
    // this to share the settings/headers/body trio between provider and model info).
    const shared = findVariable(ctx.module, left.text);
    if (shared?.initializer && ts.isObjectLiteralExpression(shared.initializer)) {
      for (const prop of shared.initializer.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
        if (name === member) return evalExpr(prop.initializer, { ...ctx, depth: ctx.depth + 1 });
      }
    }
  }
  if (ts.isPropertyAccessExpression(left) && left.name.text === "fields") {
    const owner = schemaDeclFor(left.expression, ctx);
    if (owner?.decl.initializer) {
      const fields = fieldsFrom(owner.decl.initializer, { module: owner.module, depth: ctx.depth + 1, chain: ctx.chain });
      const field = fields?.find((candidate) => candidate.name === member);
      if (field) return evalExpr(field.expr, { module: field.module, depth: ctx.depth + 1, chain: ctx.chain });
    }
    return opaque(textOf(expr));
  }
  if (isNamespace(left, "Schema")) {
    const scalar = NAMESPACE_SCALARS[member];
    if (scalar) return { schema: scalar, optional: false };
    return opaque(`Schema.${member}`);
  }
  if (ts.isIdentifier(left)) {
    const module = namespaceModuleFor(ctx.module, left.text);
    if (module) {
      const resolved = resolveVariable(module, member);
      if (resolved) return evalVariable(resolved.decl, resolved.module, ctx);
      const cls = findClass(module, member);
      if (cls) {
        const classCtx = { ...ctx, module };
        const fields = classFields(cls, classCtx);
        if (fields) return { schema: buildStruct(fields, classCtx), optional: false };
      }
      return opaque(`${left.text}.${member}`);
    }
  }
  return opaque(textOf(expr));
}

function evalNamespaceCall(method: string, args: readonly ts.Expression[], ctx: Ctx): EvalResult {
  const arg = (index: number): ts.Expression | undefined => args[index];
  switch (method) {
    case "String":
    case "Int":
    case "Finite":
    case "Number":
    case "Boolean":
    case "Unknown":
    case "Any":
    case "Json":
    case "Null":
      return { schema: NAMESPACE_SCALARS[method] ?? {}, optional: false };
    case "Struct": {
      if (!arg(0)) return opaque("Schema.Struct()");
      const fields = fieldsFrom(arg(0)!, ctx);
      return fields ? { schema: buildStruct(fields, ctx), optional: false } : opaque(textOf(arg(0)!));
    }
    case "Class": {
      if (!arg(0)) return opaque("Schema.Class()");
      const fields = fieldsFrom(arg(0)!, ctx);
      return fields ? { schema: buildStruct(fields, ctx), optional: false } : opaque(textOf(arg(0)!));
    }
    case "optional": {
      const inner = arg(0) ? evalExpr(arg(0)!, ctx) : opaque("Schema.optional()");
      return { schema: inner.schema, optional: true };
    }
    case "Array":
    case "ArrayEnsure": {
      const inner = arg(0) ? evalExpr(arg(0)!, ctx).schema : {};
      return { schema: { type: "array", items: inner }, optional: false };
    }
    case "StructWithRest": {
      // `Schema.StructWithRest(struct, [rest])` is a struct plus an index signature; the rest
      // member contributes `additionalProperties`, never required fields.
      if (!arg(0)) return opaque("Schema.StructWithRest()");
      const fields = fieldsFrom(arg(0)!, ctx);
      if (!fields) return opaque(textOf(arg(0)!));
      const schema = buildStruct(fields, ctx);
      const rest = arg(1);
      if (rest && ts.isArrayLiteralExpression(rest)) {
        let additional: JsonSchema | undefined;
        for (const element of rest.elements) {
          const evaluated = evalExpr(element, ctx).schema;
          const value = evaluated.additionalProperties;
          additional = additional === undefined || value === undefined ? (value as JsonSchema | undefined) : {};
        }
        if (additional !== undefined) schema.additionalProperties = additional;
      }
      return { schema, optional: false };
    }
    case "NonEmptyArray": {
      const inner = arg(0) ? evalExpr(arg(0)!, ctx).schema : {};
      return { schema: { type: "array", items: inner, minItems: 1 }, optional: false };
    }
    case "Union": {
      const list = arg(0);
      if (!list || !ts.isArrayLiteralExpression(list)) return opaque("Schema.Union()");
      const members = list.elements.map((el) => evalExpr(el, ctx).schema);
      if (members.length === 0) return opaque("empty union");
      if (members.every((m) => typeof m.const !== "undefined")) {
        return { schema: { enum: members.map((m) => m.const) }, optional: false };
      }
      return { schema: { anyOf: members }, optional: false };
    }
    case "NullOr": {
      if (!arg(0)) return opaque("Schema.NullOr()");
      return { schema: { anyOf: [evalExpr(arg(0)!, ctx).schema, { type: "null" }] }, optional: false };
    }
    case "UndefinedOr": {
      // `undefined` has no wire representation: an omitted key, not a JSON value.
      if (!arg(0)) return opaque("Schema.UndefinedOr()");
      return evalExpr(arg(0)!, ctx);
    }
    case "Literal": {
      const value = arg(0);
      if (value && (ts.isStringLiteral(value) || ts.isNumericLiteral(value))) return { schema: { const: value.text }, optional: false };
      if (value && value.kind === ts.SyntaxKind.TrueKeyword) return { schema: { const: true }, optional: false };
      if (value && value.kind === ts.SyntaxKind.FalseKeyword) return { schema: { const: false }, optional: false };
      return opaque(textOf(args[0] ?? args[1] ?? ({} as ts.Expression)));
    }
    case "Literals": {
      const list = arg(0);
      if (!list || !ts.isArrayLiteralExpression(list)) return opaque("Schema.Literals()");
      const values: (string | boolean)[] = [];
      for (const el of list.elements) {
        if (ts.isStringLiteral(el) || ts.isNumericLiteral(el)) values.push(el.text);
        else if (el.kind === ts.SyntaxKind.TrueKeyword) values.push(true);
        else if (el.kind === ts.SyntaxKind.FalseKeyword) values.push(false);
      }
      return { schema: { enum: values }, optional: false };
    }
    case "Record": {
      const values = arg(1) ? evalExpr(arg(1)!, ctx).schema : {};
      return { schema: { type: "object", additionalProperties: values }, optional: false };
    }
    case "TemplateLiteral":
      return { schema: { type: "string" }, optional: false };
    case "tag": {
      const value = arg(0);
      if (value && ts.isStringLiteral(value)) return { schema: { const: value.text }, optional: false };
      return opaque("Schema.tag()");
    }
    case "fromJsonString":
      return arg(0) ? evalExpr(arg(0)!, ctx) : opaque("Schema.fromJsonString()");
    default:
      return opaque(`Schema.${method}`);
  }
}

// `Base.pipe(Schema.Array)` wraps the piped schema in an array; the operator is
// passed as a bare reference rather than a call, so evalNamespaceCall never sees it.
function pipeArrayOperator(argument: ts.Expression): "Array" | "ArrayEnsure" | "NonEmptyArray" | null {
  const target = ts.isCallExpression(argument) ? argument.expression : argument;
  const fn = namespaceFn(target);
  if (!fn || fn.ns !== "Schema") return null;
  return fn.fn === "Array" || fn.fn === "ArrayEnsure" || fn.fn === "NonEmptyArray" ? fn.fn : null;
}

function evalCall(expr: ts.CallExpression, ctx: Ctx): EvalResult {
  const callee = expr.expression;
  if (ts.isCallExpression(callee) && ts.isPropertyAccessExpression(callee.expression)) {
    const ns = callee.expression.expression;
    const fn = callee.expression.name.text;
    if (isNamespace(ns, "Schema") && fn === "Class" && expr.arguments[0]) {
      const fields = fieldsFrom(expr.arguments[0], ctx);
      return fields ? { schema: buildStruct(fields, ctx), optional: false } : opaque(textOf(expr));
    }
    if (isNamespace(ns, "Schema") && fn === "TaggedError" && expr.arguments[1]) {
      const fields = fieldsFrom(expr.arguments[1], ctx);
      return fields ? { schema: buildStruct(fields, ctx), optional: false } : opaque(textOf(expr));
    }
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const recv = callee.expression;
    const method = callee.name.text;
    if (ts.isIdentifier(recv) && recv.text === "Schema" && SCHEMA_NAMESPACE_METHODS.has(method)) {
      return evalNamespaceCall(method, expr.arguments, ctx);
    }
    if (ts.isIdentifier(recv) && recv.text === "Struct") return opaque(`Struct.${method}`);
    if (SCHEMA_METHODS.has(method)) {
      const base = evalExpr(recv, ctx);
      if (method !== "pipe") return base;
      let optional = base.optional;
      let schema = base.schema;
      for (const argument of expr.arguments) {
        if (isOptionalMarker(argument)) {
          optional = true;
          continue;
        }
        const arrayOperator = pipeArrayOperator(argument);
        if (arrayOperator === "NonEmptyArray") schema = { type: "array", items: schema, minItems: 1 };
        else if (arrayOperator) schema = { type: "array", items: schema };
      }
      return { schema, optional };
    }
    return opaque(textOf(expr));
  }
  if (ts.isIdentifier(callee) && callee.text === "optional" && expr.arguments[0]) {
    return { schema: evalExpr(expr.arguments[0], ctx).schema, optional: true };
  }
  return opaque(textOf(expr));
}

function evalExpr(expr: ts.Expression, ctx: Ctx): EvalResult {
  if (ts.isParenthesizedExpression(expr)) return evalExpr(expr.expression, ctx);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr)) return evalExpr(expr.expression, ctx);
  if (ts.isIdentifier(expr)) {
    const scalar = IMPORTED_SCALARS[expr.text];
    if (scalar) return { schema: scalar, optional: false };
    return evalRef(expr, ctx.module, ctx);
  }
  if (ts.isPropertyAccessExpression(expr)) return evalQualified(expr, ctx);
  if (ts.isCallExpression(expr)) return evalCall(expr, ctx);
  if (ts.isObjectLiteralExpression(expr)) {
    const fields = fieldsFrom(expr, ctx);
    return fields ? { schema: buildStruct(fields, ctx), optional: false } : opaque(textOf(expr));
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const members = expr.elements.map((el) => evalExpr(el, ctx).schema);
    return { schema: { anyOf: members }, optional: false };
  }
  if (ts.isStringLiteral(expr)) return { schema: { const: expr.text }, optional: false };
  if (ts.isNumericLiteral(expr)) return { schema: { const: Number(expr.text) }, optional: false };
  if (ts.isPrefixUnaryExpression(expr) && ts.isNumericLiteral(expr.operand)) return { schema: { const: -Number(expr.operand.text) }, optional: false };
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { schema: { const: true }, optional: false };
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { schema: { const: false }, optional: false };
  return opaque(textOf(expr));
}

function findAnnotated(rel: string, identifier: string): { expr: ts.Expression; node: ts.Node } | null {
  let found: { expr: ts.Expression; node: ts.Node } | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const options = node.arguments[0];
      if ((method === "annotate" || method === "annotateMerge") && options && ts.isObjectLiteralExpression(options)) {
        for (const prop of options.properties) {
          if (!ts.isPropertyAssignment(prop) || prop.name.getText() !== "identifier") continue;
          if (ts.isStringLiteral(prop.initializer) && prop.initializer.text === identifier) {
            found = { expr: node.expression.expression, node };
            return;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source(rel));
  return found;
}

function deriveErrorEnvelope(rel: string): { schema: JsonSchema; line: number } {
  const sf = source(rel);
  const ctx: Ctx = { module: rel, depth: 0, chain: [] };
  const tags: string[] = [];
  let firstLine = 0;
  for (const st of sf.statements) {
    if (!ts.isClassDeclaration(st)) continue;
    const heritage = st.heritageClauses?.[0]?.types?.[0]?.expression;
    if (!heritage || !ts.isCallExpression(heritage) || ts.isCallExpression(heritage.expression) === false) continue;
    const inner = heritage.expression;
    const callee = ts.isCallExpression(inner) ? inner.expression : undefined;
    if (!callee || !ts.isPropertyAccessExpression(callee) || callee.name.text !== "TaggedError") continue;
    const tag = heritage.arguments[0];
    const fieldsNode = heritage.arguments[1];
    if (!tag || !ts.isStringLiteral(tag) || !fieldsNode) continue;
    const fields = fieldsFrom(fieldsNode, ctx);
    if (!fields) throw new Error(`cannot read fields of tagged error ${tag.text}`);
    if (!fields.some((f) => f.name === "message" && !f.optional)) {
      throw new Error(`tagged error ${tag.text} does not declare a required message field`);
    }
    if (firstLine === 0) firstLine = lineOf(rel, st);
    tags.push(tag.text);
  }
  if (tags.length === 0) throw new Error(`no Schema.TaggedError classes found in ${rel}`);
  const schema: JsonSchema = {
    type: "object",
    required: ["_tag", "message"],
    properties: { _tag: { type: "string" }, message: { type: "string" } },
    additionalProperties: true,
    $comment: `tagged errors declared in ${rel}: ${tags.join(", ")}`,
  };
  return { schema, line: firstLine };
}

function applyWrap(inner: JsonSchema, wrap: Wrap | undefined): JsonSchema {
  if (wrap === undefined) return inner;
  const location = locationRefSchema();
  const array = { type: "array", items: inner };
  // The envelope is closed for the same reason its payload is: an endpoint that answers `{data}`
  // says so, and an extra sibling key is an undeclared shape rather than a tolerant one.
  switch (wrap) {
    case "data":
      return { type: "object", required: ["data"], properties: { data: inner }, additionalProperties: false };
    case "dataArray":
      return { type: "object", required: ["data"], properties: { data: array }, additionalProperties: false };
    case "recordData":
      return { type: "object", required: ["data"], properties: { data: { type: "object", additionalProperties: inner } }, additionalProperties: false };
    case "locationOnly":
      return { type: "object", required: ["location"], properties: { location }, additionalProperties: false };
    case "locationData":
      return { type: "object", required: ["location", "data"], properties: { location, data: inner }, additionalProperties: false };
    case "locationDataArray":
      return { type: "object", required: ["location", "data"], properties: { location, data: array }, additionalProperties: false };
    case "locationDataNullable":
      return {
        type: "object",
        required: ["location", "data"],
        properties: { location, data: { anyOf: [inner, { type: "null" }] } },
        additionalProperties: false,
      };
    case "array":
      return array;
  }
}

// `Location.response(...)` envelopes carry `Location.PublicRef`, derived here from the fork so the
// wrapper cannot drift from the schema it references.
let locationRef: JsonSchema | null = null;
function locationRefSchema(): JsonSchema {
  if (locationRef === null) {
    const { schema } = deriveOne({
      id: "location.publicRef",
      kind: "decl",
      file: "packages/schema/src/location.ts",
      name: "PublicRef",
      note: "location envelope",
    });
    locationRef = schema;
  }
  return locationRef;
}

function findEventDefinition(rel: string, type: string): { schema: ts.Expression; node: ts.Node } | null {
  let found: { schema: ts.Expression; node: ts.Node } | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : undefined;
      const input = node.arguments[0];
      if ((method === "durable" || method === "ephemeral") && input && ts.isObjectLiteralExpression(input)) {
        let declaredType: string | undefined;
        let schema: ts.Expression | undefined;
        for (const prop of input.properties) {
          if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
          if (prop.name.text === "type" && ts.isStringLiteral(prop.initializer)) declaredType = prop.initializer.text;
          if (prop.name.text === "schema") schema = prop.initializer;
        }
        if (declaredType === type && schema !== undefined) {
          found = { schema, node };
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source(rel));
  return found;
}

// The frame the TUI reads off GET /api/event: `{ id, type, created, data }`
// (packages/tui/src/context/event.ts switches on `type` and reads `data`). The fork's own durable
// envelope additionally carries `durable`; the bridge does not serve that key, so the envelope is
// closed to it and a frame that grows it is drift the contract test rejects.
function deriveEvent(rel: string, type: string): { schema: JsonSchema; line: number } {
  const definition = findEventDefinition(rel, type);
  if (!definition) throw new Error(`${rel}: event definition for ${type} not found`);
  const ctx: Ctx = { module: rel, depth: 0, chain: [] };
  const fields = fieldsFrom(definition.schema, ctx);
  if (!fields) throw new Error(`${rel}: cannot read the data schema of event ${type}`);
  return {
    schema: {
      type: "object",
      required: ["id", "type", "created", "data"],
      properties: {
        id: { type: "string" },
        type: { const: type },
        created: { type: "number" },
        data: buildStruct(fields, ctx),
      },
      additionalProperties: false,
    },
    line: lineOf(rel, definition.node),
  };
}

// An unresolvable reference would silently become `{}` (accept anything), which turns a contract
// assertion into a no-op. Every checked-in schema must resolve in full.
function assertResolved(schema: JsonSchema, endpoint: string, path = endpoint): void {
  if (Array.isArray(schema)) {
    schema.forEach((value, index) => assertResolved(value as JsonSchema, endpoint, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$comment" && typeof value === "string" && value.startsWith("unresolved:")) {
      throw new Error(`${endpoint}: unresolved leaf at ${path}: ${value}`);
    }
    if (value !== null && typeof value === "object") assertResolved(value as JsonSchema, endpoint, `${path}.${key}`);
  }
}

function deriveOne(endpoint: Endpoint): { schema: JsonSchema; line: number } {
  if (endpoint.kind === "errors") return deriveErrorEnvelope(endpoint.file);
  if (endpoint.kind === "event") return deriveEvent(endpoint.file, endpoint.type);
  const ctx: Ctx = { module: endpoint.file, depth: 0, chain: [] };
  if (endpoint.kind === "decl") {
    const decl = findVariable(endpoint.file, endpoint.name);
    if (!decl) throw new Error(`${endpoint.file}: export ${endpoint.name} not found`);
    const result = evalVariable(decl, endpoint.file, ctx);
    return { schema: applyWrap(result.schema, endpoint.wrap), line: lineOf(endpoint.file, decl) };
  }
  const annotated = findAnnotated(endpoint.file, endpoint.identifier);
  if (!annotated) throw new Error(`${endpoint.file}: annotate identifier ${endpoint.identifier} not found`);
  const result = evalExpr(annotated.expr, ctx);
  return { schema: applyWrap(result.schema, endpoint.wrap), line: lineOf(endpoint.file, annotated.expr) };
}

export function deriveSchemas(): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>();
  for (const endpoint of ENDPOINTS) {
    const { schema, line } = deriveOne(endpoint);
    assertResolved(schema, endpoint.id);
    out.set(endpoint.id, {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: `opencode/${endpoint.id}`,
      title: endpoint.id,
      description: `Derived from ${endpoint.file}:${line} - ${endpoint.note}.`,
      ...schema,
    });
  }
  return out;
}

function withoutRootDescription(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { description: _ignored, ...rest } = value as Record<string, unknown>;
  return rest;
}

function diff(expected: unknown, actual: unknown, path: string, out: (line: string) => void): void {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out(`${path}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
      return;
    }
    if (expected.length !== actual.length) out(`${path}: expected ${expected.length} entries, found ${actual.length}`);
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i += 1) diff(expected[i], actual[i], `${path}[${i}]`, out);
    return;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const want = expected as Record<string, unknown>;
    const got = actual as Record<string, unknown>;
    for (const key of Object.keys(want)) {
      if (!(key in got)) {
        out(`${path}.${key}: missing (expected ${JSON.stringify(want[key])})`);
        continue;
      }
      diff(want[key], got[key], `${path}.${key}`, out);
    }
    for (const key of Object.keys(got)) {
      if (key in want) continue;
      out(`${path}.${key}: unexpected (found ${JSON.stringify(got[key])})`);
    }
    return;
  }
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    out(`${path}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

export function compareSchemas(dir = SCHEMA_DIR): { endpoints: number; errors: string[] } {
  const expected = deriveSchemas();
  const errors: string[] = [];
  if (!existsSync(dir)) return { endpoints: expected.size, errors: [`opencode: schema dir missing: ${dir}`] };
  const onDisk = readdirSync(dir).filter((name) => name.endsWith(".json"));
  for (const id of expected.keys()) {
    const file = join(dir, `${id}.json`);
    if (!existsSync(file)) {
      errors.push(`opencode: ${id}: schema file missing: ${file}`);
      continue;
    }
    let actual: unknown;
    try {
      actual = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`opencode: ${id}: invalid JSON (${(error as Error).message})`);
      continue;
    }
    diff(withoutRootDescription(expected.get(id)), withoutRootDescription(actual), id, (line) => errors.push(`opencode: ${line}`));
  }
  const known = new Set([...expected.keys()].map((id) => `${id}.json`));
  for (const name of onDisk) {
    if (!known.has(name)) errors.push(`opencode: ${name}: file is not part of the endpoint registry`);
  }
  return { endpoints: expected.size, errors };
}

export function writeSchemas(dir = SCHEMA_DIR): number {
  const schemas = deriveSchemas();
  mkdirSync(dir, { recursive: true });
  for (const [id, schema] of schemas) writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(schema, null, 2)}\n`);
  return schemas.size;
}

if (import.meta.main) {
  try {
    if (process.argv.includes("--write")) {
      const count = writeSchemas();
      console.log(`opencode: wrote ${count} schemas to ${SCHEMA_DIR}`);
    } else {
      const { endpoints, errors } = compareSchemas();
      if (errors.length > 0) {
        for (const error of errors) console.error(error);
        process.exit(1);
      }
      console.log(`opencode: ${endpoints} schemas match ${FORK}`);
    }
  } catch (error) {
    console.error(`opencode: ${(error as Error).message}`);
    process.exit(1);
  }
}
