import { describe, expect, test } from "bun:test";
import pkg from "../package.json";

describe("scaffold", () => {
  test("package name and pinned senpi version", () => {
    expect(pkg.name).toBe("omo-bridge");
    expect(pkg.dependencies["@code-yeongyu/senpi"]).toBe("2026.11.4-2");
  });
});
