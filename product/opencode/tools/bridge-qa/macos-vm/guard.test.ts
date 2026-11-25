import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { automaticProvisioningAvailable, evaluateVmGate } from "./guard.ts";

const isolation = { ownDisk: true, ownUser: true, ownHome: true, ownSocket: true };

function withImage<T>(body: (image: string) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), "bridge-macos-vm-guard-"));
  try {
    const image = path.join(root, "guest.ipsw");
    writeFileSync(image, "");
    return body(image);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("macOS VM acceptance gate", () => {
  test("a supplied image with full isolation lets the run proceed", () => {
    withImage((image) => {
      expect(evaluateVmGate({ hostVersion: "26.6.2", imagePath: image, isolation })).toEqual({ allowed: true });
    });
  });

  test("no image blocks the run instead of running an unverified guest", () => {
    const gate = evaluateVmGate({ hostVersion: "26.6.2", imagePath: undefined, isolation });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.reasons).toContain("no guest image supplied");
  });

  test("a path that is not a file blocks the run", () => {
    const gate = evaluateVmGate({ hostVersion: "26.6.2", imagePath: path.join(tmpdir(), "no-such-guest.ipsw"), isolation });
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) expect(gate.reasons).toContain("guest image path does not exist");
  });

  test("shared HOME, user, disk or socket blocks the run", () => {
    withImage((image) => {
      const gate = evaluateVmGate({
        hostVersion: "26.6.2",
        imagePath: image,
        isolation: { ownDisk: false, ownUser: false, ownHome: false, ownSocket: false },
      });
      expect(gate.allowed).toBe(false);
      if (!gate.allowed) expect(gate.reasons).toHaveLength(4);
    });
  });

  test("automatic provisioning is unavailable before macOS 27", () => {
    expect(automaticProvisioningAvailable("26.6.2")).toBe(false);
    expect(automaticProvisioningAvailable("27.0")).toBe(true);
    expect(automaticProvisioningAvailable("not-a-version")).toBe(false);
  });
});
