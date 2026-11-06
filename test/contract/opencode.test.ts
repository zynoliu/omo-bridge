import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertErrorEnvelope, ContractError, validateResponse } from "../../src/contract/validate";

const CONTRACTS = process.env.OMO_BRIDGE_CONTRACTS_OPENCODE_DIR ?? join(import.meta.dir, "..", "..", "contracts", "opencode");
const SCHEMA_DIR = CONTRACTS;
const SAMPLE_DIR = join(CONTRACTS, "samples");

type JsonSchema = {
  type?: string;
  required?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function eventSamples(): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const path = join(SAMPLE_DIR, "events.jsonl");
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { endpoint: string; frame: unknown };
    out.set(`event.${record.endpoint}`, record.frame);
  }
  return out;
}

const events = eventSamples();
const ids = readdirSync(SCHEMA_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""))
  .sort();

function sampleOf(id: string): unknown {
  const event = events.get(id);
  if (event !== undefined) return event;
  return read(join(SAMPLE_DIR, `${id}.json`));
}

// Empty collections expose no field to remove; their callers assert a wrong-typed body is rejected.
function removeOneRequired(value: unknown, schema: JsonSchema): boolean {
  if (Array.isArray(schema.anyOf)) {
    for (const member of schema.anyOf) {
      if (removeOneRequired(value, member)) return true;
    }
    return false;
  }
  if (Array.isArray(value)) {
    const item = schema.items;
    if (value.length === 0 || item === undefined) return false;
    return removeOneRequired(value[0], item);
  }
  if (!isRecord(value)) return false;
  for (const key of schema.required ?? []) {
    if (!(key in value)) continue;
    delete value[key];
    return true;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (!isRecord(nested) && !Array.isArray(nested)) continue;
    const child = schema.properties?.[key];
    if (child !== undefined && removeOneRequired(nested, child)) return true;
  }
  return false;
}

// A generated struct is closed, so a body that grows a key no declaration names must fail. The walk
// follows the sample beside its schema and stamps the first object the schema closes; an empty
// collection exposes no object to stamp, and a record (`additionalProperties` as a schema) accepts
// its own keys by declaration, so those endpoints report nothing to stamp rather than a pass.
function addUnknownField(value: unknown, schema: JsonSchema, key: string): boolean {
  if (Array.isArray(schema.anyOf)) {
    for (const member of schema.anyOf) {
      if (addUnknownField(value, member, key)) return true;
    }
    return false;
  }
  if (Array.isArray(value)) {
    const item = schema.items;
    if (value.length === 0 || item === undefined) return false;
    return addUnknownField(value[0], item, key);
  }
  if (!isRecord(value)) return false;
  if (schema.additionalProperties === false) {
    value[key] = "unexpected";
    return true;
  }
  for (const [property, nested] of Object.entries(value)) {
    if (!isRecord(nested) && !Array.isArray(nested)) continue;
    const child = schema.properties?.[property];
    if (child !== undefined && addUnknownField(nested, child, key)) return true;
  }
  return false;
}

describe("opencode contracts", () => {
  test("every endpoint has a sample", () => {
    expect(ids.length).toBeGreaterThanOrEqual(70);
    for (const id of ids) expect(sampleOf(id)).toBeDefined();
  });

  test("no sample is left without an endpoint", () => {
    const recorded = readdirSync(SAMPLE_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
    for (const id of recorded) expect(ids).toContain(id);
    for (const id of events.keys()) expect(ids).toContain(id);
  });

  for (const id of ids) {
    test(`${id}: valid sample is accepted`, () => {
      expect(validateResponse(id, sampleOf(id))).toEqual({ ok: true });
    });

    test(`${id}: a sample missing a required field is rejected`, () => {
      const sample = structuredClone(sampleOf(id));
      const schema = read(join(SCHEMA_DIR, `${id}.json`)) as JsonSchema;
      if (!removeOneRequired(sample, schema)) {
        expect(schema.type).toBe("array");
        expect(validateResponse(id, {}).ok).toBe(false);
        return;
      }
      const result = validateResponse(id, sample);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
    });
  }

  // Which endpoints have a closed object in their own sample to stamp, computed once so the summary
  // below never depends on test execution order.
  function unknownFieldSample(id: string): unknown | null {
    const sample = structuredClone(sampleOf(id));
    const schema = read(join(SCHEMA_DIR, `${id}.json`)) as JsonSchema;
    return addUnknownField(sample, schema, "undeclaredField") ? sample : null;
  }

  const stampable = new Set(ids.filter((id) => unknownFieldSample(id) !== null));

  for (const id of ids) {
    test(`${id}: a sample with an unknown field is rejected`, () => {
      const sample = unknownFieldSample(id);
      if (sample === null) return;
      const result = validateResponse(id, sample);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const errors = result.errors.join("\n");
        expect(errors).toContain("additionalProperty");
        expect(errors).toContain("undeclaredField");
      }
    });
  }

  test("an unknown field is exercised on nearly every endpoint", () => {
    const skipped = ids.filter((id) => !stampable.has(id));
    // Only a sample with no closed object to stamp can be skipped: a bare array with no rows, or a
    // body whose keys are declared by its own additionalProperties schema.
    expect(skipped.sort()).toEqual(["config.get", "error.envelope", "worktree.list"]);
  });

  test("unknown endpoint is rejected", () => {
    const result = validateResponse("session.nonexistent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("unknown endpoint");
  });

  test("non-object sample is rejected", () => {
    expect(validateResponse("server.info", "not an object").ok).toBe(false);
  });

  // Negative controls: the mismatches the live TUI exposed must fail the validator.
  test("negative control: assistant message without agent is rejected", () => {
    const sample = structuredClone(sampleOf("session.messages")) as { data: Record<string, unknown>[] };
    const assistant = sample.data.find((message) => message.type === "assistant");
    expect(assistant).toBeDefined();
    delete assistant!.agent;
    const result = validateResponse("session.messages", sample);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("/data/2 must have required property 'agent'");
  });

  test("negative control: ISO timestamp instead of epoch millis is rejected", () => {
    const sample = structuredClone(sampleOf("session.messages")) as { data: Record<string, unknown>[] };
    const assistant = sample.data.find((message) => message.type === "assistant");
    expect(assistant).toBeDefined();
    assistant!.time = { created: "2026-11-05T08:00:00.000Z", completed: "2026-11-05T08:01:00.000Z" };
    const result = validateResponse("session.messages", sample);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("/data/2/time/created");
  });

  test("negative control: project time as ISO strings is rejected", () => {
    const sample = structuredClone(sampleOf("project.list")) as Record<string, unknown>[];
    expect(sample.length).toBeGreaterThan(0);
    sample[0]!.time = { created: "2026-11-05T08:00:00.000Z", updated: 1793854800000, active: 1793854800000 };
    expect(validateResponse("project.list", sample).ok).toBe(false);
  });

  // The TUI reads `location.directory` straight off the GET /api/location body
  // (`packages/client/src/solid/data.ts:2065`), and the bridge used to answer `{location: {...}}`.
  // This is the control that would have caught it: the wrapped body must not validate.
  test("negative control: a location.get body wrapped in a location envelope is rejected", () => {
    const bare = structuredClone(sampleOf("location.get")) as Record<string, unknown>;
    expect(bare).toHaveProperty("directory");
    expect(validateResponse("location.get", bare)).toEqual({ ok: true });
    const result = validateResponse("location.get", { location: bare });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("must have required property 'directory'");
  });

  test("error envelope carries _tag and message", () => {
    expect(() => assertErrorEnvelope({ _tag: "SessionNotFoundError", message: "missing" })).not.toThrow();
  });

  test("error envelope without _tag fails", () => {
    expect(() => assertErrorEnvelope({ message: "missing" })).toThrow(ContractError);
    expect(validateResponse("error.envelope", { message: "missing" }).ok).toBe(false);
  });

  test("error envelope without message fails", () => {
    expect(() => assertErrorEnvelope({ _tag: "UnknownError" })).toThrow(ContractError);
    expect(validateResponse("error.envelope", { _tag: "UnknownError" }).ok).toBe(false);
  });

  test("error envelope with a non-string message fails", () => {
    expect(() => assertErrorEnvelope({ _tag: "UnknownError", message: 42 })).toThrow(ContractError);
  });
});
