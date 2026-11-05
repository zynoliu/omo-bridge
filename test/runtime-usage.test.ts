import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASIC_USERNAME } from "../src/http/server";
import { eventBus, type BridgeEvent, type EventSubscription } from "../src/http/events";
import { createRuntime, type BridgeRuntime } from "../src/runtime";
import { FakeSenpiHost } from "./senpi/fake-host";

// Composition tests: the session surface's cost/tokens must come from the same dispatch path that
// emits session.usage.updated, not from a handler constant. Nothing here injects an aggregate by
// hand; frames go through the host socket and the runtime's real frame dispatch.

const PASSWORD = "usage-password";
const SESSION_ID = "durable-1";
const WAIT_MS = 5_000;

type Usage = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; cost: number };

function auth(): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${BASIC_USERNAME}:${PASSWORD}`, "utf8").toString("base64")}` };
}

function framesFor(index: number, usage: Usage): Record<string, unknown>[] {
  const id = `msg_${index}`;
  return [
    { type: "agent_start", runId: `run_${index}` },
    { type: "message_start", message: { role: "assistant", id, provider: "opencode-go", model: "deepseek-v4.1-flash", content: [] } },
    {
      type: "message_end",
      message: {
        role: "assistant",
        id,
        usage: {
          input: usage.input,
          output: usage.output,
          reasoning: usage.reasoning,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
          cost: { total: usage.cost },
        },
      },
    },
    { type: "agent_end", messages: [], willRetry: false },
  ];
}

/** The host's own transcript record for one completed assistant message. */
function transcriptEntry(index: number, usage: Usage): Record<string, unknown> {
  return {
    type: "message",
    id: `entry_${index}`,
    parentId: null,
    timestamp: new Date(Date.UTC(2026, 10, 5, 0, index)).toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: `turn ${index}` }],
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      usage: {
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        cost: { total: usage.cost },
      },
      stopReason: "stop",
    },
  };
}

/** Subscribes before the frames are emitted and resolves on the exact events, never on a sleep. */
function usageEvents(count: number): { events: Promise<BridgeEvent[]>; close: () => void } {
  const subscription: EventSubscription = eventBus.subscribe({ types: ["session.usage.updated"] });
  const reader = subscription.stream.getReader();
  const events = (async () => {
    const seen: BridgeEvent[] = [];
    while (seen.length < count) {
      const { done, value } = await reader.read();
      if (done || value === undefined) break;
      seen.push(value);
    }
    return seen;
  })();
  return {
    events: Promise.race([
      events,
      new Promise<BridgeEvent[]>((_, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} session.usage.updated events`)), WAIT_MS);
        events.then(() => clearTimeout(timer), () => clearTimeout(timer));
      }),
    ]),
    close: () => subscription.close(),
  };
}

type Fixture = { host: FakeSenpiHost; runtime: BridgeRuntime; root: string; base: string; stateDir: string };

const fixtures: Fixture[] = [];

async function start(host: FakeSenpiHost, root: string, stateDir: string): Promise<Fixture> {
  const runtime = await createRuntime({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    OMO_BRIDGE_PORT: "0",
    OMO_BRIDGE_PASSWORD: PASSWORD,
    OMO_BRIDGE_STATE_DIR: stateDir,
    OMO_BRIDGE_SENPI_SOCKET: host.socketPath,
    OMO_BRIDGE_KEY_ROOT: host.dir,
  });
  const fixture: Fixture = { host, runtime, root, base: `http://127.0.0.1:${runtime.server.port}`, stateDir };
  fixtures.push(fixture);
  return fixture;
}

async function sessionBody(base: string, path = "/api/session"): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${base}${path}`, { headers: auth() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: Array<Record<string, unknown>> | Record<string, unknown> };
  return Array.isArray(body.data) ? body.data : [body.data];
}

async function expectRow(base: string, expectedCost: number, expectedTokens: Record<string, unknown>): Promise<void> {
  const list = await sessionBody(base);
  const row = list.find((item) => item.id === SESSION_ID);
  expect(row).toBeDefined();
  expect(row!.cost).toBeCloseTo(expectedCost, 10);
  expect(row!.tokens).toEqual(expectedTokens);

  const single = await sessionBody(base, `/api/session/${SESSION_ID}`);
  expect(single[0]!.cost).toBeCloseTo(expectedCost, 10);
  expect(single[0]!.tokens).toEqual(expectedTokens);
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.close();
    fixture.host.stop();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

describe("session usage composition", () => {
  test("two executions through the real dispatch path sum into the session row", async () => {
    const root = mkdtempSync(join(tmpdir(), "omo-bridge-usage-"));
    const host = FakeSenpiHost.start();
    const fixture = await start(host, root, join(root, "state"));

    const waiter = usageEvents(2);
    try {
      for (const frame of framesFor(1, { input: 100, output: 40, reasoning: 0, cacheRead: 10, cacheWrite: 5, cost: 0.02 })) {
        host.emit(frame);
      }
      for (const frame of framesFor(2, { input: 20, output: 10, reasoning: 3, cacheRead: 1, cacheWrite: 2, cost: 0.01 })) {
        host.emit(frame);
      }
      const events = await waiter.events;
      expect(events.map((event) => event.data)).toEqual([
        { sessionID: SESSION_ID, cost: 0.02, tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 10, write: 5 } } },
        { sessionID: SESSION_ID, cost: 0.01, tokens: { input: 20, output: 10, reasoning: 3, cache: { read: 1, write: 2 } } },
      ]);
    } finally {
      waiter.close();
    }

    await expectRow(fixture.base, 0.03, {
      input: 120,
      output: 50,
      reasoning: 3,
      cache: { read: 11, write: 7 },
    });
  });

  test("a reconnect re-seeds from the host transcript without double counting", async () => {
    const root = mkdtempSync(join(tmpdir(), "omo-bridge-reconnect-"));
    const host = FakeSenpiHost.start();
    const stateDir = join(root, "state");
    const sessionPath = join(host.dir, "session.jsonl");
    const first = { input: 100, output: 40, reasoning: 0, cacheRead: 10, cacheWrite: 5, cost: 0.02 };
    const persistedPart = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.004 };
    const laterPart = { input: 10, output: 5, reasoning: 3, cacheRead: 1, cacheWrite: 2, cost: 0.006 };
    const wholeSecondRun = { input: 20, output: 10, reasoning: 3, cacheRead: 1, cacheWrite: 2, cost: 0.01 };
    writeFileSync(
      sessionPath,
      `${[transcriptEntry(1, first), transcriptEntry(2, persistedPart)]
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
    );

    // The bridge starts mid-run: the seed already holds the persisted part of the second execution.
    const before = await start(host, root, stateDir);
    await expectRow(before.base, 0.024, { input: 110, output: 45, reasoning: 0, cache: { read: 10, write: 5 } });

    // senpi persists an assistant message before its message_end frame, so the transcript holds the
    // rest of the run by the time agent_end reports the whole run's total.
    appendFileSync(sessionPath, `${JSON.stringify(transcriptEntry(3, laterPart))}\n`);
    const waiter = usageEvents(1);
    try {
      for (const frame of framesFor(2, wholeSecondRun)) host.emit(frame);
      await waiter.events;
    } finally {
      waiter.close();
    }
    // 0.02 + 0.004 + 0.006, not 0.024 + 0.01: the seed's part of this run is not counted twice.
    await expectRow(before.base, 0.03, { input: 120, output: 50, reasoning: 3, cache: { read: 11, write: 7 } });

    // The bridge reconnects over the same state directory and transcript: the re-seed must replace
    // the aggregate, not add a second copy of every run.
    await before.runtime.close();
    fixtures.splice(fixtures.indexOf(before), 1);
    const after = await start(host, root, stateDir);
    await expectRow(after.base, 0.03, { input: 120, output: 50, reasoning: 3, cache: { read: 11, write: 7 } });
  });
});
