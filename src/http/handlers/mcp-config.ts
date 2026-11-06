import { readFileSync } from "node:fs";
import { join } from "node:path";

// GET /api/mcp reports the MCP servers the host was configured with, not a live connection: the two
// config files name them and the host's discovery cache records which were seen at least once.

export type McpServerRow = {
  name: string;
  status: { status: "connected" } | { status: "disabled" } | { status: "pending" };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return isRecord(parsed) ? parsed : undefined;
}

function configuredServers(path: string): Map<string, unknown> {
  const servers = new Map<string, unknown>();
  const config = readJsonObject(path);
  if (config === undefined) return servers;
  const map = config.mcpServers;
  if (!isRecord(map)) return servers;
  for (const [name, entry] of Object.entries(map)) servers.set(name, entry);
  return servers;
}

function discoveredServers(agentDir: string): Set<string> {
  const names = new Set<string>();
  const cache = readJsonObject(join(agentDir, "cache", "mcp-cache.json"));
  if (cache === undefined) return names;
  const servers = cache.servers;
  if (!isRecord(servers)) return names;
  for (const name of Object.keys(servers)) names.add(name);
  return names;
}

/**
 * One row per configured server, sorted by name. Status is last known, never a live probe:
 * - disabled: the winning config entry carries `disabled: true`.
 * - connected: the host's discovery cache has an entry for the server.
 * - pending: configured, but the host has never reported discovering it.
 *
 * The project config (`<directory>/.opencode/mcp.json`) wins a name collision with the agent one, so
 * it decides `disabled`. Any missing, unreadable or malformed file contributes no rows; nothing throws.
 */
export function listMcpServers(agentDir: string, directory: string): McpServerRow[] {
  const merged = configuredServers(join(agentDir, "mcp.json"));
  for (const [name, entry] of configuredServers(join(directory, ".opencode", "mcp.json"))) merged.set(name, entry);
  const discovered = discoveredServers(agentDir);

  const rows: McpServerRow[] = [];
  for (const [name, entry] of merged) {
    const status = isRecord(entry) && entry.disabled === true
      ? ("disabled" as const)
      : discovered.has(name)
        ? ("connected" as const)
        : ("pending" as const);
    rows.push({ name, status: { status } });
  }
  rows.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return rows;
}
