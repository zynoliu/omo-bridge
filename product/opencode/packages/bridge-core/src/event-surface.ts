import type { BridgeEvent } from "./contracts.ts";

export type EventSubscriptionOptions = {
  readonly signal?: AbortSignal;
  readonly onActivity?: () => void;
};

export type EventSurface = {
  readonly subscribe: (options?: EventSubscriptionOptions) => AsyncIterable<BridgeEvent>;
  readonly publish: (event: BridgeEvent) => void;
  readonly subscriberCount: () => number;
};

export class EventSurfaceError extends Error {}

export function createEventSurface(): EventSurface {
  const subscribers = new Set<{ push: (event: BridgeEvent) => void }>();
  return {
    publish(event) {
      for (const subscriber of subscribers) subscriber.push(event);
    },
    subscriberCount() {
      return subscribers.size;
    },
    subscribe(options = {}) {
      const queue: BridgeEvent[] = [];
      let notify: (() => void) | undefined;
      let closed = false;
      const subscriber = {
        push(event: BridgeEvent) {
          options.onActivity?.();
          queue.push(event);
          notify?.();
        },
      };
      const onAbort = () => {
        closed = true;
        notify?.();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      async function* iterate(): AsyncGenerator<BridgeEvent> {
        try {
          for (;;) {
            if (queue.length > 0) {
              const next = queue.shift();
              if (next !== undefined) yield next;
              continue;
            }
            if (closed) return;
            await new Promise<void>((resolve) => {
              notify = () => {
                notify = undefined;
                resolve();
              };
            });
          }
        } finally {
          subscribers.delete(subscriber);
          options.signal?.removeEventListener("abort", onAbort);
        }
      }

      subscribers.add(subscriber);
      return {
        [Symbol.asyncIterator]: iterate,
      };
    },
  };
}
