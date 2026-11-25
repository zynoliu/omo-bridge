import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  COMPANION_EXTENSION_ENV,
  resolveCompanionExtension,
  stageCompanionExtensionProfile,
} from "../src/bridge-agent-profile.ts";
import { launchBridgeTui } from "../src/bridge-run.ts";

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function companion(directory: string): string {
  const entry = path.join(directory, "companion-extension.ts");
  writeFileSync(entry, "export default { name: 'bridge' }\n", { mode: 0o600 });
  return entry;
}

function document(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("the launcher's companion extension profile", () => {
  test("an existing document keeps its own settings and gains the companion entry", () => {
    const directory = scratch("bridge-profile-merge-");
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const entry = companion(directory);
      const file = path.join(agent, "settings.json");
      writeFileSync(file, JSON.stringify({ defaultModel: "host/model", extensions: ["/host/own.ts"] }) + "\n", {
        mode: 0o600,
      });

      const staged = stageCompanionExtensionProfile({ agentDir: agent, extensionEntry: entry });

      expect(staged?.action).toBe("updated");
      expect(staged?.extensions).toEqual(["/host/own.ts", entry]);
      expect(document(file)).toEqual({ defaultModel: "host/model", extensions: ["/host/own.ts", entry] });
      expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a host with no document gets one", () => {
    const directory = scratch("bridge-profile-create-");
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const entry = companion(directory);
      const staged = stageCompanionExtensionProfile({ agentDir: agent, extensionEntry: entry });
      expect(staged?.action).toBe("created");
      expect(document(path.join(agent, "settings.json"))).toEqual({ extensions: [entry] });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an entry the document already carries is not written again", () => {
    const directory = scratch("bridge-profile-unchanged-");
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const entry = companion(directory);
      const file = path.join(agent, "settings.json");
      const text = JSON.stringify({ extensions: [entry] }, null, 2) + "\n";
      writeFileSync(file, text, { mode: 0o600 });
      const before = statSync(file).mtimeMs;

      const staged = stageCompanionExtensionProfile({ agentDir: agent, extensionEntry: entry });

      expect(staged?.action).toBe("unchanged");
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(statSync(file).mtimeMs).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("nothing is written when no extension is present or configured", () => {
    const directory = scratch("bridge-profile-absent-");
    try {
      const agent = path.join(directory, "agent");
      const moduleDir = path.join(directory, "empty-launcher");
      mkdirSync(agent, { mode: 0o700 });
      mkdirSync(moduleDir);
      expect(resolveCompanionExtension({ agentDir: agent, moduleDir: moduleDir, environment: {} })).toBeUndefined();
      expect(stageCompanionExtensionProfile({ agentDir: agent, moduleDir: moduleDir, environment: {} })).toBeUndefined();
      expect(existsSync(path.join(agent, "settings.json"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a missing agent directory is left alone rather than created", () => {
    const directory = scratch("bridge-profile-missing-");
    try {
      const agent = path.join(directory, "agent");
      const entry = companion(directory);
      expect(stageCompanionExtensionProfile({ agentDir: agent, extensionEntry: entry })).toBeUndefined();
      expect(existsSync(agent)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the configured `off` writes nothing", () => {
    const directory = scratch("bridge-profile-off-");
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const staged = stageCompanionExtensionProfile({ agentDir: agent, environment: { [COMPANION_EXTENSION_ENV]: "off" } });
      expect(staged).toBeUndefined();
      expect(existsSync(path.join(agent, "settings.json"))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a shipped extension beside the launcher is discovered", () => {
    const directory = scratch("bridge-profile-discovery-");
    try {
      const moduleDir = path.join(directory, "packages", "cli", "src");
      const shipped = path.join(directory, "packages", "bridge-extension", "src", "extension.ts");
      mkdirSync(moduleDir, { recursive: true });
      mkdirSync(path.dirname(shipped), { recursive: true });
      writeFileSync(shipped, "export default { name: 'bridge' }\n");
      expect(resolveCompanionExtension({ agentDir: directory, moduleDir: moduleDir, environment: {} })).toBe(shipped);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a document that is not JSON is refused and left byte-identical", () => {
    const directory = scratch("bridge-profile-refused-");
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const file = path.join(agent, "settings.json");
      const text = "{ not json\n";
      writeFileSync(file, text, { mode: 0o600 });

      const staged = stageCompanionExtensionProfile({ agentDir: agent, extensionEntry: companion(directory) });

      expect(staged?.action).toBe("refused");
      expect(staged?.detail).toContain("could not be read");
      expect(readFileSync(file, "utf8")).toBe(text);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a symlinked settings document is never written through", () => {
    const directory = scratch("bridge-profile-symlink-");
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const target = path.join(directory, "elsewhere.json");
      writeFileSync(target, "{}\n", { mode: 0o600 });
      symlinkSync(target, path.join(agent, "settings.json"));

      const staged = stageCompanionExtensionProfile({ agentDir: agent, extensionEntry: companion(directory) });

      expect(staged?.action).toBe("refused");
      expect(readFileSync(target, "utf8")).toBe("{}\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the launcher stages the profile into the agent directory before it dials", async () => {
    const directory = scratch("bridge-profile-launch-");
    const previous = process.env[COMPANION_EXTENSION_ENV];
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      const entry = companion(directory);
      process.env[COMPANION_EXTENSION_ENV] = entry;

      const launched = await launchBridgeTui({
        socket: path.join(directory, "absent.sock"),
        keyRecord: path.join(agent, "rpc", "keys", "launch"),
        cwd: directory,
        mini: false,
        handshakeTimeoutMs: 200,
      });

      expect(launched.state).toBe("failed");
      expect(launched.code).toBe("dial_failed");
      expect(document(path.join(agent, "settings.json")).extensions).toEqual([entry]);
    } finally {
      if (previous === undefined) delete process.env[COMPANION_EXTENSION_ENV];
      else process.env[COMPANION_EXTENSION_ENV] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the launcher leaves the agent directory alone when the extension is turned off", async () => {
    const directory = scratch("bridge-profile-launch-off-");
    const previous = process.env[COMPANION_EXTENSION_ENV];
    try {
      const agent = path.join(directory, "agent");
      mkdirSync(agent, { mode: 0o700 });
      process.env[COMPANION_EXTENSION_ENV] = "off";

      const launched = await launchBridgeTui({
        socket: path.join(directory, "absent.sock"),
        keyRecord: path.join(agent, "rpc", "keys", "launch"),
        cwd: directory,
        mini: false,
        handshakeTimeoutMs: 200,
      });

      expect(launched.state).toBe("failed");
      expect(existsSync(path.join(agent, "settings.json"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env[COMPANION_EXTENSION_ENV];
      else process.env[COMPANION_EXTENSION_ENV] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
