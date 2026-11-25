import { describe, expect, test } from "bun:test";

import { registerSessionServers, unregisterSessionServers } from "../src/host.ts";

function api() {
  const registered: { name: string; config: unknown }[] = [];
  const removed: string[] = [];
  return {
    registered: registered,
    removed: removed,
    registerMcpServer: (name: string, config: unknown) => registered.push({ name: name, config: config }),
    unregisterMcpServer: (name: string) => removed.push(name),
  };
}

describe("host mcp registration", () => {
  test("a valid stdio server is registered with exactly its declared fields", () => {
    const host = api();
    const outcomes = registerSessionServers(host, [
      { name: "bridge-tools", config: { type: "stdio", command: "bun", args: ["run", "server.ts"], env: { TOKEN: "x" } } },
    ]);
    expect(outcomes[0]?.kind).toBe("registered");
    expect(host.registered).toEqual([
      { name: "bridge-tools", config: { type: "stdio", command: "bun", args: ["run", "server.ts"], env: { TOKEN: "x" } } },
    ]);
  });

  test("an invalid server is refused and never handed to the host", () => {
    const host = api();
    const outcomes = registerSessionServers(host, [{ name: "bad", config: { type: "http", url: "http://x" } }]);
    expect(outcomes[0]?.kind).toBe("refused");
    expect(host.registered).toEqual([]);
  });

  test("one bad server does not stop the others", () => {
    const host = api();
    const outcomes = registerSessionServers(host, [
      { name: "bad", config: { type: "stdio" } },
      { name: "good", config: { type: "stdio", command: "bun" } },
    ]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["refused", "registered"]);
    expect(host.registered.map((entry) => entry.name)).toEqual(["good"]);
  });

  test("unregistering reports how many were removed", () => {
    const host = api();
    expect(unregisterSessionServers(host, ["a", "b"])).toBe(2);
    expect(host.removed).toEqual(["a", "b"]);
  });
});
