import { createSignal } from "solid-js";
import type { SessionRegistry } from "../../../../../bridge-core/src/sessions.ts";
import type { BridgeTuiData } from "../../../context/bridge-data.ts";
import {
  deriveRecordedHistory,
  deriveSessionHistory,
  deriveSessionPlacement,
  deriveSessionRows,
  deriveSessionTree,
  effectiveSelection,
  reopenRecordedSession,
  treeChildrenOf,
  treeParentOf,
} from "./state.ts";
import type {
  ReopenFailure,
  ReopenOutcome,
  ReopenSuccess,
  SessionHistory,
  SessionPlacement,
  SessionRow,
  SessionTree,
} from "./state.ts";

export type SessionsStoreDeps = {
  readonly data: BridgeTuiData;
  readonly sessions: SessionRegistry;
  /* The TUI data contract has no change subscription, so the caller supplies the signal that marks new host payloads. */
  readonly revision?: () => unknown;
};

export type SessionsStore = {
  readonly rows: () => readonly SessionRow[];
  readonly selectedId: () => string | null;
  readonly tree: () => SessionTree | null;
  readonly history: () => SessionHistory | null;
  readonly recordedHistory: () => readonly SessionHistory[];
  readonly placement: () => SessionPlacement | null;
  readonly failure: () => ReopenFailure | null;
  readonly reopened: () => ReopenSuccess | null;
  readonly select: (persistentId: string) => boolean;
  readonly move: (delta: number) => string | null;
  readonly focusParent: () => boolean;
  readonly focusChild: (index: number) => boolean;
  readonly reopen: (persistentId: string) => ReopenOutcome;
  readonly clearFailure: () => void;
};

export function createSessionsStore(deps: SessionsStoreDeps): SessionsStore {
  const [selected, setSelected] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<ReopenFailure | null>(null);
  const [reopened, setReopened] = createSignal<ReopenSuccess | null>(null);

  const rows = () => {
    deps.revision?.();
    return deriveSessionRows({ data: deps.data, records: deps.sessions.list(), selected: selected() });
  };
  const selectedId = () => effectiveSelection(rows(), selected());
  const treeOf = (persistentId: string) => deriveSessionTree(deps.data, persistentId);

  const select = (persistentId: string): boolean => {
    if (!rows().some((row) => row.persistentId === persistentId)) return false;
    setSelected(persistentId);
    return true;
  };

  return {
    rows: rows,
    selectedId: selectedId,
    tree: () => {
      const current = selectedId();
      return current === null ? null : treeOf(current);
    },
    history: () => deriveSessionHistory(deps.sessions, selectedId()),
    recordedHistory: () => deriveRecordedHistory(deps.sessions),
    placement: () => deriveSessionPlacement(deps.data, selectedId()),
    failure: failure,
    reopened: reopened,
    select: select,
    move: (delta) => {
      const held = rows();
      if (held.length === 0) return null;
      const current = effectiveSelection(held, selected());
      const index = current === null ? -1 : held.findIndex((row) => row.persistentId === current);
      const next = held[Math.min(Math.max(0, index + delta), held.length - 1)];
      setSelected(next.persistentId);
      return next.persistentId;
    },
    focusParent: () => {
      const current = selectedId();
      if (current === null) return false;
      const parent = treeParentOf(treeOf(current), current);
      if (parent === null) return false;
      return select(parent);
    },
    focusChild: (index) => {
      const current = selectedId();
      if (current === null) return false;
      const child = treeChildrenOf(treeOf(current), current)[index];
      if (child === undefined) return false;
      return select(child);
    },
    reopen: (persistentId) => {
      const outcome = reopenRecordedSession(deps.sessions, persistentId);
      if (outcome.kind === "refused") {
        setFailure(outcome);
        setReopened(null);
        return outcome;
      }
      setFailure(null);
      setReopened(outcome);
      setSelected(outcome.persistentId);
      return outcome;
    },
    clearFailure: () => {
      setFailure(null);
    },
  };
}
