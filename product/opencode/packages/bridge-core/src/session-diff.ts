import { ascendingIdentifier } from "./id-scheme.ts";

/**
 * The pull is the update channel for the session fields the host never announces as a frame.
 *
 * `get_state` reports `sessionName` (absent until a name is set) and `cwd`; the host emits no record
 * when either changes, so a title set by another client stayed invisible until something else caused
 * a re-read. Diffing consecutive pulls turns that into a real event: `session.renamed` /
 * `session.moved` are the client union's own members for these fields (both in
 * `EventManifest.ServerDefinitions`), not a stand-in name.
 *
 * Only what a pull can prove is published. This host build publishes no archive flag in `get_state`
 * or `list_sessions`, and a session missing from a later subscription snapshot is a session the host
 * no longer holds, not necessarily a deleted directory — `session_closed` already carries that
 * distinction and projects `session.deleted` for `session_dir_removed` only. So neither archive nor
 * delete is inferred here from absence: they would be claims the pull does not make.
 */
export type SessionSnapshot = {
  readonly id: string;
  readonly title?: string;
  readonly directory?: string;
};

export type SessionChange =
  | { readonly kind: "renamed"; readonly id: string; readonly title: string }
  | { readonly kind: "moved"; readonly id: string; readonly directory: string };

/**
 * Remembers what the last pull reported per session. The first snapshot of a session only seeds it:
 * a session that already existed when this connection subscribed was announced by its status frame,
 * and re-announcing its title would be a duplicate. A field the pull stops reporting keeps the value
 * it last had, so an absent title is "no information", never a rename.
 */
export class SessionDiff {
  private readonly seen = new Map<string, SessionSnapshot>();

  observe(snapshot: SessionSnapshot): readonly SessionChange[] {
    const previous = this.seen.get(snapshot.id);
    this.seen.set(snapshot.id, {
      id: snapshot.id,
      ...(snapshot.title === undefined ? (previous?.title === undefined ? {} : { title: previous.title }) : { title: snapshot.title }),
      ...(snapshot.directory === undefined
        ? previous?.directory === undefined
          ? {}
          : { directory: previous.directory }
        : { directory: snapshot.directory }),
    });
    if (previous === undefined) return [];
    const changes: SessionChange[] = [];
    if (snapshot.title !== undefined && snapshot.title !== previous.title) {
      changes.push({ kind: "renamed", id: snapshot.id, title: snapshot.title });
    }
    if (snapshot.directory !== undefined && previous.directory !== undefined && snapshot.directory !== previous.directory) {
      changes.push({ kind: "moved", id: snapshot.id, directory: snapshot.directory });
    }
    return changes;
  }

  known(): readonly string[] {
    return [...this.seen.keys()];
  }
}

export type SessionChangeEvent =
  | {
      readonly id: string;
      readonly type: "session.renamed";
      readonly created: number;
      readonly location: { readonly directory: string };
      readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: 1 };
      readonly data: { readonly sessionID: string; readonly title: string };
    }
  | {
      readonly id: string;
      readonly type: "session.moved";
      readonly created: number;
      readonly location: { readonly directory: string };
      readonly durable: { readonly aggregateID: string; readonly seq: number; readonly version: 1 };
      readonly data: {
        readonly sessionID: string;
        readonly location: { readonly directory: string };
        readonly projectID: string;
      };
    };

export type SessionChangeContext = {
  readonly location: { readonly directory: string };
  /** The live stream is not replayed, so this only orders the events this producer emits. */
  readonly sequence: () => number;
  readonly now?: () => number;
};

export function sessionChangeEvents(
  changes: readonly SessionChange[],
  context: SessionChangeContext,
): readonly SessionChangeEvent[] {
  const created = (context.now ?? Date.now)();
  return changes.map((change) => {
    const seq = context.sequence();
    const id = ascendingIdentifier("evt_", created, change.kind + ":" + change.id + ":" + String(seq));
    const durable = { aggregateID: change.id, seq: seq, version: 1 as const };
    if (change.kind === "renamed") {
      return {
        id: id,
        type: "session.renamed" as const,
        created: created,
        location: context.location,
        durable: durable,
        data: { sessionID: change.id, title: change.title },
      };
    }
    return {
      id: id,
      type: "session.moved" as const,
      created: created,
      location: { directory: change.directory },
      durable: durable,
      data: { sessionID: change.id, location: { directory: change.directory }, projectID: change.directory },
    };
  });
}
