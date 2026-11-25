import type { SessionInfo } from "@opencode/client";
import type {
  SessionRecord,
  SessionRefusalCode,
  SessionRegistry,
  SessionState,
} from "../../../../../bridge-core/src/sessions.ts";
import type { BridgeTuiData } from "../../../context/bridge-data.ts";

/* Rows come only from what the bridge holds: stored host payloads and registry records. An id that was merely mentioned, such as seeded history, never becomes a row. */
export type SessionRow = {
  readonly persistentId: string;
  readonly title: string;
  readonly status: "idle" | "running";
  readonly state: SessionState | null;
  readonly selected: boolean;
};

export type SessionTreeNode = {
  readonly persistentId: string;
  readonly title: string;
  readonly depth: number;
  readonly parentId: string | null;
};

export type SessionTreeLink = "payload-parent" | "none";

export type SessionTree = {
  readonly root: string;
  readonly nodes: readonly SessionTreeNode[];
  readonly familyReport: readonly string[];
  readonly link: SessionTreeLink;
  readonly note: string;
};

export type SessionHistory = {
  readonly persistentId: string;
  readonly handle: string;
  readonly entries: readonly string[];
  readonly source: "recorded";
};

export type ReopenSuccess = {
  readonly kind: "reopened";
  readonly persistentId: string;
  readonly handle: string;
  readonly entries: readonly string[];
};

export type ReopenFailure = {
  readonly kind: "refused";
  readonly persistentId: string;
  readonly code: SessionRefusalCode;
  readonly message: string;
};

export type ReopenOutcome = ReopenSuccess | ReopenFailure;

/* Host `move_session` is a cross-device transfer that lands the session at a target location, never an in-place working directory change of the running session. */
export type SessionPlacement = {
  readonly persistentId: string;
  readonly directory: string;
  readonly semantics: "transfer";
  readonly note: string;
};

export const RELOCATION_NOTE =
  "moving a session is a transfer to the target location; it does not change this session's working directory in place";

export function deriveSessionRows(input: {
  readonly data: BridgeTuiData;
  readonly records: readonly SessionRecord[];
  readonly selected: string | null;
}): readonly SessionRow[] {
  const latest = latestRecords(input.records);
  const rows: SessionRow[] = [];
  const seen = new Set<string>();
  for (const info of input.data.session.list()) {
    if (seen.has(info.id)) continue;
    seen.add(info.id);
    const record = latest.get(info.id);
    rows.push({
      persistentId: info.id,
      title: sessionTitle(info),
      status: input.data.session.status(info.id),
      state: record === undefined ? null : record.state,
      selected: false,
    });
  }
  for (const record of latest.values()) {
    if (seen.has(record.persistentId)) continue;
    seen.add(record.persistentId);
    rows.push({
      persistentId: record.persistentId,
      title: record.persistentId,
      status: input.data.session.status(record.persistentId),
      state: record.state,
      selected: false,
    });
  }
  const current = effectiveSelection(rows, input.selected);
  return rows.map((row) => ({ ...row, selected: row.persistentId === current }));
}

export function effectiveSelection(rows: readonly SessionRow[], selected: string | null): string | null {
  if (selected !== null && rows.some((row) => row.persistentId === selected)) return selected;
  return rows.length === 0 ? null : rows[0].persistentId;
}

/* Members are the family the data layer reports for the resolved root plus every held payload whose delivered parentID chain reaches that root. Edges exist only where a payload delivered parentID, so a data layer that reports only the session itself yields a single node instead of an invented tree. */
export function deriveSessionTree(data: BridgeTuiData, sessionID: string): SessionTree {
  const payloads = new Map<string, SessionInfo>();
  for (const info of data.session.list()) payloads.set(info.id, info);
  const root = familyRoot(payloads, sessionID);
  const familyReport = data.session.family(root);
  const members: string[] = [];
  const add = (id: string) => {
    if (!members.includes(id)) members.push(id);
  };
  add(root);
  for (const id of familyReport) add(id);
  for (const info of payloads.values()) {
    if (reaches(payloads, info.id, root)) add(info.id);
  }
  const parents = new Map<string, string>();
  for (const id of members) {
    const parentId = payloads.get(id)?.parentID;
    if (parentId !== undefined && parentId !== id && members.includes(parentId)) parents.set(id, parentId);
  }
  const children = new Map<string, string[]>();
  for (const id of members) children.set(id, []);
  for (const entry of parents) {
    const siblings = children.get(entry[1]);
    if (siblings !== undefined) siblings.push(entry[0]);
  }
  const nodes: SessionTreeNode[] = [];
  const emitted = new Set<string>();
  const emit = (id: string, depth: number) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const info = payloads.get(id);
    nodes.push({
      persistentId: id,
      title: info === undefined ? id : sessionTitle(info),
      depth: depth,
      parentId: parents.get(id) ?? null,
    });
    for (const childId of children.get(id) ?? []) emit(childId, depth + 1);
  };
  for (const id of members) {
    if (!parents.has(id)) emit(id, 0);
  }
  for (const id of members) emit(id, 0);
  return {
    root: root,
    nodes: nodes,
    familyReport: [...familyReport],
    link: parents.size === 0 ? "none" : "payload-parent",
    note: treeNote(nodes.length, parents.size > 0),
  };
}

export function treeParentOf(tree: SessionTree, persistentId: string): string | null {
  const node = tree.nodes.find((candidate) => candidate.persistentId === persistentId);
  return node === undefined ? null : node.parentId;
}

export function treeChildrenOf(tree: SessionTree, persistentId: string): readonly string[] {
  return tree.nodes.filter((node) => node.parentId === persistentId).map((node) => node.persistentId);
}

export function deriveSessionHistory(registry: SessionRegistry, persistentId: string | null): SessionHistory | null {
  if (persistentId === null) return null;
  const record = latestRecord(registry.list(), persistentId);
  if (record === null) return null;
  const recorded = registry.history(record.handle);
  return {
    persistentId: persistentId,
    handle: record.handle,
    entries: recorded.kind === "ok" ? [...recorded.value] : [],
    source: "recorded",
  };
}

export function deriveRecordedHistory(registry: SessionRegistry): readonly SessionHistory[] {
  const recorded: SessionHistory[] = [];
  for (const record of latestRecords(registry.list()).values()) {
    const entries = registry.history(record.handle);
    if (entries.kind !== "ok" || entries.value.length === 0) continue;
    recorded.push({
      persistentId: record.persistentId,
      handle: record.handle,
      entries: [...entries.value],
      source: "recorded",
    });
  }
  return recorded;
}

export function reopenRecordedSession(registry: SessionRegistry, persistentId: string): ReopenOutcome {
  const opened = registry.reopen(persistentId);
  if (opened.kind === "refused") {
    return {
      kind: "refused",
      persistentId: persistentId,
      code: opened.code,
      message: "reopen refused: " + opened.code,
    };
  }
  const recorded = registry.history(opened.value);
  return {
    kind: "reopened",
    persistentId: persistentId,
    handle: opened.value,
    entries: recorded.kind === "ok" ? [...recorded.value] : [],
  };
}

export function deriveSessionPlacement(
  data: BridgeTuiData,
  persistentId: string | null,
): SessionPlacement | null {
  if (persistentId === null) return null;
  const info = data.session.list().find((candidate) => candidate.id === persistentId);
  if (info === undefined) return null;
  return {
    persistentId: persistentId,
    directory: info.location.directory,
    semantics: "transfer",
    note: RELOCATION_NOTE,
  };
}

function sessionTitle(info: SessionInfo): string {
  const title = info.title;
  return title === undefined || title.length === 0 ? info.id : title;
}

function latestRecords(records: readonly SessionRecord[]): Map<string, SessionRecord> {
  const latest = new Map<string, SessionRecord>();
  for (const record of records) latest.set(record.persistentId, record);
  return latest;
}

function latestRecord(records: readonly SessionRecord[], persistentId: string): SessionRecord | null {
  let found: SessionRecord | null = null;
  for (const record of records) {
    if (record.persistentId === persistentId) found = record;
  }
  return found;
}

/* Delivered parentID links are untrusted host data, so both walks stop at a cycle. */
function familyRoot(payloads: Map<string, SessionInfo>, sessionID: string): string {
  return walkUp(payloads, sessionID, new Set<string>([sessionID]));
}

function walkUp(payloads: Map<string, SessionInfo>, id: string, seen: Set<string>): string {
  const parentId = payloads.get(id)?.parentID;
  if (parentId === undefined || seen.has(parentId)) return id;
  seen.add(parentId);
  return walkUp(payloads, parentId, seen);
}

function reaches(payloads: Map<string, SessionInfo>, from: string, ancestor: string): boolean {
  return walkTo(payloads, from, ancestor, new Set<string>([from]));
}

function walkTo(payloads: Map<string, SessionInfo>, from: string, ancestor: string, seen: Set<string>): boolean {
  const parentId = payloads.get(from)?.parentID;
  if (parentId === undefined) return false;
  if (parentId === ancestor) return true;
  if (seen.has(parentId)) return false;
  seen.add(parentId);
  return walkTo(payloads, parentId, ancestor, seen);
}

function treeNote(nodeCount: number, linked: boolean): string {
  if (nodeCount <= 1) return "the bridge reports only this session, so the tree has a single node";
  if (!linked) return "the bridge reports one family but delivered no parent link between these sessions";
  return "parent and child come from the parentID delivered with each session payload";
}
