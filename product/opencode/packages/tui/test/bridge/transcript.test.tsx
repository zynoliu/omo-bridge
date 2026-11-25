import { afterEach, describe, expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import type { SessionInfo, SessionMessageInfo, SessionStructuredError } from "@opencode/client";
import { BridgeData } from "../../../bridge-core/src/data.ts";
import { DialogRegistry } from "../../../bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../bridge-core/src/sessions.ts";
import { createBridgeTuiData, type BridgeTuiData } from "../../src/context/bridge-data.ts";
import { bridgeEvents } from "../fixture/bridge-events.ts";
import { Transcript } from "../../src/bridge/features/transcript/index.ts";
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

const sessionInfo: SessionInfo = {
  id: "s1",
  projectID: "proj_1",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 },
  title: "Transcript fixture",
  location: { directory: "/workspace/s1" },
};

const model = { providerID: "fixture", id: "fixture-model" };

function host(options: { readonly running: boolean }) {
  const data = new BridgeData();
  data.upsertHostSession(sessionInfo);
  const sessions = new SessionRegistry();
  const opened = sessions.open({ persistentId: "s1" });
  if (opened.kind !== "ok") throw new Error("session fixture refused the open");
  if (options.running) {
    const active = sessions.markActive(opened.value);
    if (active.kind !== "ok") throw new Error("session fixture refused the activation");
  }
  const tui = createBridgeTuiData({
    data: data,
    sessions: sessions,
    dialogs: new DialogRegistry(),
    interaction: new InteractionController(),
    defaultLocation: { directory: "/workspace" },
    events: bridgeEvents(data),
  });
  return { data: data, tui: tui };
}

const userMessage: SessionMessageInfo = {
  id: "m1",
  type: "user",
  time: { created: 1 },
  text: "请解释这段代码",
};

async function mount(input: {
  readonly tui: BridgeTuiData;
  readonly width: number;
  readonly height: number;
  readonly revision?: () => unknown;
}) {
  mounted?.renderer.destroy();
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ConfigProvider config={createTuiResolvedConfig({ animations: false })}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Transcript data={input.tui} sessionID="s1" revision={input.revision} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: input.width, height: input.height },
  );
  mounted = app;
  await app.renderOnce();
  await app.renderOnce();
  return app;
}

/* The left border glyph repeats on every wrapped line, and whitespace is reflowed, so content checks ignore both. */
function squash(text: string) {
  return text.replace(/┃/g, "").replace(/\s+/g, "");
}

describe("bridge transcript", () => {
  test("renders user text, assistant text, thinking, a tool call and its result from host payloads", async () => {
    const bridge = host({ running: false });
    bridge.data.setHostMessages("s1", [
      userMessage,
      {
        id: "m2",
        type: "assistant",
        agent: "build",
        model: model,
        time: { created: 2, completed: 9 },
        content: [
          { type: "reasoning", text: "检查宿主消息载荷", time: { created: 2, completed: 3 } },
          { type: "text", text: "正在读取会话载荷" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            time: { created: 3, completed: 4 },
            state: {
              status: "completed",
              input: { path: "src/index.ts" },
              content: [{ type: "text", text: "const 世界 = 1" }],
              metadata: {},
            },
          },
        ],
      },
    ]);
    const app = await mount({ tui: bridge.tui, width: 80, height: 40 });
    const view = app.captureCharFrame();
    expect(view).toContain("请解释这段代码");
    expect(view).toContain("正在读取会话载荷");
    expect(view).toContain("检查宿主消息载荷");
    expect(view).toContain("read");
    expect(view).toContain("src/index.ts");
    expect(view).toContain("const 世界 = 1");
    expect(view).toContain("Build · fixture/fixture-model");
  });

  test("shows the streaming state while a message arrives and the final state once it completes", async () => {
    const [revision, bump] = createSignal(0);
    const bridge = host({ running: true });
    bridge.data.setHostMessages("s1", [userMessage]);
    const app = await mount({ tui: bridge.tui, width: 80, height: 40, revision: revision });
    expect(app.captureCharFrame()).toContain("Streaming");

    bridge.data.setHostMessages("s1", [
      userMessage,
      {
        id: "m2",
        type: "assistant",
        agent: "build",
        model: model,
        time: { created: 2 },
        content: [{ type: "text", text: "部分回复" }],
      },
    ]);
    bump(1);
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("部分回复");
    expect(app.captureCharFrame()).toContain("Streaming");

    bridge.data.setHostMessages("s1", [
      userMessage,
      {
        id: "m2",
        type: "assistant",
        agent: "build",
        model: model,
        time: { created: 2, completed: 9 },
        content: [{ type: "text", text: "完整回复" }],
      },
    ]);
    bump(2);
    await app.renderOnce();
    const settled = app.captureCharFrame();
    expect(settled).toContain("完整回复");
    expect(settled).not.toContain("Streaming");
    expect(settled).toContain("Build · fixture/fixture-model");
  });

  test("wide characters and a narrow terminal keep every message, thinking and tool result visible", async () => {
    const bridge = host({ running: false });
    bridge.data.setHostMessages("s1", [
      { id: "m1", type: "user", time: { created: 1 }, text: "宽字符输入：请核对每一行内容" },
      {
        id: "m2",
        type: "assistant",
        agent: "build",
        model: model,
        time: { created: 2, completed: 9 },
        content: [
          { type: "reasoning", text: "思考过程：先找到宿主载荷再渲染", time: { created: 2, completed: 3 } },
          { type: "text", text: "助手回复：终端宽度很窄时也不能丢失内容" },
          {
            type: "tool",
            id: "call_wide",
            name: "read",
            time: { created: 3, completed: 4 },
            state: {
              status: "completed",
              input: { path: "src/宽字符.ts" },
              content: [{ type: "text", text: "结果：世界你好，宽字符与窄终端都不丢内容" }],
              metadata: {},
            },
          },
        ],
      },
    ]);
    const expected = [
      "宽字符输入：请核对每一行内容",
      "思考过程：先找到宿主载荷再渲染",
      "助手回复：终端宽度很窄时也不能丢失内容",
      "结果：世界你好，宽字符与窄终端都不丢内容",
    ];
    const wide = await mount({ tui: bridge.tui, width: 96, height: 40 });
    for (const text of expected) expect(squash(wide.captureCharFrame())).toContain(squash(text));

    const narrow = await mount({ tui: bridge.tui, width: 24, height: 60 });
    for (const text of expected) expect(squash(narrow.captureCharFrame())).toContain(squash(text));
  });

  test("renders an explicit error state from a failed run and still echoes input that follows", async () => {
    const [revision, bump] = createSignal(0);
    const bridge = host({ running: false });
    const failure: SessionStructuredError = { type: "provider.unavailable", message: "模型不可用" };
    const failedAssistant: SessionMessageInfo = {
      id: "m2",
      type: "assistant",
      agent: "build",
      model: model,
      time: { created: 2, completed: 5 },
      content: [],
      error: failure,
    };
    const failedIdle: SessionMessageInfo = { id: "m3", type: "idle", time: { created: 5 }, outcome: "failed", error: failure };
    bridge.data.setHostMessages("s1", [userMessage, failedAssistant, failedIdle]);
    const app = await mount({ tui: bridge.tui, width: 80, height: 40, revision: revision });
    const failed = app.captureCharFrame();
    expect(failed).toContain("Error:");
    expect(failed).toContain("模型不可用");
    expect(failed).not.toContain("Streaming");

    bridge.data.setHostMessages("s1", [
      userMessage,
      failedAssistant,
      failedIdle,
      { id: "m4", type: "user", time: { created: 6 }, text: "错误后继续输入" },
    ]);
    expect(bridge.tui.session.message.list("s1").length).toBe(4);
    bump(1);
    await app.renderOnce();
    const continued = app.captureCharFrame();
    expect(continued).toContain("错误后继续输入");
    expect(continued).toContain("Error:");
    expect(continued).toContain("模型不可用");
  });
});
