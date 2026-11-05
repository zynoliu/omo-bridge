import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateEvent, validateResponse } from "../src/contract/validate";
import { compareSchemas, deriveSchemas } from "./contracts-extract";

const REPO_ROOT = resolve(import.meta.dir, "..");
const OPENCODE_DIR = process.env.OMO_BRIDGE_CONTRACTS_OPENCODE_DIR ?? join(REPO_ROOT, "contracts", "opencode");
const SAMPLE_DIR = process.env.OMO_BRIDGE_CONTRACTS_SAMPLE_DIR ?? join(OPENCODE_DIR, "samples");
const SENPI_DIR = process.env.OMO_BRIDGE_CONTRACTS_SENPI_DIR ?? join(REPO_ROOT, "contracts", "senpi");

type FixtureRecord = { frame?: unknown; role?: unknown; endpoint?: unknown; source?: unknown; derived?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const errors: string[] = [];
let endpoints = 0;
let samples = 0;
let frames = 0;

try {
  const result = compareSchemas();
  endpoints = result.endpoints;
  errors.push(...result.errors);
} catch (error) {
  errors.push(`opencode: ${(error as Error).message}`);
}

// Every endpoint carries one sample of the body it serves, and every sample must be consumed by
// the checked-in schema: a new field or a changed wire type is drift, not a documentary detail.
try {
  const expected = deriveSchemas();
  const recorded = new Map<string, unknown>();

  if (!existsSync(SAMPLE_DIR)) {
    errors.push(`opencode: sample dir missing: ${SAMPLE_DIR}`);
  } else {
    for (const name of readdirSync(SAMPLE_DIR).filter((entry) => entry.endsWith(".json")).sort()) {
      const id = name.slice(0, -".json".length);
      try {
        recorded.set(id, JSON.parse(readFileSync(join(SAMPLE_DIR, name), "utf8")));
      } catch (error) {
        errors.push(`opencode: sample ${name}: invalid JSON (${(error as Error).message})`);
      }
    }
    const eventsPath = join(SAMPLE_DIR, "events.jsonl");
    if (existsSync(eventsPath)) {
      const lines = readFileSync(eventsPath, "utf8").split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!line.trim()) continue;
        const where = `opencode: sample events.jsonl:${index + 1}`;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch (error) {
          errors.push(`${where}: invalid JSON (${(error as Error).message})`);
          continue;
        }
        if (!isRecord(record) || typeof record.endpoint !== "string" || !isRecord(record.frame)) {
          errors.push(`${where}: record needs an endpoint string and a frame object`);
          continue;
        }
        if (record.frame.type !== record.endpoint) {
          errors.push(`${where}: frame type ${JSON.stringify(record.frame.type)} does not match endpoint ${record.endpoint}`);
        }
        recorded.set(`event.${record.endpoint}`, record.frame);
      }
    }
  }

  for (const id of expected.keys()) {
    if (!recorded.has(id)) errors.push(`opencode: ${id}: sample missing in ${SAMPLE_DIR}`);
  }
  for (const id of recorded.keys()) {
    if (!expected.has(id)) errors.push(`opencode: ${id}: sample has no endpoint`);
  }

  for (const [id, sample] of recorded) {
    if (!expected.has(id)) continue;
    try {
      const result = validateResponse(id, sample);
      if (!result.ok) for (const message of result.errors) errors.push(`opencode: sample ${id}: ${message}`);
    } catch (error) {
      errors.push(`opencode: sample ${id}: ${(error as Error).message}`);
    }
    samples += 1;
  }
} catch (error) {
  errors.push(`opencode: ${(error as Error).message}`);
}

if (!existsSync(SENPI_DIR)) {
  errors.push(`senpi: fixture dir missing: ${SENPI_DIR}`);
} else {
  const files = readdirSync(SENPI_DIR).filter((name) => name.endsWith(".jsonl")).sort();
  if (files.length === 0) errors.push(`senpi: no fixtures in ${SENPI_DIR}`);
  for (const name of files) {
    const lines = readFileSync(join(SENPI_DIR, name), "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      frames += 1;
      const where = `senpi: ${name}:${index + 1}`;
      let record: FixtureRecord;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) {
          errors.push(`${where}: record is not an object`);
          continue;
        }
        record = parsed as FixtureRecord;
      } catch (error) {
        errors.push(`${where}: invalid JSON (${(error as Error).message})`);
        continue;
      }
      if (!isRecord(record.frame)) {
        errors.push(`${where}: record has no frame object`);
        continue;
      }
      if (typeof record.endpoint !== "string" || record.endpoint.length === 0) {
        errors.push(`${where}: record has no endpoint`);
        continue;
      }
      if (record.source !== "live" && record.source !== "derived") {
        errors.push(`${where}: source must be "live" or "derived"`);
      }
      if (record.source === "derived" && record.derived !== true) errors.push(`${where}: derived fixture must carry derived: true`);
      if (record.source === "live" && record.derived === true) errors.push(`${where}: live fixture must not claim derived: true`);

      const frame = record.frame;
      if (record.role === "request") {
        if (frame.type !== record.endpoint) errors.push(`${where}: request type ${JSON.stringify(frame.type)} does not match endpoint ${record.endpoint}`);
        continue;
      }
      if (record.role === "response") {
        const result = validateResponse(record.endpoint, frame);
        if (!result.ok) for (const message of result.errors) errors.push(`${where}: ${record.endpoint}: ${message}`);
        continue;
      }
      if (record.role === "event") {
        const result = validateEvent(record.endpoint, frame);
        if (!result.ok) for (const message of result.errors) errors.push(`${where}: ${message}`);
        continue;
      }
      errors.push(`${where}: role must be request, response or event`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(`contracts: ok (opencode ${endpoints} endpoints, ${samples} samples, senpi ${frames} frames)`);
