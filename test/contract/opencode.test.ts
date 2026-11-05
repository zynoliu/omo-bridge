import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertErrorEnvelope, ContractError, validateResponse } from "../../src/contract/validate";

const CONTRACTS = join(import.meta.dir, "..", "..", "contracts", "opencode");
const SCHEMA_DIR = CONTRACTS;
const SAMPLE_DIR = join(CONTRACTS, "samples");

type JsonSchema = {
  type?: string;
  required?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  anyOf?: JsonSchema[];
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
