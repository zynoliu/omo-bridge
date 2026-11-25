import { describe, expect, test } from "bun:test";

import { ConfigError } from "../../src/bridge/features/config/state.ts";
import { SurfaceState } from "../../src/bridge/features/config/surfaces.ts";

const OK = { authorized: true };

describe("SurfaceState", () => {
  test("commands are stored and blanks dropped", () => {
    const state = new SurfaceState();
    expect(state.setCommands(["build", "", "test"], OK)).toEqual(["build", "test"]);
  });

  test("a client MCP registration never appears as a host registration", () => {
    const state = new SurfaceState();
    state.addMcp("client", "server-a", OK);
    expect(state.mcp().client).toEqual(["server-a"]);
    expect(state.mcp().host).toEqual([]);
    expect(state.isRegisteredOnlyOn("client", "server-a")).toBe(true);
    expect(state.isRegisteredOnlyOn("host", "server-a")).toBe(false);
  });

  test("host and client registrations are independent", () => {
    const state = new SurfaceState();
    state.addMcp("client", "shared", OK);
    state.addMcp("host", "shared", OK);
    expect(state.isRegisteredOnlyOn("client", "shared")).toBe(false);
    state.removeMcp("client", "shared", OK);
    expect(state.isRegisteredOnlyOn("host", "shared")).toBe(true);
  });

  test("unauthorised writes to commands or MCP are refused", () => {
    const state = new SurfaceState();
    const denied = { authorized: false };
    expect(() => state.setCommands(["x"], denied)).toThrow(ConfigError);
    expect(() => state.addMcp("client", "x", denied)).toThrow(ConfigError);
    expect(() => state.removeMcp("host", "x", denied)).toThrow(ConfigError);
    expect(state.commands()).toEqual([]);
    expect(state.mcp()).toEqual({ client: [], host: [] });
  });

  test("an empty MCP name is rejected with a dedicated code", () => {
    const state = new SurfaceState();
    try {
      state.addMcp("client", "", OK);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      if (error instanceof ConfigError) expect(error.code).toBe("INVALID_NAME");
    }
  });
});
