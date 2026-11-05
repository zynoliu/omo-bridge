import { type BridgeEvent, type EventBus, type EventSubscription, eventBus as sharedEventBus } from "../events";
import type { Route } from "../router";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_FRAME = ": heartbeat\n\n";
const HEARTBEAT_BYTES = new TextEncoder().encode(HEARTBEAT_FRAME);
const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
} as const;

export type EventRouteOptions = {
  bus?: EventBus;
  heartbeatIntervalMs?: number;
};

export function createEventRoute(options: EventRouteOptions = {}): Route {
  const bus = options.bus ?? sharedEventBus;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  return {
    method: "GET",
    path: "/api/event",
    handler(context) {
      const subscription = bus.subscribe({ types: parseTypes(context.url) });
      return new Response(frameStream(bus.serverConnectedEvent(), subscription, heartbeatIntervalMs), {
        headers: SSE_HEADERS,
      });
    },
  };
}

export const eventRoute = createEventRoute();

function parseTypes(url: URL): string[] {
  const types: string[] = [];
  for (const value of url.searchParams.getAll("types")) {
    for (const part of value.split(",")) {
      const type = part.trim();
      if (type.length > 0) types.push(type);
    }
  }
  return types;
}

function encodeFrame(event: BridgeEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function frameStream(
  first: BridgeEvent,
  subscription: EventSubscription,
  heartbeatIntervalMs: number,
): ReadableStream<Uint8Array> {
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
    subscription.close();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encodeFrame(first));
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(HEARTBEAT_BYTES);
      }, heartbeatIntervalMs);

      void (async () => {
        const reader = subscription.stream.getReader();
        try {
          while (!closed) {
            const { done, value } = await reader.read();
            if (done || value === undefined) break;
            controller.enqueue(encodeFrame(value));
          }
        } finally {
          reader.releaseLock();
          if (!closed) {
            cleanup();
            controller.close();
          }
        }
      })();
    },
    cancel() {
      cleanup();
    },
  });
}
