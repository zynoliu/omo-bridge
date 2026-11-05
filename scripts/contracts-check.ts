import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateEvent, validateResponse } from "../src/contract/validate";
import { compareSchemas } from "./contracts-extract";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SENPI_DIR = process.env.OMO_BRIDGE_CONTRACTS_SENPI_DIR ?? join(REPO_ROOT, "contracts", "senpi");

type FixtureRecord = { frame?: unknown; role?: unknown; endpoint?: unknown; source?: unknown; derived?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const errors: string[] = [];
let endpoints = 0;
let frames = 0;

try {
  const result = compareSchemas();
  endpoints = result.endpoints;
  errors.push(...result.errors);
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

console.log(`contracts: ok (opencode ${endpoints} endpoints, senpi ${frames} frames)`);
