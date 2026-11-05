import { describe, expect, test } from "bun:test";
import { ConfigError, configDefaults, resolveConfig } from "../../src/config";

function catchConfigError(env: Record<string, string | undefined>): unknown {
  try {
    resolveConfig(env);
  } catch (error) {
    return error;
  }
  return null;
}

describe("resolveConfig", () => {
  test("missing password throws the documented message", () => {
    const error = catchConfigError({});
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe("OMO_BRIDGE_PASSWORD is required");
  });

  test("empty password is treated as missing", () => {
    const error = catchConfigError({ OMO_BRIDGE_PASSWORD: "" });
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe("OMO_BRIDGE_PASSWORD is required");
  });

  test("defaults apply when only the password is set", () => {
    expect(resolveConfig({ OMO_BRIDGE_PASSWORD: "secret" })).toEqual({
      port: 4319,
      host: "127.0.0.1",
      password: "secret",
      stateDir: "./state",
    });
  });

  test("environment overrides are honoured", () => {
    expect(
      resolveConfig({
        OMO_BRIDGE_PASSWORD: "secret",
        OMO_BRIDGE_PORT: "5000",
        OMO_BRIDGE_HOST: "0.0.0.0",
        OMO_BRIDGE_STATE_DIR: "/tmp/bridge-state",
      }),
    ).toEqual({ port: 5000, host: "0.0.0.0", password: "secret", stateDir: "/tmp/bridge-state" });
  });

  test("port 0 is accepted for an ephemeral bind", () => {
    expect(resolveConfig({ OMO_BRIDGE_PASSWORD: "secret", OMO_BRIDGE_PORT: "0" }).port).toBe(0);
  });

  test("invalid port values are rejected", () => {
    for (const port of ["abc", "-1", "70000", "1.5"]) {
      const error = catchConfigError({ OMO_BRIDGE_PASSWORD: "secret", OMO_BRIDGE_PORT: port });
      expect(error).toBeInstanceOf(ConfigError);
    }
  });

  test("defaults are documented once", () => {
    expect(configDefaults).toEqual({ port: 4319, host: "127.0.0.1", stateDir: "./state" });
  });
});
