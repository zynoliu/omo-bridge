import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dir, "..");
const FORK = (process.env.OMO_BRIDGE_OPENCODE_FORK ?? "/Users/zyno/OmO Projects/my-tui/opencode").replace(/\/$/, "");
const SCHEMA_DIR = process.env.OMO_BRIDGE_CONTRACTS_OPENCODE_DIR ?? join(REPO_ROOT, "contracts", "opencode");
const MAX_DEPTH = 8;

export type JsonSchema = Record<string, unknown>;

type Endpoint =
  | { id: string; kind: "decl"; file: string; name: string; note: string }
  | { id: string; kind: "annotate"; file: string; identifier: string; note: string }
  | { id: string; kind: "errors"; file: string; note: string };

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
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text !== name) continue;
        const target = relFromSpec(rel, st.moduleSpecifier.text);
        if (target) return findVariable(target, el.propertyName?.text ?? el.name.text);
      }
    }
  }
  return undefined;
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
  "decodeTo",
  "encodeTo",
]);

const SCHEMA_NAMESPACE_METHODS = new Set([
  "Struct",
  "optional",
  "Array",
  "ArrayEnsure",
  "NonEmptyArray",
  "Union",
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
    const local = findVariable(ctx.module, node.text);
    if (local?.initializer) return fieldsFrom(local.initializer, { ...ctx, depth: ctx.depth + 1 });
    const cls = findClass(ctx.module, node.text);
    if (cls) return classFields(cls, { ...ctx, depth: ctx.depth + 1 });
    const binding = lookupImport(ctx.module, node.text);
    if (binding && binding.kind === "named" && binding.module) {
      const decl = findVariable(binding.module, binding.imported);
      if (decl?.initializer) return fieldsFrom(decl.initializer, { module: binding.module, depth: ctx.depth + 1, chain: ctx.chain });
      const imported = findClass(binding.module, binding.imported);
      if (imported) return classFields(imported, { module: binding.module, depth: ctx.depth + 1, chain: ctx.chain });
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const module = namespaceModuleFor(ctx.module, node.expression.text);
    if (!module) return null;
    const decl = findVariable(module, node.name.text);
    if (decl?.initializer) return fieldsFrom(decl.initializer, { module, depth: ctx.depth + 1, chain: ctx.chain });
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
    if (ts.isCallExpression(node.expression)) {
      const inner = namespaceFn(node.expression.expression);
      if (inner?.ns === "Schema" && inner.fn === "Class" && node.arguments[0]) return fieldsFrom(node.arguments[0], ctx);
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === "fields") return fieldsFromNames(node.expression, ctx);
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
  const schema: JsonSchema = { type: "object", properties };
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
  const local = findVariable(module, name);
  if (local) return evalVariable(local, module, ctx);
  const binding = lookupImport(module, name);
  if (binding) {
    if (binding.kind === "named" && binding.module) {
      const decl = findVariable(binding.module, binding.imported);
      if (decl) return evalVariable(decl, binding.module, ctx);
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
      const decl = findVariable(module, member);
      if (decl) return evalVariable(decl, module, ctx);
      const cls = findClass(module, member);
      if (cls) {
        const fields = classFields(cls, ctx);
        if (fields) return { schema: buildStruct(fields, ctx), optional: false };
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

function deriveOne(endpoint: Endpoint): { schema: JsonSchema; line: number } {
  if (endpoint.kind === "errors") return deriveErrorEnvelope(endpoint.file);
  const ctx: Ctx = { module: endpoint.file, depth: 0, chain: [] };
  if (endpoint.kind === "decl") {
    const decl = findVariable(endpoint.file, endpoint.name);
    if (!decl) throw new Error(`${endpoint.file}: export ${endpoint.name} not found`);
    const result = evalVariable(decl, endpoint.file, ctx);
    return { schema: result.schema, line: lineOf(endpoint.file, decl) };
  }
  const annotated = findAnnotated(endpoint.file, endpoint.identifier);
  if (!annotated) throw new Error(`${endpoint.file}: annotate identifier ${endpoint.identifier} not found`);
  const result = evalExpr(annotated.expr, ctx);
  return { schema: result.schema, line: lineOf(endpoint.file, annotated.expr) };
}

export function deriveSchemas(): Map<string, JsonSchema> {
  const out = new Map<string, JsonSchema>();
  for (const endpoint of ENDPOINTS) {
    const { schema, line } = deriveOne(endpoint);
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
