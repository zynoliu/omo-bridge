import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createEventBus, eventBus, type EventBus } from "../../src/http/events";
import {
  resetForms,
  handleFormCancel,
  handleFormReply,
  onQuestionFrame,
  setFormEventBus,
  setFormTransport,
} from "../../src/http/handlers/form";
import {
  resetSessionInboxState,
  translateQueueUpdate,
  type InboxEvent,
} from "../../src/http/handlers/inbox";
import {
  handlePermissionReply,
  onUiRequest,
  resetPermissions,
  setPermissionEventBus,
  setPermissionTransport,
} from "../../src/http/handlers/permission";
import {
  handleSessionMove,
  handleSessionRemove,
  handleSessionUpdate,
  resetSessionManagementState,
  sessionManagementStore,
  setSessionManagementStore,
  setSessionManagementTransport,
  type SessionManagementTransport,
} from "../../src/http/handlers/session-write";
import {
  handleSessionShell,
  resetShells,
  setShellEventBus,
  setShellTransport,
} from "../../src/http/handlers/shell";
import { SessionMap } from "../../src/model/session-map";
import type { SenpiSessionSummary } from "../../src/senpi/transport";
import { createLifecycleProjector } from "../../src/translate/lifecycle";
import { createStreamProjector } from "../../src/translate/stream";
import { createToolProjector } from "../../src/translate/tools";
import type { EventSink, TranslateContext } from "../../src/translate/types";

// The bridge side of the event type contract.
//
// `fixtures/event-shapes.json` transcribes, for every event type the bridge publishes, the `data`
// fields the TUI's generated client marks as required
// (packages/client/src/promise/generated/types.ts). This suite replays the senpi frames the bridge
// consumes through the real emitters - the three translate projectors, the session/inbox/shell/
// permission/form handlers and the event bus - and fails when the emitter omits a documented field
// or publishes a type the fixture does not document. The fixture is data only; the frames and the
// handler calls that produce each type live here.

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "event-shapes.json");
const SENPI_FRAMES = join(import.meta.dir, "..", "..", "contracts", "senpi");
const FORK = (process.env.OMO_BRIDGE_OPENCODE_FORK ?? "/Users/zyno/OmO Projects/my-tui/opencode").replace(/\/$/, "");
const CLIENT_TYPES = join(FORK, "packages/client/src/promise/generated/types.ts");

const SESSION_ID = "ses_contract";
const ROUTING_ID = "rpc-contract";
const START = 1_718_000_000_000;

type FixtureEvent = { emitter: string; required: string[] };
type Fixture = { source: string; events: Record<string, FixtureEvent> };

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;

type EventShape = { required: string[]; optional: string[] };

function declaredName(member: ts.PropertySignature): string | undefined {
  const name = member.name;
  if (name === undefined) return undefined;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function literalOf(node: ts.TypeNode | undefined): string | undefined {
  if (node === undefined || !ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) return undefined;
  return node.literal.text;
}

/** The event `data` shapes the fork's generated client declares, keyed by the event's type literal. */
function clientEventShapes(file: string): Map<string, EventShape> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const shapes = new Map<string, EventShape>();
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || !ts.isTypeLiteralNode(node.type)) return;
    const typeMember = node.type.members.find(
      (member): member is ts.PropertySignature => ts.isPropertySignature(member) && declaredName(member) === "type",
    );
    const eventType = typeMember === undefined ? undefined : literalOf(typeMember.type);
    if (eventType === undefined) return;
    const dataMember = node.type.members.find(
      (member): member is ts.PropertySignature => ts.isPropertySignature(member) && declaredName(member) === "data",
    );
    if (dataMember === undefined || dataMember.type === undefined || !ts.isTypeLiteralNode(dataMember.type)) return;
    const required: string[] = [];
    const optional: string[] = [];
    for (const member of dataMember.type.members) {
      if (!ts.isPropertySignature(member)) continue;
      const name = declaredName(member);
      if (name === undefined) continue;
      (member.questionToken === undefined ? required : optional).push(name);
    }
    if (!shapes.has(eventType)) shapes.set(eventType, { required, optional });
  });
  return shapes;
}

type Captured = { type: string; data: Record<string, unknown> };
type Frames = (ctx: TranslateContext, sink: EventSink) => { handle: (event: unknown) => void };

function replay(create: Frames, frames: unknown[]): Captured[] {
  const emitted: Captured[] = [];
  let sequence = 0;
  let clock = START;
  const ctx: TranslateContext = { sessionID: SESSION_ID, nextID: () => `evt_${++sequence}`, now: () => clock++ };
  const projector = create(ctx, (event) => {
    emitted.push({ type: event.type, data: event.data });
  });
  for (const frame of frames) projector.handle(frame);
  return emitted;
}

function recordedFrames(file: string): unknown[] {
  return readFileSync(join(SENPI_FRAMES, file), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { frame: unknown }).frame);
}

function recordedUiRequest(method: string): Record<string, unknown> {
  for (const frame of recordedFrames("events.jsonl")) {
    const record = frame as Record<string, unknown>;
    if (record.type === "extension_ui_request" && record.method === method) return record;
  }
  throw new Error(`no recorded extension_ui_request with method ${method}`);
}

function streamEvents(): Captured[] {
  return replay(createStreamProjector, recordedFrames("stream.jsonl"));
}

function toolEvents(): Captured[] {
  return replay(createToolProjector, recordedFrames("tools.jsonl"));
}

function lifecycleEvents(): Captured[] {
  const agentStart = { type: "agent_start" };
  const agentEnd = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    type: "agent_end",
    messages: [],
    willRetry: false,
    ...extra,
  });
  const messageStart = (id: string): Record<string, unknown> => ({
    type: "message_start",
    message: { role: "assistant", id, provider: "anthropic", model: "claude-sonnet-4", content: [], timestamp: START },
  });
  const usage = {
    input: 100,
    output: 40,
    reasoning: 0,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 155,
    cost: { total: 0.02 },
  };

  return [
    // A run that streams one step, reports usage and succeeds.
    ...replay(createLifecycleProjector, [
      agentStart,
      messageStart("msg_lc_1"),
      { type: "turn_start" },
      { type: "message_end", message: { role: "assistant", id: "msg_lc_1", usage } },
      agentEnd(),
    ]),
    ...replay(createLifecycleProjector, [
      agentStart,
      agentEnd({ failure: { category: "rate_limit", reason: "the provider is rate limiting requests", httpStatus: 429 } }),
    ]),
    ...replay(createLifecycleProjector, [agentStart, agentEnd({ aborted: true, abortSource: "user" })]),
    ...replay(createLifecycleProjector, [
      messageStart("msg_lc_2"),
      { type: "compaction_start", reason: "manual" },
      { type: "compaction_end", reason: "manual", result: { summary: "Summary of the earlier conversation" } },
    ]),
  ];
}

function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 2_000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Subscribes before `action` runs, so a publish inside it can never be missed. */
async function captureOn(bus: EventBus, type: string, action: () => Promise<unknown> | unknown): Promise<Captured> {
  const subscription = bus.subscribe({ types: [type] });
  const reader = subscription.stream.getReader();
  try {
    await action();
    const read = await withDeadline(reader.read(), `no ${type} event was published`);
    const event = read.value;
    if (event === undefined) throw new Error(`the ${type} subscription closed before a frame arrived`);
    return { type: event.type, data: event.data };
  } finally {
    void reader.cancel();
    subscription.close();
  }
}

function urlOf(path: string): URL {
  return new URL(`http://127.0.0.1:4319${path}`);
}

function request(method: string, path: string, body?: unknown): Request {
  return new Request(urlOf(path).toString(), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

function busEvent(): Captured[] {
  const event = createEventBus().serverConnectedEvent();
  return [{ type: event.type, data: event.data }];
}

function inboxEvents(): Captured[] {
  resetSessionInboxState();
  const emitted: Captured[] = [];
  const emit = (event: InboxEvent): void => {
    emitted.push({ type: event.type, data: event.data });
  };
  const frame = (ordered: Array<Record<string, unknown>>) => ({
    type: "queue_update",
    steering: [],
    followUp: [],
    ordered,
  });
  const entry = (mode: "steer" | "followUp") => ({
    queuedId: "q_1",
    text: "one",
    mode,
    enqueueOrder: 1,
    revision: 1,
  });

  translateQueueUpdate(frame([entry("steer")]), SESSION_ID, { now: () => START, emit });
  translateQueueUpdate(frame([entry("followUp")]), SESSION_ID, { now: () => START, emit });
  translateQueueUpdate(frame([]), SESSION_ID, { now: () => START, emit });
  return emitted;
}

async function shellEvents(): Promise<Captured[]> {
  const bus = createEventBus();
  resetShells();
  setShellEventBus(bus);
  setShellTransport({ bash: async () => ({ output: "hello\n", exitCode: 0 }) });
  const run = (): Promise<Response> => {
    const path = `/api/session/${SESSION_ID}/shell`;
    return handleSessionShell(request("POST", path, { command: "echo hello" }), urlOf(path));
  };
  return [
    await captureOn(bus, "session.shell.started", run),
    await captureOn(bus, "session.shell.ended", run),
  ];
}

async function permissionEvents(): Promise<Captured[]> {
  const bus = createEventBus();
  resetPermissions();
  setPermissionEventBus(bus);
  setPermissionTransport({ sessionId: SESSION_ID, sendExtensionUIResponse: async () => {} });

  const asked = await captureOn(bus, "permission.asked", () => onUiRequest(recordedUiRequest("select"), SESSION_ID));
  const requestID = String(asked.data.id);
  const replied = await captureOn(bus, "permission.replied", () => {
    const path = `/api/session/${SESSION_ID}/permission/${requestID}/reply`;
    return handlePermissionReply(request("POST", path, { decision: "once" }), urlOf(path));
  });
  return [asked, replied];
}

function questionFrame(id: string): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id,
    method: "question",
    requestId: `${id}-request`,
    toolCallId: `${id}-call`,
    waitForAnswer: true,
    questions: [
      {
        id: "db",
        header: "Database",
        question: "Which database should I use?",
        options: [{ label: "PostgreSQL" }, { label: "SQLite" }],
        multiSelect: false,
      },
      {
        id: "features",
        header: "Features",
        question: "Which features do you need?",
        options: [{ label: "Indexes" }, { label: "WAL" }],
        multiSelect: true,
      },
    ],
  };
}

async function formEvents(): Promise<Captured[]> {
  const bus = createEventBus();
  resetForms();
  setFormEventBus(bus);
  setFormTransport({ sendExtensionUIResponse: async () => {} });

  const created = await captureOn(bus, "form.created", () => onQuestionFrame(questionFrame("uuid-q1"), SESSION_ID));
  const formOf = (event: Captured): string => String((event.data.form as { id?: unknown }).id);
  const replied = await captureOn(bus, "form.replied", () => {
    const path = `/api/session/${SESSION_ID}/form/${formOf(created)}/reply`;
    return handleFormReply(request("POST", path, { answer: { q0: "PostgreSQL", q1: ["WAL"] } }), urlOf(path));
  });
  const second = await captureOn(bus, "form.created", () => onQuestionFrame(questionFrame("uuid-q2"), SESSION_ID));
  const cancelled = await captureOn(bus, "form.cancelled", () => {
    const path = `/api/session/${SESSION_ID}/form/${formOf(second)}`;
    return handleFormCancel(request("DELETE", path), urlOf(path));
  });
  return [created, replied, cancelled];
}

let root: string | undefined;

async function sessionWriteEvents(): Promise<Captured[]> {
  root = mkdtempSync(join(tmpdir(), "event-shapes-"));
  const stateDir = join(root, "state");
  const agentDir = join(root, "agent");
  const workDir = join(root, "work");
  const row = {
    sessionId: ROUTING_ID,
    status: "open",
    durableSessionId: SESSION_ID,
    sessionPath: join(agentDir, "sessions", "contract.jsonl"),
    cwd: workDir,
    name: "contract",
  } as unknown as SenpiSessionSummary;
  const map = SessionMap.open({ stateDir, agentDir, warn: () => {} });
  map.upsert(row);
  const transport: SessionManagementTransport = {
    sessionId: ROUTING_ID,
    listSessions: async () => [row],
    setSessionName: async () => {},
    openSession: async () => ({ sessionId: ROUTING_ID }),
    unloadSession: async () => ({ outcome: "unloaded" }),
  };
  setSessionManagementStore(sessionManagementStore(map));
  setSessionManagementTransport(transport);
  resetSessionManagementState();

  const sessionPath = `/api/session/${SESSION_ID}`;
  const patch = (body: unknown, type: string): Promise<Captured> =>
    captureOn(eventBus, type, () => handleSessionUpdate(request("PATCH", sessionPath, body), urlOf(sessionPath)));
  const movePath = `${sessionPath}/move`;
  const removePath = sessionPath;

  return [
    await patch({ title: "Renamed" }, "session.renamed"),
    await patch({ archived: true }, "session.archived"),
    await patch({ archived: false }, "session.unarchived"),
    await patch({ metadata: { topic: "event contract" } }, "session.metadata.updated"),
    await patch({ permissions: [{ action: "read", resource: "/project/a.txt", effect: "allow" }] }, "session.permissions"),
    await captureOn(eventBus, "session.moved", () =>
      handleSessionMove(request("POST", movePath, { location: { directory: workDir } }), urlOf(movePath)),
    ),
    await captureOn(eventBus, "session.deleted", () =>
      handleSessionRemove(request("DELETE", removePath), urlOf(removePath)),
    ),
  ];
}

const PRODUCERS: Record<string, () => Captured[] | Promise<Captured[]>> = {
  bus: busEvent,
  form: formEvents,
  inbox: inboxEvents,
  lifecycle: lifecycleEvents,
  permission: permissionEvents,
  "session-write": sessionWriteEvents,
  shell: shellEvents,
  stream: streamEvents,
  tools: toolEvents,
};

const produced = new Map<string, Map<string, Captured>>();

beforeAll(async () => {
  for (const [emitter, produce] of Object.entries(PRODUCERS)) {
    const byType = new Map<string, Captured>();
    for (const event of await produce()) {
      if (!byType.has(event.type)) byType.set(event.type, event);
    }
    produced.set(emitter, byType);
  }
});

afterAll(() => {
  setSessionManagementStore(undefined);
  setSessionManagementTransport(undefined);
  resetSessionManagementState();
  resetSessionInboxState();
  setShellTransport(undefined);
  setShellEventBus(undefined);
  resetShells();
  setPermissionTransport(undefined);
  setPermissionEventBus(undefined);
  resetPermissions();
  setFormTransport(undefined);
  setFormEventBus(undefined);
  resetForms();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe("event shapes", () => {
  test.skipIf(!existsSync(CLIENT_TYPES))("the fixture transcribes the client's required data fields exactly", () => {
    const shapes = clientEventShapes(CLIENT_TYPES);
    const drift: string[] = [];
    for (const [type, entry] of Object.entries(fixture.events)) {
      const shape = shapes.get(type);
      if (shape === undefined) {
        drift.push(`${type}: the client declares no event type with this literal`);
        continue;
      }
      const declared = [...shape.required].sort();
      const documented = [...entry.required].sort();
      if (declared.join("|") !== documented.join("|")) {
        drift.push(`${type}: the client requires [${declared}] but the fixture lists [${documented}]`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("every fixture entry names an emitter this suite drives", () => {
    const unknown = [...new Set(Object.values(fixture.events).map((entry) => entry.emitter))].filter(
      (emitter) => !Object.hasOwn(PRODUCERS, emitter),
    );
    expect(unknown).toEqual([]);
  });

  for (const [type, entry] of Object.entries(fixture.events)) {
    test(`${type} carries the data fields the TUI requires`, () => {
      const event = produced.get(entry.emitter)?.get(type);
      expect(event).toBeDefined();
      const data = event?.data ?? {};
      const missing = entry.required.filter((field) => !Object.hasOwn(data, field) || data[field] === undefined);
      expect(missing).toEqual([]);
    });
  }

  for (const emitter of Object.keys(PRODUCERS)) {
    test(`the ${emitter} emitter publishes no type the fixture omits`, () => {
      const documented = Object.entries(fixture.events)
        .filter(([, entry]) => entry.emitter === emitter)
        .map(([type]) => type)
        .sort();
      const emitted = [...(produced.get(emitter)?.keys() ?? [])].sort();
      expect(emitted).toEqual(documented);
    });
  }
});
