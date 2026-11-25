import { existsSync, statSync } from "node:fs";

export type VmIsolation = {
  readonly ownDisk: boolean;
  readonly ownUser: boolean;
  readonly ownHome: boolean;
  readonly ownSocket: boolean;
};

export type VmGateInput = {
  readonly hostVersion: string;
  readonly imagePath: string | undefined;
  readonly isolation: VmIsolation;
};

export type VmGate = { readonly allowed: true } | { readonly allowed: false; readonly reasons: readonly string[] };

/** macOS guest provisioning needs macOS 27 on the host; earlier hosts must use the manual setup path. */
export function automaticProvisioningAvailable(hostVersion: string): boolean {
  const major = Number.parseInt(hostVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) return false;
  return major >= 27;
}

export function evaluateVmGate(input: VmGateInput): VmGate {
  const reasons: string[] = [];
  if (input.imagePath === undefined) reasons.push("no guest image supplied");
  else if (!existsSync(input.imagePath)) reasons.push("guest image path does not exist");
  else if (!statSync(input.imagePath).isFile()) reasons.push("guest image path is not a file");
  if (!input.isolation.ownDisk) reasons.push("guest does not have its own virtual disk");
  if (!input.isolation.ownUser) reasons.push("guest does not have its own user");
  if (!input.isolation.ownHome) reasons.push("guest does not have its own HOME");
  if (!input.isolation.ownSocket) reasons.push("guest does not have its own host socket");
  if (reasons.length > 0) return { allowed: false, reasons: reasons };
  return { allowed: true };
}
