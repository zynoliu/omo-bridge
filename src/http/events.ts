export type BridgeEvent = {
  id: string;
  type: string;
  created: number;
  data: Record<string, unknown>;
};

export type EventDraft = {
  type: string;
  created?: number;
  data?: Record<string, unknown>;
};

export type EventFilter = {
  types?: readonly string[];
};

export type EventSubscription = {
  stream: ReadableStream<BridgeEvent>;
  close: () => void;
};

export type EventBus = {
  publish: (event: EventDraft) => BridgeEvent;
  subscribe: (filter?: EventFilter) => EventSubscription;
  serverConnectedEvent: () => BridgeEvent;
};

export type EventBusOptions = {
  capacity?: number;
};

export const DEFAULT_EVENT_CAPACITY = 256;

type Subscriber = {
  types: ReadonlySet<string> | undefined;
  queue: BridgeEvent[];
  closed: boolean;
  wake: (() => void) | undefined;
};

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const capacity = options.capacity ?? DEFAULT_EVENT_CAPACITY;
  const subscribers = new Set<Subscriber>();
  let sequence = 0;

  const nextId = (): string => `evt_${++sequence}`;

  const closeSubscriber = (subscriber: Subscriber): void => {
    if (subscriber.closed) return;
    subscriber.closed = true;
    subscriber.queue.length = 0;
    subscribers.delete(subscriber);
    const wake = subscriber.wake;
    subscriber.wake = undefined;
    wake?.();
  };

  const take = async (subscriber: Subscriber): Promise<BridgeEvent | undefined> => {
    while (true) {
      const event = subscriber.queue.shift();
      if (event !== undefined) return event;
      if (subscriber.closed) return undefined;
      await new Promise<void>((resolve) => {
        subscriber.wake = resolve;
      });
    }
  };

  const publish = (draft: EventDraft): BridgeEvent => {
    const event: BridgeEvent = {
      id: nextId(),
      type: draft.type,
      created: draft.created ?? Date.now(),
      data: draft.data ?? {},
    };

    for (const subscriber of [...subscribers]) {
      if (subscriber.types !== undefined && !subscriber.types.has(event.type)) continue;
      subscriber.queue.push(event);
      if (subscriber.queue.length > capacity) {
        closeSubscriber(subscriber);
        continue;
      }
      const wake = subscriber.wake;
      subscriber.wake = undefined;
      wake?.();
    }

    return event;
  };

  const subscribe = (filter: EventFilter = {}): EventSubscription => {
    const requested = filter.types;
    const subscriber: Subscriber = {
      types: requested !== undefined && requested.length > 0 ? new Set(requested) : undefined,
      queue: [],
      closed: false,
      wake: undefined,
    };
    subscribers.add(subscriber);

    const stream = new ReadableStream<BridgeEvent>({
      async pull(controller) {
        const event = await take(subscriber);
        if (event === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(event);
      },
      cancel() {
        closeSubscriber(subscriber);
      },
    });

    return { stream, close: () => closeSubscriber(subscriber) };
  };

  const serverConnectedEvent = (): BridgeEvent => ({
    id: nextId(),
    type: "server.connected",
    created: Date.now(),
    data: {},
  });

  return { publish, subscribe, serverConnectedEvent };
}

export const eventBus = createEventBus();
