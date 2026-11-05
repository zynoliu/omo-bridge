import Ajv, { type ValidateFunction } from "ajv";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVENT_SCHEMAS, RESPONSE_DATA_SCHEMAS, type JsonSchema } from "./senpi-schema";

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

export class ContractError extends Error {}

const REPO_ROOT = resolve(import.meta.dir, "../..");
const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });

function opencodeDir(): string {
  return process.env.OMO_BRIDGE_CONTRACTS_OPENCODE_DIR ?? join(REPO_ROOT, "contracts", "opencode");
}

let opencodeCache: { dir: string; validators: Map<string, ValidateFunction> } | null = null;
const senpiCache = new Map<string, ValidateFunction>();

function opencodeValidators(): Map<string, ValidateFunction> {
  const dir = opencodeDir();
  if (opencodeCache && opencodeCache.dir === dir) return opencodeCache.validators;
  if (!existsSync(dir)) throw new ContractError(`opencode schema dir missing: ${dir}`);
  const validators = new Map<string, ValidateFunction>();
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort()) {
    const schema = JSON.parse(readFileSync(join(dir, name), "utf8")) as JsonSchema;
    const id = String(schema.$id ?? name.replace(/\.json$/, "")).replace(/^opencode\//, "");
    validators.set(id, ajv.compile(schema));
  }
  opencodeCache = { dir, validators };
  return validators;
}

function senpiValidator(key: string, schema: JsonSchema): ValidateFunction {
  const cached = senpiCache.get(key);
  if (cached) return cached;
  const compiled = ajv.compile(schema);
  senpiCache.set(key, compiled);
  return compiled;
}

function format(check: ValidateFunction, value: unknown): string[] {
  if (check(value)) return [];
  return (check.errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? "invalid"}${error.params ? ` ${JSON.stringify(error.params)}` : ""}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isKnownEventType(type: string): boolean {
  return typeof type === "string" && Object.hasOwn(EVENT_SCHEMAS, type);
}

export function validateResponse(endpointId: string, value: unknown): ValidationResult {
  const opencode = opencodeValidators().get(endpointId);
  if (opencode) {
    const errors = format(opencode, value);
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  }
  const dataSchema = RESPONSE_DATA_SCHEMAS[endpointId];
  if (!dataSchema) return { ok: false, errors: [`unknown endpoint: ${endpointId}`] };
  if (!isRecord(value)) return { ok: false, errors: [`${endpointId}: response is not an object`] };
  const errors: string[] = [];
  if (value.type !== "response") errors.push(`${endpointId}.type must be "response" (found ${JSON.stringify(value.type)})`);
  if (value.command !== endpointId) errors.push(`${endpointId}.command must be "${endpointId}" (found ${JSON.stringify(value.command)})`);
  if (typeof value.success !== "boolean") errors.push(`${endpointId}.success must be a boolean`);
  if (value.success === false) {
    if (typeof value.error !== "string") errors.push(`${endpointId}.error must be a string on a failed response`);
  } else {
    for (const error of format(senpiValidator(`response:${endpointId}`, dataSchema), value.data)) errors.push(`${endpointId}.data${error}`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function validateEvent(type: string, value: unknown): ValidationResult {
  if (!isKnownEventType(type)) return { ok: false, errors: [`unknown event type: ${String(type)}`] };
  if (!isRecord(value)) return { ok: false, errors: [`${type}: event is not an object`] };
  if (value.type !== type) return { ok: false, errors: [`${type}: frame carries type ${JSON.stringify(value.type)}`] };
  const errors = format(senpiValidator(`event:${type}`, EVENT_SCHEMAS[type]!), value);
  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

export function assertErrorEnvelope(value: unknown): void {
  if (!isRecord(value)) throw new ContractError("error envelope must be an object");
  if (typeof value._tag !== "string" || value._tag.length === 0) throw new ContractError("error envelope is missing _tag");
  if (typeof value.message !== "string") throw new ContractError("error envelope is missing message");
}
