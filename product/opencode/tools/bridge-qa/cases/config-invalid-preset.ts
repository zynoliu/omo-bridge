import type { CaseContext, CaseResult, Check } from "../run.ts";
import { ConfigError, ConfigState } from "../../../packages/tui/src/bridge/features/config/state.ts";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const state = new ConfigState();
  const allowed = ["prompt", "autoaccept"];
  state.setPermissionPreset("prompt", { authorized: true, allowed });
  let code = "none";
  try {
    state.setPermissionPreset("yolo", { authorized: true, allowed });
  } catch (error) {
    code = error instanceof ConfigError ? error.code : "untyped";
  }
  const after = state.snapshot();

  const checks: Check[] = [
    { name: "invalid-preset-rejected", expected: "INVALID_PRESET", observed: code, pass: code === "INVALID_PRESET" },
    {
      name: "previous-preset-kept",
      expected: "prompt",
      observed: String(after.permissionPreset),
      pass: after.permissionPreset === "prompt",
    },
    {
      name: "error-visible-not-silent",
      expected: "the failure raised rather than being applied quietly",
      observed: code === "none" ? "applied silently" : "raised",
      pass: code !== "none",
    },
  ];
  return { checks: checks, cleanup: { ok: true, detail: ["pure in-memory state"] } };
}
