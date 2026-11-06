import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listMcpServers } from "../../src/http/handlers/mcp-config";

function writeConfig(path: string, servers: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
}

describe("listMcpServers", () => {
  let root = "";
  let agentDir = "";
  let directory = "";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omo-bridge-mcp-list-"));
    agentDir = join(root, "agent");
    directory = join(root, "project");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(directory, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("no mcp.json anywhere yields no rows", () => {
    expect(listMcpServers(agentDir, directory)).toEqual([]);
  });

  test("a configured server with no discovery cache is pending", () => {
    writeConfig(join(agentDir, "mcp.json"), {
      context7: { type: "http", url: "https://example.invalid/mcp" },
    });

    expect(listMcpServers(agentDir, directory)).toEqual([
      { name: "context7", status: { status: "pending" } },
    ]);
  });

  test("a cached server is connected", () => {
    writeConfig(join(agentDir, "mcp.json"), {
      context7: { type: "http", url: "https://example.invalid/mcp" },
    });
    mkdirSync(join(agentDir, "cache"), { recursive: true });
    writeFileSync(
      join(agentDir, "cache", "mcp-cache.json"),
      JSON.stringify({ version: 1, servers: { context7: { configHash: "x", fetchedAt: 1 } } }),
    );

    expect(listMcpServers(agentDir, directory)).toEqual([
      { name: "context7", status: { status: "connected" } },
    ]);
  });

  test("a disabled server stays disabled even when the cache knows it", () => {
    writeConfig(join(agentDir, "mcp.json"), {
      context7: { type: "http", url: "https://example.invalid/mcp", disabled: true },
    });
    mkdirSync(join(agentDir, "cache"), { recursive: true });
    writeFileSync(
      join(agentDir, "cache", "mcp-cache.json"),
      JSON.stringify({ version: 1, servers: { context7: { configHash: "x", fetchedAt: 1 } } }),
    );

    expect(listMcpServers(agentDir, directory)).toEqual([
      { name: "context7", status: { status: "disabled" } },
    ]);
  });

  test("a malformed config is ignored without throwing", () => {
    writeFileSync(join(agentDir, "mcp.json"), "{ this is not json");

    expect(listMcpServers(agentDir, directory)).toEqual([]);
  });

  test("the project config merges over the agent config and can disable a server", () => {
    writeConfig(join(agentDir, "mcp.json"), {
      alpha: { type: "http", url: "https://example.invalid/alpha" },
      beta: { type: "http", url: "https://example.invalid/beta" },
    });
    writeConfig(join(directory, ".opencode", "mcp.json"), {
      beta: { type: "http", url: "https://example.invalid/beta", disabled: true },
    });

    expect(listMcpServers(agentDir, directory)).toEqual([
      { name: "alpha", status: { status: "pending" } },
      { name: "beta", status: { status: "disabled" } },
    ]);
  });
});
