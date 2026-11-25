import { describe, expect, test } from "bun:test";

import type { SessionInfo } from "@opencode/client";

import { BridgeData } from "../src/data.ts";
import {
  readForkMessages,
  readLifecycle,
  readModelThinkingLevel,
  readNavigateOutcome,
  readPermission,
  readThinkingLevels,
  supportsThinkingLevel,
} from "../src/host-capabilities.ts";

describe("host capability decoders", () => {
  test("a child lifecycle needs its parent and task; a root lifecycle carries neither", () => {
    const child = {
      role: "child",
      rootSessionId: "root-1",
      parentSessionId: "parent-1",
      taskId: "task-1",
      state: "running",
    };
    expect(readLifecycle(child)).toEqual({
      role: "child",
      rootSessionId: "root-1",
      parentSessionId: "parent-1",
      taskId: "task-1",
    });
    expect(readLifecycle({ role: "root", rootSessionId: "root-1" })).toEqual({ role: "root", rootSessionId: "root-1" });
    expect(readLifecycle({ role: "child", rootSessionId: "root-1", parentSessionId: "parent-1" })).toBeUndefined();
    expect(readLifecycle({ role: "sibling", rootSessionId: "root-1" })).toBeUndefined();
    expect(readLifecycle(undefined)).toBeUndefined();
  });

  test("a model thinking level is only read when both the level and its level list are published", () => {
    expect(readModelThinkingLevel({ level: "high", source: "session", availableLevels: ["off", "high"] })).toEqual({
      level: "high",
      source: "session",
      availableLevels: ["off", "high"],
    });
    expect(readModelThinkingLevel({ level: "high", availableLevels: [] })).toEqual({
      level: "high",
      source: null,
      availableLevels: [],
    });
    expect(readModelThinkingLevel({ level: "high" })).toBeUndefined();
    expect(readThinkingLevels({ levels: ["off", "minimal"] })).toEqual(["off", "minimal"]);
    expect(readThinkingLevels({ levels: "off" })).toBeUndefined();
  });

  test("the approval decoder keeps absent source fields distinct from absent presets", () => {
    expect(
      readPermission({
        permissionPreset: "ask",
        permissionPresetSource: "client",
        permissionPresetStatus: "applied",
        effectivePermissionPreset: "ask",
      }),
    ).toEqual({ preset: "ask", source: "client", status: "applied", effective: "ask" });
    expect(readPermission({ permissionPreset: "full-access" })).toEqual({
      preset: "full-access",
      source: null,
      status: null,
      effective: null,
    });
    expect(readPermission({ permissionPresetStatus: "applied" })).toBeUndefined();
  });

  test("a navigate outcome reads a null leaf as the documented empty conversation", () => {
    expect(readNavigateOutcome({ outcome: "navigated", leafId: null })).toEqual({ outcome: "navigated", leafId: null });
    expect(readNavigateOutcome({ outcome: "navigated", leafId: "u1", editorText: "try again" })).toEqual({
      outcome: "navigated",
      leafId: "u1",
      editorText: "try again",
    });
    expect(readNavigateOutcome({ outcome: "cancelled", leafId: "u1" })).toEqual({ outcome: "cancelled", leafId: "u1" });
    expect(readNavigateOutcome({ outcome: "navigated" })).toBeUndefined();
    expect(readNavigateOutcome({ leafId: "u1" })).toBeUndefined();
  });

  test("a fork message list is refused whole when one row is malformed", () => {
    expect(readForkMessages({ messages: [{ entryId: "u1", text: "first" }] })).toEqual([{ entryId: "u1", text: "first" }]);
    expect(readForkMessages({ messages: [] })).toEqual([]);
    expect(readForkMessages({ messages: [{ entryId: "u1" }] })).toBeUndefined();
    expect(readForkMessages({})).toBeUndefined();
  });

  test("a level outside the host's list is not supported", () => {
    expect(supportsThinkingLevel("high", ["off", "high"])).toBe(true);
    expect(supportsThinkingLevel("xhigh", ["off", "high"])).toBe(false);
    expect(supportsThinkingLevel("bogus", [])).toBe(false);
  });
});

const hostSession: SessionInfo = {
  id: "ses_host",
  projectID: "prj_host",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  location: { directory: "/work" },
};

describe("BridgeData host state", () => {
  test("thinking and approval state are held per session and read back unchanged", () => {
    const data = new BridgeData();
    const thinking = { level: "high", source: "session", availableLevels: ["off", "high"] as const };
    const permission = { preset: "ask", source: "client", status: "applied", effective: "ask" };
    data.setHostThinking("ses_host", thinking);
    data.setHostPermission("ses_host", permission);
    expect(data.hostThinkingFor("ses_host")).toEqual(thinking);
    expect(data.hostPermissionFor("ses_host")).toEqual(permission);
    expect(data.hostThinkingFor("ses_other")).toBeUndefined();
    expect(data.hostPermissionFor("ses_other")).toBeUndefined();
  });

  test("a staged revert is reported on the session row and clearing it removes the field", () => {
    const data = new BridgeData();
    data.upsertHostSession(hostSession);
    data.setHostRevert("ses_host", { messageID: "u2" });
    expect(data.hostRevertFor("ses_host")).toEqual({ messageID: "u2" });
    expect(data.hostSession("ses_host")?.revert).toEqual({ messageID: "u2" });
    data.setHostRevert("ses_host", null);
    expect(data.hostRevertFor("ses_host")).toBeUndefined();
    expect(data.hostSession("ses_host")?.revert).toBeUndefined();
    expect(data.hostSession("ses_host")?.id).toBe("ses_host");
  });

  test("staging a revert for a session the host never delivered only records the boundary", () => {
    const data = new BridgeData();
    data.setHostRevert("ses_unknown", { messageID: "u9" });
    expect(data.hostRevertFor("ses_unknown")).toEqual({ messageID: "u9" });
    expect(data.hostSession("ses_unknown")).toBeUndefined();
  });
});
