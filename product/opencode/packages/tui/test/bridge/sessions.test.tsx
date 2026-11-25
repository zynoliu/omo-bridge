import { afterEach, describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import type { SessionInfo } from "@opencode/client";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import type { SessionSeed } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";
import { createSessionsStore, Sessions } from "../../src/bridge/features/sessions/index.ts";
import type { SessionsStore } from "../../src/bridge/features/sessions/index.ts";
import { ConfigProvider } from "../../src/config";
import { ThemeProvider } from "../../src/context/theme";
import { emptyThemeSource } from "../fixture/fixture";
import { TestTuiContexts } from "../fixture/tui-environment";
import { createTuiResolvedConfig } from "../fixture/tui-runtime";

type Mounted = Awaited<ReturnType<typeof testRender>>;

let mounted: Mounted | undefined;

afterEach(() => {
  mounted?.renderer.destroy();
  mounted = undefined;
});

function sessionInfo(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: id,
    projectID: "proj_1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Session " + id,
    location: { directory: "/workspace/" + id },
    ...extra,
  };
}

function bridge(options: { readonly payloads?: readonly SessionInfo[]; readonly seed?: SessionSeed } = {}) {
  const data = new BridgeData();
  for (const info of options.payloads ?? []) data.upsertHostSession(info);
  const sessions = new SessionRegistry(options.seed);
  const tui = createBridgeTuiData({
    data: data,
    sessions: sessions,
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace/default" },
    events: bridgeEvents(data),
  });
  return { data: data, sessions: sessions, tui: tui };
}

type Host = ReturnType<typeof bridge>;

function store(host: Host): SessionsStore {
  return createSessionsStore({ data: host.tui, sessions: host.sessions });
}

async function mount(input: { readonly host: Host; readonly store?: SessionsStore; readonly width?: number }) {
  mounted?.renderer.destroy();
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Sessions data={input.host.tui} sessions={input.host.sessions} store={input.store} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width ?? 90, height: 40 },
  );
  mounted = app;
  await app.renderOnce();
  await app.renderOnce();
  return app;
}

function squash(text: string) {
  return text.replace(/\s+/g, "");
}

describe("bridge sessions", () => {
  test("an empty bridge yields an empty list, and seeded history never becomes a row", async () => {
    const host = bridge({ seed: { historyByPersistentId: { ghost: ["supplied entry"] } } });
    const view = store(host);
    expect(view.rows()).toEqual([]);
    expect(view.recordedHistory()).toEqual([]);
    expect(view.selectedId()).toBeNull();
    expect(view.select("ghost")).toBe(false);
    expect(view.placement()).toBeNull();

    const app = await mount({ host: host, store: view });
    const frame = app.captureCharFrame();
    expect(frame).toContain("No sessions are held by the bridge.");
    expect(frame).toContain("The bridge was not given history for any session.");
    expect(frame).not.toContain("ghost");
  });

  test("the list reflects the held sessions with their delivered title and bridge status", async () => {
    const host = bridge({ payloads: [sessionInfo("s1"), sessionInfo("s2", { title: "Renamed by host" })] });
    const opened = host.sessions.open({ persistentId: "s2" });
    if (opened.kind !== "ok") throw new Error("fixture refused the open");
    const active = host.sessions.markActive(opened.value);
    if (active.kind !== "ok") throw new Error("fixture refused the activation");
    const view = store(host);

    expect(view.rows().map((row) => [row.persistentId, row.title, row.status, row.state])).toEqual([
      ["s1", "Session s1", "idle", null],
      ["s2", "Renamed by host", "running", "active"],
    ]);

    const app = await mount({ host: host, store: view });
    const frame = app.captureCharFrame();
    expect(squash(frame)).toContain("›Sessions1idle");
    expect(squash(frame)).toContain("Renamedbyhostrunning");
  });

  test("switching the selected session changes what the module reports and what the list marks", async () => {
    const host = bridge({ payloads: [sessionInfo("s1"), sessionInfo("s2")] });
    const view = store(host);
    expect(view.selectedId()).toBe("s1");
    expect(view.select("s2")).toBe(true);
    expect(view.selectedId()).toBe("s2");
    expect(view.rows().filter((row) => row.selected).map((row) => row.persistentId)).toEqual(["s2"]);
    expect(view.move(-1)).toBe("s1");
    expect(view.selectedId()).toBe("s1");

    view.select("s2");
    const app = await mount({ host: host, store: view });
    expect(squash(app.captureCharFrame())).toContain("›Sessions2idle");
    view.select("s1");
    await app.renderOnce();
    expect(squash(app.captureCharFrame())).toContain("›Sessions1idle");
  });

  test("reopening a parked session restores the history the bridge was given", async () => {
    const host = bridge({ payloads: [sessionInfo("s1")] });
    const opened = host.sessions.open({ persistentId: "s1", history: ["first turn", "second turn"] });
    if (opened.kind !== "ok") throw new Error("fixture refused the open");
    const parked = host.sessions.park(opened.value);
    if (parked.kind !== "ok") throw new Error("fixture refused the park");
    expect(host.sessions.list().map((record) => record.state)).toEqual(["parked"]);

    const view = store(host);
    const outcome = view.reopen("s1");
    expect(outcome.kind).toBe("reopened");
    if (outcome.kind !== "reopened") throw new Error("expected a reopen");
    expect(outcome.entries).toEqual(["first turn", "second turn"]);
    expect(view.failure()).toBeNull();
    expect(view.selectedId()).toBe("s1");
    expect(view.history()?.entries).toEqual(["first turn", "second turn"]);
    expect(view.history()?.source).toBe("recorded");
    expect(host.sessions.history(outcome.handle)).toEqual({ kind: "ok", value: ["first turn", "second turn"] });

    const app = await mount({ host: host, store: view });
    const frame = app.captureCharFrame();
    expect(frame).toContain("first turn");
    expect(frame).toContain("second turn");
    expect(frame).toContain("Reopened s1 as " + outcome.handle);
  });

  test("a refused reopen raises the error state and leaves the selection untouched", async () => {
    const host = bridge({ payloads: [sessionInfo("s1"), sessionInfo("s2")] });
    const view = store(host);
    expect(view.select("s2")).toBe(true);

    const outcome = view.reopen("not-held-by-the-bridge");
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("expected a refusal");
    expect(outcome.code).toBe("UNKNOWN_PERSISTENT_ID");
    expect(view.failure()?.code).toBe("UNKNOWN_PERSISTENT_ID");
    expect(view.selectedId()).toBe("s2");
    expect(view.rows().filter((row) => row.selected).map((row) => row.persistentId)).toEqual(["s2"]);
    expect(view.reopened()).toBeNull();

    const app = await mount({ host: host, store: view });
    const frame = app.captureCharFrame();
    expect(frame).toContain("Reopen refused (UNKNOWN_PERSISTENT_ID) for not-held-by-the-bridge");
    expect(squash(frame)).toContain("›Sessions2idle");

    view.clearFailure();
    await app.renderOnce();
    expect(app.captureCharFrame()).not.toContain("Reopen refused");
  });

  test("tree navigation follows a delivered parentID and steps between parent and child", async () => {
    const host = bridge({ payloads: [sessionInfo("root"), sessionInfo("child", { parentID: "root" })] });
    const view = store(host);
    expect(view.select("root")).toBe(true);

    const tree = view.tree();
    expect(tree?.root).toBe("root");
    expect(tree?.link).toBe("payload-parent");
    expect(tree?.nodes.map((node) => [node.persistentId, node.depth, node.parentId])).toEqual([
      ["root", 0, null],
      ["child", 1, "root"],
    ]);

    expect(view.focusChild(0)).toBe(true);
    expect(view.selectedId()).toBe("child");
    expect(view.focusChild(0)).toBe(false);
    expect(view.focusParent()).toBe(true);
    expect(view.selectedId()).toBe("root");

    const app = await mount({ host: host, store: view });
    const frame = app.captureCharFrame();
    expect(frame).toContain("parent and child come from the parentID delivered with each session payload");
    expect(squash(frame)).toContain("root└Sessionchild");
  });

  test("a bridge that reports only the session itself yields a single-node tree", async () => {
    const host = bridge({ payloads: [sessionInfo("s1"), sessionInfo("s2")] });
    const view = store(host);
    expect(view.select("s1")).toBe(true);

    const tree = view.tree();
    expect(tree?.familyReport).toEqual(["s1"]);
    expect(tree?.link).toBe("none");
    expect(tree?.nodes.map((node) => [node.persistentId, node.depth, node.parentId])).toEqual([["s1", 0, null]]);
    expect(view.focusParent()).toBe(false);
    expect(view.focusChild(0)).toBe(false);
    expect(view.selectedId()).toBe("s1");

    const app = await mount({ host: host, store: view });
    expect(app.captureCharFrame()).toContain("the bridge reports only this session, so the tree has a single node");
  });

  test("placement reports the delivered location and labels relocation as a transfer", async () => {
    const host = bridge({ payloads: [sessionInfo("s1")] });
    const view = store(host);
    const placement = view.placement();
    expect(placement?.persistentId).toBe("s1");
    expect(placement?.directory).toBe("/workspace/s1");
    expect(placement?.directory).not.toBe(host.tui.location.default().directory);
    expect(placement?.semantics).toBe("transfer");
    expect(placement?.note).not.toContain("current directory");

    const app = await mount({ host: host, store: view });
    expect(app.captureCharFrame()).toContain("Opened in /workspace/s1");
  });
});
