import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  answerForEffect,
  decidePermission,
  loadPermissionRuleDocument,
  matchesRulePattern,
  parsePermissionRuleDocument,
  PERMISSION_DIALOG_TITLE,
  permissionAskOfTitle,
  permissionRulesPath,
  PermissionRuleError,
  SessionPermissionRules,
} from "../src/permission-rules.ts";
import type { PermissionRule } from "../src/permission-rules.ts";

/* Titles copied from the real host's dialogs (2026-11-24 runs against bridge-host-official:5.1.75). */
const EVAL_TITLE = "Permission required: eval\n\nTool: eval\n\nPatterns:\n  - *";
const BASH_TITLE = "Permission required: bash\n\nCommand: $ cat /work/approval-probe.txt\n\nPatterns:\n  - cat";
const READ_TITLE = "Permission required: read\n\nPath: /work/a.txt";
const WRITE_TITLE = "Permission required: write /workspace/bridge-t17-stale.txt";
const NETWORK_TITLE = "Permission required: network";

describe("permission ask parsing", () => {
  test("the action is the first token after the prefix and the resource is the labelled value", () => {
    expect(permissionAskOfTitle(EVAL_TITLE)).toEqual({ action: "eval", resource: "eval", title: EVAL_TITLE });
    expect(permissionAskOfTitle(BASH_TITLE)?.resource).toBe("$ cat /work/approval-probe.txt");
    expect(permissionAskOfTitle(READ_TITLE)).toEqual({ action: "read", resource: "/work/a.txt", title: READ_TITLE });
    expect(permissionAskOfTitle(WRITE_TITLE)?.resource).toBe("/workspace/bridge-t17-stale.txt");
    expect(permissionAskOfTitle(NETWORK_TITLE)).toEqual({ action: "network", resource: "", title: NETWORK_TITLE });
  });

  test("a dialog that is not a permission prompt has no ask", () => {
    expect(permissionAskOfTitle("Pick a database")).toBeUndefined();
    expect(permissionAskOfTitle(PERMISSION_DIALOG_TITLE)).toBeUndefined();
  });
});

describe("permission rule matching", () => {
  test("`*` matches any run of characters and everything else is literal", () => {
    expect(matchesRulePattern("*", "bash")).toBe(true);
    expect(matchesRulePattern("bash", "bash")).toBe(true);
    expect(matchesRulePattern("bash", "bashful")).toBe(false);
    expect(matchesRulePattern("*probe*", "$ cat /work/approval-probe.txt")).toBe(true);
    expect(matchesRulePattern("/work/*", "/work/a.txt")).toBe(true);
    expect(matchesRulePattern("/work/*", "/other/a.txt")).toBe(false);
    expect(matchesRulePattern("$ cat *", "$ cat /work/approval-probe.txt")).toBe(true);
  });

  test("the first matching rule decides and a set with no match leaves the ask to the dialog", () => {
    const rules: readonly PermissionRule[] = [
      { action: "eval", resource: "*", effect: "deny", reason: "eval is off-limits" },
      { action: "*", resource: "*", effect: "allow" },
    ];
    expect(decidePermission(rules, permissionAskOfTitle(EVAL_TITLE)!).effect).toBe("deny");
    expect(decidePermission(rules, permissionAskOfTitle(READ_TITLE)!).effect).toBe("allow");
    expect(decidePermission([], permissionAskOfTitle(READ_TITLE)!).effect).toBe("ask");
    expect(decidePermission(undefined, permissionAskOfTitle(READ_TITLE)!).effect).toBe("ask");
  });
});

describe("permission answers", () => {
  test("an allow answers `Allow once` so the host neither saves nor widens anything", () => {
    expect(answerForEffect("allow", ["Allow once", "Allow always", "Deny"])).toEqual({
      value: "Allow once",
      effect: "allow",
      wantsFeedback: false,
    });
  });

  test("a deny with a reason travels through the host's feedback dialog, which is what the model reads", () => {
    const options = ["Allow once", "Allow always", "Deny", "Deny with feedback"];
    expect(answerForEffect("deny", options, "blocked by a session rule")).toEqual({
      value: "Deny with feedback",
      effect: "deny",
      wantsFeedback: true,
    });
    expect(answerForEffect("deny", options)).toEqual({ value: "Deny", effect: "deny", wantsFeedback: false });
  });

  test("a dialog whose options cannot carry the effect is left to the dialog", () => {
    expect(answerForEffect("allow", ["Deny"])).toBeUndefined();
    expect(answerForEffect("deny", ["Allow once"])).toBeUndefined();
  });
});

describe("permission rule document", () => {
  test("a document round-trips through JSON", () => {
    const rules: readonly PermissionRule[] = [
      { action: "read", resource: "/work/*", effect: "allow" },
      { action: "eval", resource: "*", effect: "deny", reason: "no eval" },
    ];
    const document = parsePermissionRuleDocument(JSON.parse(JSON.stringify({ version: 1, sessions: { ses_1: rules } })));
    expect(document.sessions["ses_1"]).toEqual(rules);
  });

  test("a malformed rule is refused by path instead of dropped", () => {
    let thrown: unknown;
    try {
      parsePermissionRuleDocument({ version: 1, sessions: { ses_1: [{ action: "read", resource: "*", effect: "maybe" }] } });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PermissionRuleError);
    expect((thrown as PermissionRuleError).code).toBe("INVALID_RULE");
    expect((thrown as PermissionRuleError).path).toBe("document.sessions.ses_1[0].effect");
    expect(() => parsePermissionRuleDocument({ version: 2, sessions: {} })).toThrow(PermissionRuleError);
  });

  test("the file helpers read the config document and treat an absent file as no rules", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "bridge-rules-"));
    const file = permissionRulesPath(directory);
    expect(loadPermissionRuleDocument(file)).toBeUndefined();
    writeFileSync(
      file,
      JSON.stringify({ version: 1, sessions: { ses_1: [{ action: "*", resource: "*", effect: "ask" }] } }),
      { mode: 0o600 },
    );
    expect(loadPermissionRuleDocument(file)?.sessions["ses_1"]?.[0]?.effect).toBe("ask");
    expect(readFileSync(file, "utf8")).toContain('"version":1');
  });

  test("the live rule set answers per session and tells subscribers about a change", () => {
    const rules = new SessionPermissionRules({
      version: 1,
      sessions: { ses_1: [{ action: "eval", resource: "*", effect: "deny", reason: "no eval" }] },
    });
    const seen: string[] = [];
    rules.subscribe((change) => seen.push(change.sessionID + ":" + String(change.rules.length)));
    expect(rules.decide("ses_1", permissionAskOfTitle(EVAL_TITLE)!).effect).toBe("deny");
    expect(rules.decide("ses_2", permissionAskOfTitle(EVAL_TITLE)!).effect).toBe("ask");
    rules.set("ses_2", [{ action: "*", resource: "*", effect: "allow" }]);
    expect(rules.decide("ses_2", permissionAskOfTitle(READ_TITLE)!).effect).toBe("allow");
    expect(seen).toEqual(["ses_2:1"]);
    expect(rules.sessionIds()).toEqual(["ses_1", "ses_2"]);
    expect(rules.rulesFor("ses_2")).toEqual([{ action: "*", resource: "*", effect: "allow" }]);
  });
});
