import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import type { MemoryFactsRequest } from "../../src/bridge/features/status/index.ts";
import {
  connectBridgeStatus,
  createStatusStore,
  NOT_REPORTED,
  Status,
  statusColumnFits,
  statusColumnWidth,
} from "../../src/bridge/features/status/index.ts";
import type { StatusStore, StatusStoreDeps } from "../../src/bridge/features/status/index.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { ConfigProvider } from "../../src/config";
import { ThemeProvider } from "../../src/context/theme";
import { bridgeEvents } from "../fixture/bridge-events.ts";
import { emptyThemeSource } from "../fixture/fixture";
import { TestTuiContexts } from "../fixture/tui-environment";
import { createTuiResolvedConfig } from "../fixture/tui-runtime";

type Mounted = Awaited<ReturnType<typeof testRender>>;

let mounted: Mounted | undefined;
const stops: (() => void)[] = [];

afterEach(() => {
  mounted?.renderer.destroy();
  mounted = undefined;
  for (const stop of stops.splice(0)) stop();
});

const SESSION = "session-status-1";
const OTHER_SESSION = "session-status-2";

function bridge() {
  const data = new BridgeData();
  const tui = createBridgeTuiData({
    data: data,
    sessions: new SessionRegistry(),
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace/bridge" },
    events: bridgeEvents(data),
  });
  return { data: data, tui: tui };
}

function opened(input: { readonly sessionID?: string | null; readonly applyFacts?: StatusStoreDeps["applyFacts"] } = {}) {
  const host = bridge();
  const store = createStatusStore({
    sessionID: input.sessionID === undefined ? SESSION : input.sessionID,
    applyFacts: input.applyFacts,
  });
  stops.push(connectBridgeStatus(store, host.data));
  return { host: host, store: store };
}

async function mount(store: StatusStore, width = 120, height = 90) {
  mounted?.renderer.destroy();
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Status store={store} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: width, height: height },
  );
  mounted = app;
  await app.renderOnce();
  await app.renderOnce();
  return app;
}

function squash(text: string) {
  return text.replace(/\s+/g, "");
}

function memoryFrame(input: { readonly sessionId?: string; readonly omitRepoSizeFields?: boolean } = {}) {
  const repo = {
    headSha: "9f2c1d4",
    headSubject: "journal: bridge status surface",
    committedAtISO: "2026-11-17T08:00:00.000Z",
    dirty: true,
    dirtyPaths: 2,
    systemTokensEstimate: 1200,
    ...(input.omitRepoSizeFields === true
      ? {}
      : { totalBytes: 40960, systemBytes: 20480, fileCount: 12, entriesToday: 3 }),
  };
  return {
    type: "extension_event",
    name: "omo.memory.updated",
    sessionId: input.sessionId ?? SESSION,
    data: {
      schemaVersion: 1,
      identity: "bridge-agent",
      repo: repo,
      reflection: { backlogSteps: 1, pendingCompaction: false, consecutiveFailures: 0 },
      journal: { sessionId: input.sessionId ?? SESSION, totalSteps: 4, reflectedSteps: 3 },
    },
  };
}

function teamFrame(memberName: string, state: string) {
  return {
    type: "custom_message",
    customType: "senpi-task.team-member-liveness",
    display: false,
    sessionId: SESSION,
    content: "Team member liveness: " + memberName + " exited abnormally; last known state: " + state + ".",
    details: {
      memberName: memberName,
      lastKnownState: state,
      reason: "rpc connection reset",
      deliveryKey: "team-member-liveness:" + memberName + ":1",
    },
  };
}

describe("bridge status surfaces", () => {
  test("a memory event updates the memory surface and a missing field reads as not reported", async () => {
    const open = opened();
    open.host.data.publishEvent(memoryFrame({ omitRepoSizeFields: true }));

    const surface = open.store.memory();
    if (surface.kind !== "reported") throw new Error("expected the memory surface to be reported");
    expect(surface.snapshot.identity).toBe("bridge-agent");
    expect(surface.snapshot.journal.sessionId).toBe(SESSION);
    expect(surface.fields.find((field) => field.label === "identity")?.text).toBe("bridge-agent");
    const totalBytes = surface.fields.find((field) => field.label === "total bytes");
    expect(totalBytes?.reported).toBe(false);
    expect(totalBytes?.text).toBe(NOT_REPORTED);
    expect(surface.fields.find((field) => field.label === "system token estimate")?.text).toBe("1200");

    const app = await mount(open.store);
    const frame = app.captureCharFrame();
    expect(frame).toContain("bridge-agent");
    expect(frame).toContain("not reported");
    expect(frame).not.toContain("40960");

    open.host.data.publishEvent(memoryFrame());
    const delivered = await mount(open.store);
    const deliveredFrame = delivered.captureCharFrame();
    expect(deliveredFrame).toContain("40960");
    expect(deliveredFrame).toContain("12");

    const narrowed = await mount(open.store, 44);
    const narrowFrame = narrowed.captureCharFrame();
    expect(narrowFrame).toContain("bridge-agent");
    expect(narrowFrame).toContain("not reported");
    expect(narrowFrame).toContain("40960");
  });

  test("a team event updates the member list, and a later report replaces that member's state", async () => {
    const open = opened();
    expect(open.store.team().kind).toBe("not-reported");

    open.host.data.publishEvent(teamFrame("scout", "error"));
    const first = open.store.team();
    if (first.kind !== "reported") throw new Error("expected the team surface to be reported");
    expect(first.rows.map((row) => [row.memberName, row.lastKnownState, row.killed])).toEqual([
      ["scout", "error", false],
    ]);
    expect(first.rows[0]?.reason).toBe("rpc connection reset");

    open.host.data.publishEvent(teamFrame("scout", "lost"));
    open.host.data.publishEvent(teamFrame("builder", "error"));
    const second = open.store.team();
    if (second.kind !== "reported") throw new Error("expected the team surface to stay reported");
    expect(second.rows.map((row) => [row.memberName, row.lastKnownState])).toEqual([
      ["scout", "lost"],
      ["builder", "error"],
    ]);

    const app = await mount(open.store);
    const frame = app.captureCharFrame();
    expect(frame).toContain("scout");
    expect(frame).toContain("builder");
    expect(frame).toContain("lost");
    expect(frame).toContain("The host sends no team roster over RPC");
  });

  test("a missing widget renders no fabricated row, and a zero-row widget stays zero rows", async () => {
    const open = opened();
    expect(open.store.widgets().kind).toBe("not-reported");

    const empty = await mount(open.store);
    const emptyFrame = empty.captureCharFrame();
    expect(emptyFrame).toContain("The host has sent no string-array widget for this session.");
    expect(emptyFrame).not.toContain("omo-task");
    expect(emptyFrame).not.toContain("todo-sidebar");
    expect(emptyFrame).toContain("component factory");

    open.host.data.publishEvent({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "omo-qa",
      widgetLines: [],
      widgetPlacement: "belowEditor",
    });
    const zero = open.store.widgets();
    if (zero.kind !== "reported") throw new Error("expected the widget surface to be reported");
    expect(zero.entries).toHaveLength(1);
    expect(zero.entries[0]?.lines).toHaveLength(0);
    expect(zero.entries[0]?.cleared).toBe(false);

    const zeroApp = await mount(open.store);
    const zeroFrame = zeroApp.captureCharFrame();
    expect(zeroFrame).toContain("omo-qa (belowEditor)");
    expect(zeroFrame).toContain("0 rows");
    expect(zeroFrame).not.toContain("Widget line");

    open.host.data.publishEvent({
      type: "extension_ui_request",
      method: "setWidget",
      widgetKey: "omo-qa",
      widgetLines: ["qa widget line one", "qa widget line two"],
      widgetPlacement: "belowEditor",
    });
    const filled = await mount(open.store);
    const filledFrame = filled.captureCharFrame();
    expect(filledFrame).toContain("qa widget line one");
    expect(filledFrame).toContain("qa widget line two");
  });

  test("a hidden notification stays hidden while a visible one is listed", async () => {
    const open = opened();
    open.host.data.publishEvent({
      type: "extension_ui_request",
      method: "notify",
      message: "build finished with warnings",
      notifyType: "warning",
    });
    open.host.data.publishEvent(teamFrame("scout", "error"));

    const view = open.store.notifications();
    expect(view.visible.map((entry) => entry.message)).toEqual(["build finished with warnings"]);
    expect(view.visible[0]?.level).toBe("warning");
    expect(view.hidden).toHaveLength(1);
    expect(view.hidden[0]?.display).toBe(false);
    expect(view.hidden[0]?.message).not.toContain("exited abnormally");

    const app = await mount(open.store);
    const frame = app.captureCharFrame();
    expect(frame).toContain("build finished with warnings");
    expect(frame).toContain("display=false");
    expect(squash(frame)).toContain("1notification(s)hiddenbythehost(display=false)");
    expect(frame).not.toContain("exited abnormally");
  });

  test("an unauthorized persistent write is refused, surfaced, and nothing is sent", async () => {
    const sent: MemoryFactsRequest[] = [];
    const open = opened({
      applyFacts: async (request) => {
        sent.push(request);
        return {
          outcome: "committed",
          sha: "abc1234",
          affectedPaths: ["facts/facts.jsonl"],
          batchId: request.batchId ?? "unknown",
        };
      },
    });

    const unauthorized = await open.store.authorizeWrite("memory-write-1", "not the shown content");
    expect(unauthorized.kind).toBe("refused");
    if (unauthorized.kind === "refused") expect(unauthorized.code).toBe("UNKNOWN_PLAN");
    expect(sent).toHaveLength(0);

    const planned = open.store.planWrite({
      records: [{ text: "the bridge renders only host facts" }],
      batchId: "8b6a6a2e-4a1f-4f0e-9a5c-2f7f3c1d9e10",
    });
    if (planned.kind !== "planned") throw new Error("expected the plan to be accepted");
    expect(planned.plan.content).toContain('"name": "omo.memory.facts.apply"');
    expect(planned.plan.content).toContain("the bridge renders only host facts");

    const tampered = await open.store.authorizeWrite(planned.plan.id, planned.plan.content + " ");
    expect(tampered.kind).toBe("refused");
    if (tampered.kind === "refused") expect(tampered.code).toBe("CONTENT_MISMATCH");
    expect(sent).toHaveLength(0);
    expect(open.store.pendingWrite()?.id).toBe(planned.plan.id);
    expect(open.store.notices().map((notice) => notice.code)).toContain("CONTENT_MISMATCH");

    const app = await mount(open.store);
    const refusedFrame = app.captureCharFrame();
    expect(refusedFrame).toContain("Refused (CONTENT_MISMATCH)");
    expect(refusedFrame).toContain("Not sent. Authorizing writes exactly this content");

    const committed = await open.store.authorizeWrite(planned.plan.id, planned.plan.content);
    expect(committed.kind).toBe("committed");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.batchId).toBe("8b6a6a2e-4a1f-4f0e-9a5c-2f7f3c1d9e10");
    expect(open.store.pendingWrite()).toBeNull();

    const committedApp = await mount(open.store);
    expect(committedApp.captureCharFrame()).toContain("Memory write committed abc1234");
  });

  test("a write with no channel is refused, and another session's frame never reaches these surfaces", async () => {
    const disconnected = opened();
    const planned = disconnected.store.planWrite({ records: [{ text: "anything" }], batchId: undefined });
    if (planned.kind !== "planned") throw new Error("expected the plan to be accepted");
    const refused = await disconnected.store.authorizeWrite(planned.plan.id, planned.plan.content);
    expect(refused.kind).toBe("refused");
    if (refused.kind === "refused") expect(refused.code).toBe("NOT_CONNECTED");

    const foreign = await disconnected.store.applyFrame(memoryFrame({ sessionId: OTHER_SESSION }));
    expect(foreign.kind).toBe("other-session");
    expect(disconnected.store.memory().kind).toBe("not-reported");
    expect(disconnected.store.otherSessionFrames()).toBe(1);

    const mismatched = await disconnected.store.applyFrame({
      type: "extension_event",
      name: "omo.memory.updated",
      data: {
        schemaVersion: 1,
        identity: "other-agent",
        repo: { dirty: false, dirtyPaths: 0, systemTokensEstimate: 1 },
        reflection: { backlogSteps: 0, pendingCompaction: false, consecutiveFailures: 0 },
        journal: { sessionId: OTHER_SESSION, totalSteps: 1, reflectedSteps: 1 },
      },
    });
    expect(mismatched.kind).toBe("refused");
    expect(disconnected.store.memory().kind).toBe("not-reported");
    expect(disconnected.store.notices().map((notice) => notice.code)).toContain("SESSION_MISMATCH");

    expect(statusColumnWidth(10)).toBe(32);
    expect(statusColumnWidth(200)).toBe(80);
    expect(statusColumnWidth(48)).toBe(48);
    expect(statusColumnFits(91)).toBe(false);
    expect(statusColumnFits(92)).toBe(true);
  });
});
