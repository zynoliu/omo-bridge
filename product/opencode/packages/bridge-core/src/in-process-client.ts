import { BridgeClient } from "./client.ts";
import type { BridgeData, ViewSession } from "./data.ts";
import type { BridgeEvent } from "./contracts.ts";

export type InProcessClient = {
  readonly session: {
    readonly list: () => Promise<readonly ViewSession[]>;
    readonly create: (input: { readonly id: string; readonly title: string }) => Promise<ViewSession>;
    readonly select: (id: string) => Promise<boolean>;
  };
  readonly event: {
    readonly subscribe: (listener: (event: BridgeEvent) => void) => () => void;
  };
};

export type InProcessClientOptions = {
  readonly client: BridgeClient;
  readonly data: BridgeData;
};

export function createInProcessClient(options: InProcessClientOptions): InProcessClient {
  const listeners = new Set<(event: BridgeEvent) => void>();
  return {
    session: {
      async list() {
        return options.client.sessionList();
      },
      async create(input) {
        return options.client.sessionCreate(input.id, input.title);
      },
      async select(id) {
        return options.client.sessionSelect(id);
      },
    },
    event: {
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}
