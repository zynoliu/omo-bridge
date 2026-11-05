import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertErrorEnvelope, ContractError, validateResponse } from "../../src/contract/validate";

const SCHEMA_DIR = join(import.meta.dir, "..", "..", "contracts", "opencode");
const SAMPLE_DIR = join(import.meta.dir, "fixtures", "opencode");

const ids = readdirSync(SCHEMA_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => name.replace(/\.json$/, ""))
  .sort();

function read(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("opencode contracts", () => {
  test("every endpoint has a sample", () => {
    expect(ids.length).toBeGreaterThanOrEqual(8);
    for (const id of ids) expect(read(join(SAMPLE_DIR, `${id}.json`))).toBeDefined();
  });

  for (const id of ids) {
    test(`${id}: valid sample is accepted`, () => {
      expect(validateResponse(id, read(join(SAMPLE_DIR, `${id}.json`)))).toEqual({ ok: true });
    });

    test(`${id}: tampered sample is rejected`, () => {
      const schema = read(join(SCHEMA_DIR, `${id}.json`)) as { required?: string[] };
      const required = schema.required ?? [];
      expect(required.length).toBeGreaterThan(0);
      const sample = read(join(SAMPLE_DIR, `${id}.json`)) as Record<string, unknown>;
      delete sample[required[0]!];
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
