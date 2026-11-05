import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../../src/config";
import { createEventBus, eventBus as sharedEventBus, type BridgeEvent, type EventBus } from "../../src/http/events";
import { createRouter, type Route } from "../../src/http/router";
import { createEventRoute, DEFAULT_HEARTBEAT_INTERVAL_MS } from "../../src/http/routes/events";
import { BASIC_USERNAME, createServer, type BridgeServer } from "../../src/http/server";

const PASSWORD = "test-password";
const FRAME_TIMEOUT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type FrameReader = {
  nextFrame: (timeoutMs?: number) => Promise<string>;
  close: () => Promise<void>;
};

function createFrameReader(reader: ReadableStreamDefaultReader<Uint8Array>): FrameReader {
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextFrame(timeoutMs = FRAME_TIMEOUT_MS): Promise<string> {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          return frame;
        }
        const result = await withTimeout(reader.read(), timeoutMs, "timed out waiting for an SSE frame");
        if (result.done) throw new Error("SSE stream closed before the next frame");
        buffer += decoder.decode(result.value, { stream: true });
      }
    },
    async close(): Promise<void> {
      await reader.cancel();
    },
  };
}

function parseEventFrame(frame: string): BridgeEvent {
  if (!frame.startsWith("data: ")) throw new Error(`not a data frame: ${JSON.stringify(frame)}`);
  if (!frame.endsWith("\n\n")) throw new Error(`frame does not end with a blank line: ${JSON.stringify(frame)}`);
  return JSON.parse(frame.slice("data: ".length)) as BridgeEvent;
}

async function openEventStream(
  bus: EventBus,
  options: { heartbeatIntervalMs?: number; query?: string; headers?: Record<string, string> } = {},
): Promise<{ response: Response; frames: FrameReader }> {
  const route = createEventRoute({ bus, heartbeatIntervalMs: options.heartbeatIntervalMs });
  const url = new URL(`http://127.0.0.1/api/event${options.query ?? ""}`);
  const request = new Request(url, { headers: options.headers });
  const response = await route.handler({ request, url, params: {} });
  if (response.body === null) throw new Error("the event route returned no body");
  return { response, frames: createFrameReader(response.body.getReader()) };
}

function basicAuth(): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}`,
  };
}

describe("GET /api/event", () => {
  test("first frame is server.connected and the response is an SSE stream", async () => {
    const stream = await openEventStream(createEventBus(), { headers: { accept: "application/json" } });
    try {
      expect(stream.response.status).toBe(200);
      expect(stream.response.headers.get("content-type")).toBe("text/event-stream");
      expect(stream.response.headers.get("cache-control")).toBe("no-cache, no-transform");
      expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
      expect(stream.response.headers.get("x-content-type-options")).toBe("nosniff");

      const event = parseEventFrame(await stream.frames.nextFrame());
      expect(event.type).toBe("server.connected");
      expect(event.id).toMatch(/^evt_\d+$/);
      expect(typeof event.created).toBe("number");
      expect(event.data).toEqual({});
    } finally {
      await stream.frames.close();
    }
  });

  test("a published event arrives as the next data frame", async () => {
    const bus = createEventBus();
    const stream = await openEventStream(bus);
    try {
      const connected = parseEventFrame(await stream.frames.nextFrame());
      const published = bus.publish({ type: "session.updated", data: { sessionID: "ses_1" } });

      const frame = parseEventFrame(await stream.frames.nextFrame());
      expect(frame).toEqual(published);
      expect(frame.type).toBe("session.updated");
      expect(frame.data).toEqual({ sessionID: "ses_1" });
      expect(Number(frame.id.slice("evt_".length))).toBeGreaterThan(Number(connected.id.slice("evt_".length)));
    } finally {
      await stream.frames.close();
    }
  });

  test("?types= filters events but always sends server.connected first", async () => {
    const bus = createEventBus();
    const stream = await openEventStream(bus, {
      query: "?types=session.text.delta&types=session.text.ended,session.tool.called",
    });
    try {
      expect(parseEventFrame(await stream.frames.nextFrame()).type).toBe("server.connected");

      bus.publish({ type: "session.updated", data: {} });
      bus.publish({ type: "session.text.delta", data: { delta: "hi" } });
      bus.publish({ type: "session.tool.called", data: { tool: "bash" } });

      const delta = parseEventFrame(await stream.frames.nextFrame());
      expect(delta.type).toBe("session.text.delta");
      expect(delta.data).toEqual({ delta: "hi" });
      expect(parseEventFrame(await stream.frames.nextFrame()).type).toBe("session.tool.called");
    } finally {
      await stream.frames.close();
    }
  });

  test("a heartbeat comment is sent on the configured interval", async () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(15_000);
    const stream = await openEventStream(createEventBus(), { heartbeatIntervalMs: 20 });
    try {
      expect(parseEventFrame(await stream.frames.nextFrame()).type).toBe("server.connected");
      expect(await stream.frames.nextFrame()).toBe(": heartbeat\n\n");
    } finally {
      await stream.frames.close();
    }
  });

  test("a slow subscriber is dropped and closed instead of buffering without bound", async () => {
    const bus = createEventBus({ capacity: 2 });
    const subscription = bus.subscribe();
    const reader = subscription.stream.getReader();
    for (let index = 0; index < 6; index += 1) bus.publish({ type: "session.updated", data: { index } });

    const received: BridgeEvent[] = [];
    while (true) {
      const result = await withTimeout(reader.read(), FRAME_TIMEOUT_MS, "slow subscriber was not closed");
      if (result.done) break;
      received.push(result.value);
    }
    expect(received.length).toBeLessThan(6);
    reader.releaseLock();
  });
});

describe("router", () => {
  test("matches :params and reports allowed methods on a path match", async () => {
    const route: Route = {
      method: "GET",
      path: "/api/session/:sessionID/message/:messageID",
      handler: ({ params }) => Response.json(params),
    };
    const router = createRouter([route]);

    const matched = await router(new Request("http://127.0.0.1/api/session/ses%201/message/msg_2"));
    expect(matched.status).toBe(200);
    expect(await matched.json()).toEqual({ sessionID: "ses 1", messageID: "msg_2" });

    const wrongMethod = await router(
      new Request("http://127.0.0.1/api/session/ses_1/message/msg_2", { method: "POST" }),
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");

    expect((await router(new Request("http://127.0.0.1/api/session/ses_1/message"))).status).toBe(404);
  });
});

describe("server mounting", () => {
  test("GET /api/event is mounted behind basic auth and streams live events", async () => {
    let server: BridgeServer | undefined;
    try {
      server = createServer(resolveConfig({ OMO_BRIDGE_PORT: "0", OMO_BRIDGE_PASSWORD: PASSWORD }));
      const base = `http://127.0.0.1:${server.port}`;

      expect((await fetch(`${base}/api/event`)).status).toBe(401);

      const response = await fetch(`${base}/api/event`, { headers: basicAuth() });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      if (response.body === null) throw new Error("the server returned no event body");

      const frames = createFrameReader(response.body.getReader());
      try {
        expect(parseEventFrame(await frames.nextFrame()).type).toBe("server.connected");
        const published = sharedEventBus.publish({ type: "server.info", data: {} });
        expect(parseEventFrame(await frames.nextFrame())).toEqual(published);
      } finally {
        await frames.close();
      }

      const wrongMethod = await fetch(`${base}/api/event`, { method: "POST", headers: basicAuth() });
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET");
    } finally {
      await server?.stop(true);
    }
  });
});
