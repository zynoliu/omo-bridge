import fs from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { createEventSurface } from "../../../packages/bridge-core/src/event-surface.ts";
import { createBridgeOpencodeApi } from "../../../packages/bridge-core/src/opencode-api.ts";
import { createPartSurface } from "../../../packages/bridge-core/src/part-surface.ts";
import { createSessionSurface } from "../../../packages/bridge-core/src/opencode-surface.ts";
import type { PermissionRule, PermissionRuleset } from "../../../packages/bridge-core/src/permission-rules.ts";
import {
  RULES_DOCUMENT_VERSION,
  loadPermissionRuleDocument,
  permissionRulesPath,
  SessionPermissionRules,
} from "../../../packages/bridge-core/src/permission-rules.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../../packages/tui/src/context/bridge-data.ts";

/**
 * The `session.permissions` member on the client event stream.
 *
 * The host keeps no rule document and publishes a preset instead, so the bridge's own document is what
 * the client must be able to subscribe to. This case drives the shipping subscriber: `api.event.subscribe`
 * is the stream the TUI reads (`events`), and the events it yields are the ones the launcher publishes.
 * A rule set that loads, changes, or clears must arrive there; a re-report of the same set must not.
 */

const SESSION = "ses_rules_event_1";
const DIRECTORY = "/work/rules";
const EVENT_TIMEOUT_MS = 10_000;
const QUIET_WINDOW_MS = 1_500;

const loadedRules: PermissionRuleset = [
  { action: "read", resource: "/work/*", effect: "allow" },
  { action: "bash", resource: "*", effect: "deny", reason: "shell is off-limits in this session" },
];
const editedRules: PermissionRuleset = [{ action: "eval", resource: "*", effect: "deny", reason: "eval is off-limits" }];

type Frame = Record<string, unknown>;

type NextResult = { readonly kind: "event"; readonly value: Frame } | { readonly kind: "timeout" } | { readonly kind: "done" };

function nextWithin(iterator: AsyncIterator<unknown>, timeoutMs: number): Promise<NextResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    iterator.next().then(
      (result) => {
        clearTimeout(timer);
        if (result.done === true) {
          resolve({ kind: "done" });
          return;
        }
        resolve({ kind: "event", value: result.value as Frame });
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: "done" });
      },
    );
  });
}

function dataOf(frame: Frame): Frame | undefined {
  const value = frame["data"];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Frame) : undefined;
}

function describeRules(rules: unknown): string {
  return JSON.stringify(rules ?? null);
}

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const cleanupDetail: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });

  const controller = new AbortController();
  let iterator: AsyncIterator<unknown> | undefined;
  try {
    const configDirectory = path.join(context.out, "config");
    fs.mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    const documentPath = permissionRulesPath(configDirectory);
    fs.writeFileSync(
      documentPath,
      JSON.stringify({ version: RULES_DOCUMENT_VERSION, sessions: { [SESSION]: loadedRules } }, null, 2) + "\n",
      { mode: 0o600 },
    );

    const data = new BridgeData();
    data.upsertHostSession({
      id: SESSION,
      title: "rules event probe",
      projectID: DIRECTORY,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      location: { directory: DIRECTORY },
    });
    const api = createBridgeOpencodeApi({
      data: data,
      defaultLocation: { directory: DIRECTORY },
      events: createEventSurface(),
      sessions: createSessionSurface(data),
      parts: createPartSurface(data),
    });
    /* The shipping subscriber, started before the document is loaded so the load itself is observed. */
    iterator = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const connected = await nextWithin(iterator, EVENT_TIMEOUT_MS);
    record(
      "client-stream-connected",
      "the stream the TUI subscribes to yields server.connected first",
      connected.kind === "event" ? String(connected.value["type"]) : connected.kind,
      connected.kind === "event" && connected.value["type"] === "server.connected",
    );

    const document = loadPermissionRuleDocument(documentPath);
    const rules = new SessionPermissionRules(document);
    const tui = createBridgeTuiData({
      data: data,
      sessions: new SessionRegistry(),
      dialogs: new DialogRegistry(),
      interaction: new InteractionController(),
      defaultLocation: { directory: DIRECTORY },
      events: api.event,
      permissionRules: rules,
    });

    const loaded = await nextWithin(iterator, EVENT_TIMEOUT_MS);
    const loadedData = loaded.kind === "event" ? dataOf(loaded.value) : undefined;
    record(
      "load-publishes-session-permissions",
      "the document loaded at construction reaches the client stream as session.permissions with its rules",
      loaded.kind === "event"
        ? String(loaded.value["type"]) + " " + describeRules(loadedData?.["permissions"])
        : loaded.kind,
      loaded.kind === "event" &&
        loaded.value["type"] === "session.permissions" &&
        loadedData?.["sessionID"] === SESSION &&
        describeRules(loadedData?.["permissions"]) === describeRules(loadedRules),
    );
    record(
      "load-event-carries-the-client-shape",
      "id evt_*, durable {aggregateID: session, seq, version: 1}, location {directory}",
      loaded.kind === "event"
        ? JSON.stringify({ id: loaded.value["id"], durable: loaded.value["durable"], location: loaded.value["location"] })
        : loaded.kind,
      loaded.kind === "event" &&
        /^evt_/.test(String(loaded.value["id"])) &&
        JSON.stringify(loaded.value["durable"]) ===
          JSON.stringify({ aggregateID: SESSION, seq: (loaded.value["durable"] as Frame | undefined)?.["seq"], version: 1 }) &&
        JSON.stringify(loaded.value["location"]) === JSON.stringify({ directory: DIRECTORY }),
    );
    record(
      "the-row-reports-the-same-rules",
      "SessionInfo.permissions equals the published set",
      describeRules(tui.session.get(SESSION)?.permissions),
      describeRules(tui.session.get(SESSION)?.permissions) === describeRules(loadedRules),
    );

    const edited: readonly PermissionRule[] = editedRules;
    rules.set(SESSION, edited);
    const editEvent = await nextWithin(iterator, EVENT_TIMEOUT_MS);
    const editData = editEvent.kind === "event" ? dataOf(editEvent.value) : undefined;
    record(
      "edit-publishes-the-new-rules",
      "a document edit publishes session.permissions with the replaced rules",
      editEvent.kind === "event"
        ? String(editEvent.value["type"]) + " " + describeRules(editData?.["permissions"])
        : editEvent.kind,
      editEvent.kind === "event" &&
        editEvent.value["type"] === "session.permissions" &&
        describeRules(editData?.["permissions"]) === describeRules(editedRules),
    );

    rules.set(SESSION, []);
    const cleared = await nextWithin(iterator, EVENT_TIMEOUT_MS);
    const clearedData = cleared.kind === "event" ? dataOf(cleared.value) : undefined;
    record(
      "clear-publishes-the-empty-set",
      "clearing the rules publishes session.permissions with an empty permissions array",
      cleared.kind === "event"
        ? String(cleared.value["type"]) + " " + describeRules(clearedData?.["permissions"])
        : cleared.kind,
      cleared.kind === "event" &&
        cleared.value["type"] === "session.permissions" &&
        JSON.stringify(clearedData?.["permissions"]) === "[]",
    );
    record(
      "cleared-rules-leave-the-row-without-permissions",
      "SessionInfo.permissions is absent after the set is cleared",
      String(tui.session.get(SESSION)?.permissions),
      tui.session.get(SESSION)?.permissions === undefined,
    );

    /* Last, because a read that times out cannot be withdrawn: an outstanding `next()` would swallow the
       next event, so nothing may be published after this window. */
    data.setSessionPermissionRules(SESSION, []);
    const quiet = await nextWithin(iterator, QUIET_WINDOW_MS);
    record(
      "re-report-publishes-nothing",
      "the same rules set again produce no event",
      quiet.kind,
      quiet.kind === "timeout",
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 240), false);
  } finally {
    controller.abort();
    cleanupDetail.push("client stream aborted");
  }

  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: cleanupDetail } };
}
