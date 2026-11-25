import type { BridgeEvent } from "./contracts.ts";
import type { EventSurface, EventSubscriptionOptions } from "./event-surface.ts";
import { UnimplementedApiGroup } from "./client-surface.ts";
import type { PartSurface, ProjectedPart } from "./part-surface.ts";
import type { SessionSurface } from "./opencode-surface.ts";

export type BridgeClientDeps = {
  readonly events: EventSurface;
  readonly sessions: SessionSurface;
  readonly parts: PartSurface;
};

export type BridgeSessionGroup = {
  readonly list: () => Promise<Awaited<ReturnType<SessionSurface["session"]["list"]>>>;
  readonly get: (input: { readonly id: string }) => ReturnType<SessionSurface["session"]["get"]>;
  readonly message: {
    readonly get: (input: { readonly sessionID: string; readonly messageID: string }) => Promise<readonly ProjectedPart[]>;
  };
};

export type BridgeEventGroup = {
  readonly subscribe: (options?: EventSubscriptionOptions) => AsyncIterable<BridgeEvent>;
};

export type BridgeConfigGroup = {
  readonly get: () => never;
};

export type BridgeClientGroups = {
  readonly event: BridgeEventGroup;
  readonly session: BridgeSessionGroup;
  readonly config: BridgeConfigGroup;
};

export function createBridgeClientGroups(deps: BridgeClientDeps): BridgeClientGroups {
  return {
    event: {
      subscribe: (options?: EventSubscriptionOptions) => deps.events.subscribe(options),
    },
    session: {
      list: () => deps.sessions.session.list(),
      get: (input) => deps.sessions.session.get(input),
      message: {
        get: (input) => deps.parts.part.list(input),
      },
    },
    config: {
      get: (): never => {
        throw new UnimplementedApiGroup("config", "get");
      },
    },
  };
}
