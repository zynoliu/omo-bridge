/**
 * Decoders for the host payloads the bridge reads but does not re-serve verbatim.
 *
 * Each reader answers `undefined` when the payload does not carry the documented fields, so a caller
 * can keep "the host did not publish this" apart from "the host published nothing". The host shapes
 * are the ones documented in `upstream/senpi/packages/coding-agent/docs/rpc.md`; nothing here invents
 * a field.
 */

export type HostLifecycle = {
  readonly role: "root" | "child";
  readonly rootSessionId: string;
  readonly parentSessionId?: string;
  readonly taskId?: string;
};

export type HostThinking = {
  readonly level: string;
  readonly source: string | null;
  readonly availableLevels: readonly string[];
};

export type HostPermission = {
  readonly preset: string;
  readonly source: string | null;
  readonly status: string | null;
  readonly effective: string | null;
};

export type HostForkMessage = { readonly entryId: string; readonly text: string };

export type HostNavigateOutcome = {
  readonly outcome: "navigated" | "cancelled";
  readonly leafId: string | null;
  readonly editorText?: string;
};

type Record_ = Readonly<Record<string, unknown>>;

function record(value: unknown): Record_ | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record_;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function strings(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) return undefined;
    items.push(item);
  }
  return items;
}

/** `get_available_thinking_levels.data.levels`. */
export function readThinkingLevels(data: unknown): readonly string[] | undefined {
  return strings(record(data)?.levels);
}

/** `get_model_thinking_level.data` — the level one model runs at, and every level it offers. */
export function readModelThinkingLevel(data: unknown): HostThinking | undefined {
  const payload = record(data);
  if (payload === undefined) return undefined;
  const level = text(payload.level);
  const availableLevels = strings(payload.availableLevels);
  if (level === undefined || availableLevels === undefined) return undefined;
  return { level: level, source: text(payload.source) ?? null, availableLevels: availableLevels };
}

/**
 * `get_state.lifecycle` — the ancestry the host persisted in the session header. `role: "child"` is
 * only reported for a session opened with `spawnedBy`; fork/transcript ancestry is `parentID` and is
 * a different relation, which is why this reader never derives one from the other.
 */
export function readLifecycle(data: unknown): HostLifecycle | undefined {
  const payload = record(data);
  if (payload === undefined) return undefined;
  const role = payload.role === "child" ? "child" : payload.role === "root" ? "root" : undefined;
  const rootSessionId = text(payload.rootSessionId);
  if (role === undefined || rootSessionId === undefined) return undefined;
  if (role === "root") return { role: role, rootSessionId: rootSessionId };
  const parentSessionId = text(payload.parentSessionId);
  const taskId = text(payload.taskId);
  if (parentSessionId === undefined || taskId === undefined) return undefined;
  return { role: role, rootSessionId: rootSessionId, parentSessionId: parentSessionId, taskId: taskId };
}

/** The four approval fields `get_state` reports, plus `set_permission_preset`'s own answer. */
export function readPermission(data: unknown): HostPermission | undefined {
  const payload = record(data);
  if (payload === undefined) return undefined;
  const preset = text(payload.permissionPreset);
  if (preset === undefined) return undefined;
  return {
    preset: preset,
    source: text(payload.permissionPresetSource) ?? null,
    status: text(payload.permissionPresetStatus) ?? null,
    effective: text(payload.effectivePermissionPreset) ?? null,
  };
}

/** `get_fork_messages.data.messages` — the prompts a fork can start from, in host order. */
export function readForkMessages(data: unknown): readonly HostForkMessage[] | undefined {
  const payload = record(data);
  const rows = payload?.messages;
  if (!Array.isArray(rows)) return undefined;
  const messages: HostForkMessage[] = [];
  for (const row of rows) {
    const entry = record(row);
    if (entry === undefined) return undefined;
    const entryId = text(entry.entryId);
    const body = typeof entry.text === "string" ? entry.text : undefined;
    if (entryId === undefined || body === undefined) return undefined;
    messages.push({ entryId: entryId, text: body });
  }
  return messages;
}

/**
 * `navigate_tree` / `edit_user_message` / `edit_assistant_message` success payload. `leafId` is null
 * on the documented empty-conversation outcome, so it is read as present-or-null, never defaulted.
 */
export function readNavigateOutcome(data: unknown): HostNavigateOutcome | undefined {
  const payload = record(data);
  if (payload === undefined) return undefined;
  const outcome = payload.outcome === "navigated" ? "navigated" : payload.outcome === "cancelled" ? "cancelled" : undefined;
  const leaf = payload.leafId;
  if (outcome === undefined) return undefined;
  if (!(leaf === null || typeof leaf === "string")) return undefined;
  const editorText = typeof payload.editorText === "string" ? payload.editorText : undefined;
  return editorText === undefined
    ? { outcome: outcome, leafId: leaf }
    : { outcome: outcome, leafId: leaf, editorText: editorText };
}

/** Membership is the only validation the host performs for a known model, so the bridge checks it. */
export function supportsThinkingLevel(level: string, availableLevels: readonly string[]): boolean {
  return availableLevels.includes(level);
}
