import { existsSync } from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { evaluateVmGate } from "../macos-vm/guard.ts";

/**
 * Task 30: native macOS verification inside an isolated virtual machine.
 *
 * That acceptance needs a real macOS guest with its own disk, user and HOME. When the environment cannot
 * provide one, the honest answer is BLOCKED - not a pass, and not a claim that the host works on macOS
 * because it works in a Linux container. This case therefore reports exactly what is missing and says
 * so, instead of skipping quietly.
 */
export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const detail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  /* The plan puts the VM controller in the checkout, so its presence is the first precondition. */
  const controller = path.resolve(context.qaRoot, "..", "bridge-qa", "macos-vm", "guard.ts");
  record(
    "vm-controller-exists",
    "tools/bridge-qa/macos-vm/guard.ts",
    existsSync(controller) ? "present" : "missing",
    existsSync(controller),
  );

  /* An environment variable naming a guest image is not a VM. The same gate the controller uses decides
     whether a run may proceed, and without a booted guest with its own disk, user and HOME it cannot. */
  const guestImage = process.env.BRIDGE_MACOS_GUEST_IMAGE;
  const gate = evaluateVmGate({
    hostVersion: process.getSystemVersion?.() ?? "unknown",
    imagePath: guestImage === undefined || guestImage.length === 0 ? undefined : guestImage,
    isolation: { ownDisk: false, ownUser: false, ownHome: false, ownSocket: false },
  });
  record(
    "guest-isolation-is-established",
    "a booted guest with its own disk, user, HOME and socket",
    gate.allowed ? "isolation established" : gate.reasons.join("; "),
    gate.allowed,
  );

  const host = process.platform === "darwin" ? process.getSystemVersion?.() ?? "unknown" : process.platform;
  detail.push("host macOS " + String(host) + "; a macOS guest with its own disk, user and HOME is required");
  detail.push("this case starts nothing: without a guest image there is no isolated VM to verify in");
  detail.push("verdict: BLOCKED - native macOS behaviour is unverified by this run");

  return {
    checks: checks,
    cleanup: { ok: true, detail: detail },
    blocked: checks.some((check) => !check.pass),
  };
}
