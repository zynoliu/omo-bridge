import { describe, expect, test } from "bun:test";

import { CLIENT_API_GROUPS, UnimplementedApiGroup, createClientSurfaceStubs, unimplementedGroup } from "../src/client-surface.ts";

describe("client surface stubs", () => {
  test("every documented group has a stub", () => {
    const groups = createClientSurfaceStubs().map((stub) => stub.group);
    expect(groups).toEqual([...CLIENT_API_GROUPS]);
  });

  test("calling an unimplemented member throws with the group name", () => {
    const stub = unimplementedGroup("config");
    try {
      stub.call("registerServer");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(UnimplementedApiGroup);
      if (error instanceof UnimplementedApiGroup) {
        expect(error.group).toBe("config");
        expect(error.member).toBe("registerServer");
        expect(error.message).toContain("config.registerServer");
      }
    }
  });

  test("no stub returns a value", () => {
    for (const stub of createClientSurfaceStubs()) {
      expect(() => stub.call("anything")).toThrow(UnimplementedApiGroup);
    }
  });
});
