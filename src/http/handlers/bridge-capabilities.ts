import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonResponse, respond } from "./problem";

// GET /api/bridge/capabilities is a bridge-local route, not part of the TUI's protocol. It serves the
// same ledger that DEGRADATIONS.md and test/rule/capability.test.ts already own, so an operator can
// read which endpoint families the bridge cannot back without opening the repository.
// `server.info.capabilities` stays untouched: that struct is closed in packages/protocol.

export const CAPABILITY_LEDGER_FILE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "contracts",
  "bridge",
  "capabilities.json",
);

export type CapabilityFamily = {
  family: string;
  endpoints: string[];
  capability: boolean;
  tuiBehaviour: string;
  reason: string;
};

// No cache: the file is the single source of truth and a cached copy would be a second one.
export function readCapabilityLedger(file: string = CAPABILITY_LEDGER_FILE): CapabilityFamily[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed)) {
    throw new Error(`capability ledger must be a JSON array of families: ${file}`);
  }
  return parsed as CapabilityFamily[];
}

export async function handleBridgeCapabilities(_request: Request, url: URL): Promise<Response> {
  return respond(url, async () => jsonResponse(200, { data: readCapabilityLedger() }));
}
