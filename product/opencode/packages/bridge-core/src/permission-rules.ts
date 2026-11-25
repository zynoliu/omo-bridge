import { readFileSync } from "node:fs";

import { ascendingIdentifier } from "./id-scheme.ts";

/**
 * Per-session permission rules the bridge keeps and enforces on the host's ask.
 *
 * The host publishes one approval preset per session (`get_state.permissionPreset` and
 * `effectivePermissionPreset`) and raises a `select` dialog per gated tool call; it has no per-session
 * rule document and emits no `session.permissions` event. The client contract does have one:
 * `Permission.Rule { action, resource, effect }` and `SessionInfo.permissions: PermissionRuleset`.
 * This module is that document, kept with the bridge's own config and keyed by the durable session id,
 * so a rule can answer a dialog before it is shown.
 *
 * The host's preset stays the outer boundary. Under `full-access` the host raises no dialog at all,
 * so a deny rule has nothing to refuse; under any other preset every gated call still reaches this
 * module first. Nothing here can widen what the host allows.
 */

export const PERMISSION_DIALOG_TITLE = "Permission required:";

export type PermissionEffect = "allow" | "deny" | "ask";

export type PermissionRule = {
  readonly action: string;
  readonly resource: string;
  readonly effect: PermissionEffect;
  /** Recorded on the session and on the decision; the host's refusal text is what the model reads. */
  readonly reason?: string;
};

export type PermissionRuleset = readonly PermissionRule[];

export const RULES_DOCUMENT_VERSION = 1;

export type PermissionRuleDocument = {
  readonly version: typeof RULES_DOCUMENT_VERSION;
  readonly sessions: Readonly<Record<string, PermissionRuleset>>;
};

export const PERMISSION_RULES_FILE = "bridge-permissions.json";

export type PermissionRuleFailureCode = "INVALID_DOCUMENT" | "INVALID_RULE";

export class PermissionRuleError extends Error {
  readonly code: PermissionRuleFailureCode;
  readonly path: string;
  constructor(code: PermissionRuleFailureCode, path: string, detail: string) {
    super(code + " at " + path + (detail.length === 0 ? "" : ": " + detail));
    this.name = "PermissionRuleError";
    this.code = code;
    this.path = path;
  }
}

/** One gated tool call as the host's dialog title describes it. */
export type PermissionAsk = {
  readonly action: string;
  readonly resource: string;
  readonly title: string;
};

export type PermissionDecision = {
  readonly effect: PermissionEffect;
  readonly rule: PermissionRule | undefined;
  readonly reason: string;
};

/** What the host's permission dialog looks like as a value: only the title and the offered labels. */
export type PermissionAnswer = {
  /** The option label the host accepts as the answer. */
  readonly value: string;
  readonly effect: "allow" | "deny";
  /**
   * `Deny with feedback` raises one more `input` dialog (`title: "Feedback"`, same `toolCallId`) whose
   * text the host puts in front of the model. A deny answer with this flag owes that dialog an answer.
   */
  readonly wantsFeedback: boolean;
};

/**
 * Reads the ask out of the host's dialog title. The host writes
 * `Permission required: <action>` on the first line and, when it has a resource, a `<Label>: <value>`
 * line under it (`Path:`, `Command:`, `Tool:`), optionally followed by a `Patterns:` block:
 *
 *   Permission required: read\n\nPath: /work/a.txt
 *   Permission required: bash\n\nCommand: $ cat /work/a.txt\n\nPatterns:\n  - cat
 *   Permission required: write /workspace/x.txt
 *
 * The action is the first token after the prefix. The resource is the first labelled value; a label
 * with an empty value takes the next line's pattern. A title with neither keeps the rest of the action
 * line as the resource, and an empty resource matches only the `*` pattern.
 */
export function permissionAskOfTitle(title: string): PermissionAsk | undefined {
  if (!title.startsWith(PERMISSION_DIALOG_TITLE)) return undefined;
  const lines = title
    .slice(PERMISSION_DIALOG_TITLE.length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const first = lines[0];
  if (first === undefined) return undefined;
  const [action, ...restOfFirst] = first.split(/\s+/);
  if (action === undefined || action.length === 0) return undefined;
  let resource = restOfFirst.join(" ");
  for (let index = 1; index < lines.length; index += 1) {
    const labelled = /^([A-Za-z][A-Za-z ]{0,24}):\s*(.*)$/.exec(lines[index] ?? "");
    if (labelled === null) continue;
    const value = (labelled[2] ?? "").trim();
    if (value.length > 0) {
      resource = value;
    } else {
      const next = lines[index + 1];
      resource = next === undefined ? "" : next.replace(/^-\s*/, "").trim();
    }
    break;
  }
  return { action: action, resource: resource, title: title };
}

/** `*` matches any run of characters; every other character is literal; matching is whole-value. */
export function matchesRulePattern(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const escaped = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + escaped.join(".*") + "$").test(value);
}

export function ruleMatches(rule: PermissionRule, ask: PermissionAsk): boolean {
  return matchesRulePattern(rule.action, ask.action) && matchesRulePattern(rule.resource, ask.resource);
}

/**
 * The first matching rule decides; a rule set with no match leaves the ask to the dialog, which is the
 * behaviour the host preset already had. A deny rule's reason is recorded here, but the text the model
 * reads is the host's own refusal sentence.
 */
export function decidePermission(rules: PermissionRuleset | undefined, ask: PermissionAsk): PermissionDecision {
  for (const rule of rules ?? []) {
    if (!ruleMatches(rule, ask)) continue;
    return { effect: rule.effect, rule: rule, reason: rule.reason ?? "session rule " + rule.action + " " + rule.resource };
  }
  return { effect: "ask", rule: undefined, reason: "no session rule matches this ask" };
}

/**
 * The label to answer the host's dialog with.
 *
 * An allow rule answers `Allow once`: the rule is the decision, so the host neither saves a permission
 * of its own nor widens its preset. A deny rule answers `Deny`, or `Deny with feedback` when it carries
 * a reason and the host offers that choice, because only the feedback path puts the reason in front of
 * the model (measured: the model then reads "...with the following feedback: <reason>"). A dialog whose
 * options carry neither label is left to the dialog instead of being answered with a label that means
 * something else.
 */
export function answerForEffect(
  effect: "allow" | "deny",
  options: readonly string[],
  reason?: string,
): PermissionAnswer | undefined {
  if (effect === "allow") {
    const allow = preferOption(options, ["Allow once", "Allow always", "Always allow"], (option) => option.startsWith("Allow"));
    return allow === undefined ? undefined : { value: allow, effect: "allow", wantsFeedback: false };
  }
  if (reason !== undefined && reason.length > 0 && options.includes("Deny with feedback")) {
    return { value: "Deny with feedback", effect: "deny", wantsFeedback: true };
  }
  const deny = preferOption(options, ["Deny"], (option) => option.startsWith("Deny") && !option.includes("feedback"));
  return deny === undefined ? undefined : { value: deny, effect: "deny", wantsFeedback: false };
}

function preferOption(
  options: readonly string[],
  preferred: readonly string[],
  accept: (option: string) => boolean,
): string | undefined {
  for (const label of preferred) {
    if (options.includes(label)) return label;
  }
  return options.find(accept);
}

function readRule(raw: unknown, path: string): PermissionRule {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PermissionRuleError("INVALID_RULE", path, "a rule is an object");
  }
  const fields = raw as Readonly<Record<string, unknown>>;
  const action = fields.action;
  const resource = fields.resource;
  const effect = fields.effect;
  if (typeof action !== "string" || action.length === 0) {
    throw new PermissionRuleError("INVALID_RULE", path + ".action", "expected a non-empty pattern");
  }
  if (typeof resource !== "string") {
    throw new PermissionRuleError("INVALID_RULE", path + ".resource", "expected a pattern (\"*\" for any resource)");
  }
  if (effect !== "allow" && effect !== "deny" && effect !== "ask") {
    throw new PermissionRuleError("INVALID_RULE", path + ".effect", String(effect));
  }
  const reason = fields.reason;
  if (reason !== undefined && typeof reason !== "string") {
    throw new PermissionRuleError("INVALID_RULE", path + ".reason", "expected a string");
  }
  return {
    action: action,
    resource: resource,
    effect: effect,
    ...(typeof reason === "string" ? { reason: reason } : {}),
  };
}

export function readRuleset(raw: unknown, path: string): PermissionRuleset {
  if (!Array.isArray(raw)) throw new PermissionRuleError("INVALID_RULE", path, "expected an array of rules");
  return raw.map((entry, index) => readRule(entry, path + "[" + String(index) + "]"));
}

/** A document that does not decode is refused by name; the caller decides whether to run without rules. */
export function parsePermissionRuleDocument(raw: unknown): PermissionRuleDocument {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PermissionRuleError("INVALID_DOCUMENT", "document", "expected an object");
  }
  const fields = raw as Readonly<Record<string, unknown>>;
  if (fields.version !== RULES_DOCUMENT_VERSION) {
    throw new PermissionRuleError("INVALID_DOCUMENT", "document.version", String(fields.version));
  }
  const sessions = fields.sessions;
  if (sessions === undefined) return { version: RULES_DOCUMENT_VERSION, sessions: {} };
  if (typeof sessions !== "object" || sessions === null || Array.isArray(sessions)) {
    throw new PermissionRuleError("INVALID_DOCUMENT", "document.sessions", "expected an object keyed by session id");
  }
  const decoded: Record<string, PermissionRuleset> = {};
  for (const [sessionID, rules] of Object.entries(sessions as Readonly<Record<string, unknown>>)) {
    decoded[sessionID] = readRuleset(rules, "document.sessions." + sessionID);
  }
  return { version: RULES_DOCUMENT_VERSION, sessions: decoded };
}

export function permissionRulesPath(configDirectory: string): string {
  return configDirectory.replace(/\/+$/, "") + "/" + PERMISSION_RULES_FILE;
}

/** An absent file is an empty rule set, which leaves every ask to the dialog. */
export function loadPermissionRuleDocument(path: string): PermissionRuleDocument | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PermissionRuleError("INVALID_DOCUMENT", path, "not valid JSON");
  }
  return parsePermissionRuleDocument(parsed);
}

export type PermissionRuleChange = { readonly sessionID: string; readonly rules: PermissionRuleset };

/** Two rule sets decide the same asks, so re-reporting one is not a change. */
export function samePermissionRules(left: PermissionRuleset, right: PermissionRuleset): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((rule, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      rule.action === other.action &&
      rule.resource === other.resource &&
      rule.effect === other.effect &&
      (rule.reason ?? "") === (other.reason ?? "")
    );
  });
}

/**
 * The client union's own `session.permissions` member. The host never writes it (it publishes a preset and
 * raises a dialog), so the bridge publishes it from its own document: a subscriber reading the client
 * event stream learns the effective rules of a session when they load, change, or are cleared.
 */
export type SessionPermissionsEvent = {
  readonly id: string;
  readonly type: "session.permissions";
  readonly created: number;
  readonly location?: { readonly directory: string };
  readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: 1 };
  readonly data: { readonly sessionID: string; readonly permissions: PermissionRuleset };
};

export type SessionPermissionsContext = {
  /** The session's directory when it is known; the client member allows an absent location. */
  readonly location?: { readonly directory: string };
  /** The live stream is not replayed, so this only orders the events this producer emits. */
  readonly sequence: () => number;
  readonly now?: () => number;
};

export function sessionPermissionsEvent(
  sessionID: string,
  rules: PermissionRuleset,
  context: SessionPermissionsContext,
): SessionPermissionsEvent {
  const created = (context.now ?? Date.now)();
  const seq = context.sequence();
  return {
    id: ascendingIdentifier("evt_", created, "session.permissions:" + sessionID + ":" + String(seq)),
    type: "session.permissions",
    created: created,
    ...(context.location === undefined ? {} : { location: context.location }),
    durable: { aggregateID: sessionID, seq: seq, version: 1 },
    data: { sessionID: sessionID, permissions: [...rules] },
  };
}

/**
 * The live rule set the launcher loads at start and the TUI answers asks from. Sessions are keyed by
 * the durable id the client names them with; the launcher resolves a dialog's routing tag first.
 */
export class SessionPermissionRules {
  private readonly bySession = new Map<string, PermissionRuleset>();
  private readonly listeners = new Set<(change: PermissionRuleChange) => void>();

  constructor(document?: PermissionRuleDocument) {
    for (const [sessionID, rules] of Object.entries(document?.sessions ?? {})) this.bySession.set(sessionID, rules);
  }

  set(sessionID: string, rules: unknown): PermissionRuleset {
    const decoded = readRuleset(rules, "rules." + sessionID);
    this.bySession.set(sessionID, decoded);
    for (const listener of [...this.listeners]) listener({ sessionID: sessionID, rules: decoded });
    return decoded;
  }

  rulesFor(sessionID: string): PermissionRuleset {
    return this.bySession.get(sessionID) ?? [];
  }

  /** The session list the document holds, so a caller can expose every rule through the client surface. */
  sessionIds(): readonly string[] {
    return [...this.bySession.keys()];
  }

  decide(sessionID: string, ask: PermissionAsk): PermissionDecision {
    return decidePermission(this.bySession.get(sessionID), ask);
  }

  subscribe(listener: (change: PermissionRuleChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
