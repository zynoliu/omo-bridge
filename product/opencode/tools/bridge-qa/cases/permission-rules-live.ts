import type { CaseContext, CaseResult, Check } from "../run.ts";
import { createBridgeHostOps, createBridgePromptSender } from "../../../packages/cli/src/bridge-run.ts";
import type { HostSessionStatus } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import type { PermissionRule } from "../../../packages/bridge-core/src/permission-rules.ts";
import { SessionPermissionRules } from "../../../packages/bridge-core/src/permission-rules.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { createBridgeTuiContext } from "../../../packages/tui/src/context/bridge.ts";
import type { BridgeTuiContext } from "../../../packages/tui/src/context/bridge.ts";
import { isRecord, MODEL_HOST_MODEL, MODEL_HOST_PROVIDER, openModelHost, permissionAskFrames, toolResultText } from "./model-host.ts";
import type { Frame, ModelHost } from "./model-host.ts";

/**
 * P-668 against the real host and a real model turn: the bridge's own per-session rules answer the
 * host's approval dialog before a person sees it. Three sessions, each under the `ask` preset:
 *
 *   allow - the host asks, the bridge answers, no dialog is surfaced, and the tool's own result
 *           carries a token the prompt never mentions;
 *   deny  - the host asks, the bridge refuses with the rule's reason through the host's feedback
 *           dialog, no tool runs, and the model's tool result quotes that reason;
 *   ask   - the host asks, no rule answers, exactly one dialog reaches this client.
 */

const ALLOW_TOKEN = "allow-probe-7c31";
const DENY_REASON = "denied by the session deny rule: probing is off-limits";
const TOOL_PROMPT =
  "Use the read tool on /work/allow-probe.txt (do not use bash or eval) and then reply with the word DONE.";

type RunOutcome = {
  readonly asks: readonly Frame[];
  readonly surfaced: readonly Frame[];
  readonly toolTexts: readonly string[];
  readonly settle: string;
};

export async function run(_context: CaseContext): Promise<CaseResult> {
  let publish: ((frame: Frame) => void) | undefined;
  const host = await openModelHost("bridge-rules-", (frame) => publish?.(frame));
  if (host.kind === "blocked") {
    return { checks: [], cleanup: { ok: true, detail: [host.reason] }, blocked: true };
  }
  const checks: Check[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) =>
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  try {
    const data = new BridgeData();
    const sessions = new SessionRegistry();
    const routingById = new Map<string, string>();
    const statusById = new Map<string, HostSessionStatus>();
    const rules = new SessionPermissionRules();
    const surfaced: Frame[] = [];
    const recallRouting = (status: HostSessionStatus) => {
      routingById.set(status.durableId, status.routingId);
      statusById.set(status.durableId, status);
      data.rememberRoutingId(status.durableId, status.routingId);
    };
    const ops = createBridgeHostOps({
      transport: () => host.transport,
      data: data,
      sessions: sessions,
      routingById: routingById,
      statusById: statusById,
      recallRouting: recallRouting,
      pulled: new Set<string>(),
      interaction: new InteractionController(),
      cwd: "/work",
    });
    const context = createBridgeTuiContext(
      {
        data: data,
        defaultLocation: { directory: "/work" },
        sessions: sessions,
        dialogs: new DialogRegistry(),
        interaction: new InteractionController(),
        sendPrompt: createBridgePromptSender({
          transport: () => host.transport,
          data: data,
          sessions: sessions,
          routingId: (durableId) => routingById.get(durableId),
          status: (durableId) => statusById.get(durableId),
        }),
        permissionRules: rules,
      },
      () => "ready",
    );
    context.tuiData.hostDialogs.useSender((frame) => host.transport.send(frame));
    let answerEvery = false;
    context.tuiData.onHostDialog((dialog) => {
      surfaced.push(dialog as unknown as Frame);
      /* The ask run answers every dialog that reaches it, the way a person would; how many reached it is
         the measurement. Waiting for the prompt to resolve first would wait behind the dialog itself. */
      if (!answerEvery) return;
      context.tuiData.respondToHostDialog(dialog.id, { kind: "value", value: "Allow once" });
    });
    /* Every host frame reaches the data layer exactly as the launcher routes it. */
    publish = (frame) => data.publishEvent(frame);

    host.exec("printf '%s' '" + ALLOW_TOKEN + "' > /work/allow-probe.txt");

    const allow = await oneRun({
      host: host,
      ops: ops,
      routingById: routingById,
      context: context,
      rules: rules,
      surfaced: surfaced,
      label: "allow-run",
      rule: { action: "*", resource: "*", effect: "allow" },
      prompt: TOOL_PROMPT,
    });
    record("allow-rule-the-host-did-ask", "at least one permission ask", String(allow.asks.length), allow.asks.length >= 1);
    record("allow-rule-zero-dialogs-surfaced", "0 surfaced dialogs", String(allow.surfaced.length), allow.surfaced.length === 0);
    record(
      "allow-rule-the-tool-ran",
      "a tool result carries " + ALLOW_TOKEN,
      shortOf(allow.toolTexts),
      allow.toolTexts.some((text) => text.includes(ALLOW_TOKEN)),
    );

    const deny = await oneRun({
      host: host,
      ops: ops,
      routingById: routingById,
      context: context,
      rules: rules,
      surfaced: surfaced,
      label: "deny-run",
      rule: { action: "*", resource: "*", effect: "deny", reason: DENY_REASON },
      prompt: TOOL_PROMPT,
    });
    record("deny-rule-the-host-did-ask", "at least one permission ask", String(deny.asks.length), deny.asks.length >= 1);
    record("deny-rule-zero-dialogs-surfaced", "0 surfaced dialogs", String(deny.surfaced.length), deny.surfaced.length === 0);
    record(
      "deny-rule-the-tool-never-ran",
      "no tool result carries " + ALLOW_TOKEN,
      shortOf(deny.toolTexts),
      !deny.toolTexts.some((text) => text.includes(ALLOW_TOKEN)),
    );
    record(
      "deny-rule-the-model-reads-the-refusal-reason",
      "a tool result quotes the rule's reason",
      shortOf(deny.toolTexts),
      deny.toolTexts.some((text) => text.includes(DENY_REASON)),
    );

    const ask = await oneRun({
      host: host,
      ops: ops,
      routingById: routingById,
      context: context,
      rules: rules,
      surfaced: surfaced,
      label: "ask-run",
      rule: { action: "*", resource: "*", effect: "ask" },
      prompt: TOOL_PROMPT,
      answerSurfaced: true,
      armAnswer: (armed) => {
        answerEvery = armed;
      },
    });
    record("ask-rule-surfaces-exactly-one-dialog", "1 surfaced dialog", String(ask.surfaced.length), ask.surfaced.length === 1);
    record("ask-rule-the-tool-ran-once-a-person-answered", "the tool ran after the answer", shortOf(ask.toolTexts), ask.toolTexts.some((text) => text.includes(ALLOW_TOKEN)));
    record("ask-rule-run-settled", "a completed assistant turn", ask.settle, ask.settle === "stop");
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 240), false);
  }
  const detail = await host.close();
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}

async function oneRun(input: {
  readonly host: ModelHost;
  readonly ops: ReturnType<typeof createBridgeHostOps>;
  readonly routingById: Map<string, string>;
  readonly context: BridgeTuiContext;
  readonly rules: SessionPermissionRules;
  readonly surfaced: Frame[];
  readonly label: string;
  readonly rule: PermissionRule;
  readonly prompt: string;
  readonly answerSurfaced?: boolean;
  readonly armAnswer?: (armed: boolean) => void;
}): Promise<RunOutcome> {
  const session = await input.ops.createSession({ title: input.label });
  const routingId = input.routingById.get(session.id);
  if (routingId === undefined) throw new Error("the host never announced session " + session.id);
  const preset = await input.host.transport.request("set_permission_preset", {
    sessionId: routingId,
    permissionPreset: "ask",
  });
  if (preset.success !== true) throw new Error("set_permission_preset was refused: " + JSON.stringify(preset).slice(0, 200));
  const model = await input.host.transport.request("set_model", {
    sessionId: routingId,
    provider: MODEL_HOST_PROVIDER,
    modelId: MODEL_HOST_MODEL,
  });
  if (model.success !== true) throw new Error("set_model was refused");
  input.rules.set(session.id, [input.rule]);

  const startIndex = input.host.frames.list().length;
  const surfacedStart = input.surfaced.length;
  input.armAnswer?.(input.answerSurfaced === true);
  await withDeadline(
    input.context.tuiData.session.prompt({
      sessionID: session.id,
      text: input.prompt,
      clientMessageId: "rules-" + input.label + "-" + String(Date.now()),
    }),
    90_000,
    "the prompt was not accepted within 90s",
  );

  const deadline = Date.now() + 240_000;
  for (;;) {
    const window = input.host.frames.list().slice(startIndex);
    const surfacedWindow = input.surfaced.slice(surfacedStart);
    const settle = window.find(settledAssistant);
    if (settle !== undefined) {
      return {
        asks: permissionAskFrames(window),
        surfaced: surfacedWindow,
        toolTexts: window
          .filter((frame) => frame.type === "tool_execution_end" || frame.type === "message_end")
          .map(toolResultText)
          .filter((text) => text.length > 0),
        settle: String((settle.message as Frame).stopReason ?? ""),
      };
    }
    if (Date.now() > deadline) {
      return {
        asks: permissionAskFrames(window),
        surfaced: surfacedWindow,
        toolTexts: window.map(toolResultText).filter((text) => text.length > 0),
        settle: "timeout",
      };
    }
    await input.host.next(5_000);
  }
}

function withDeadline<Value>(operation: Promise<Value>, timeoutMs: number, detail: string): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(detail)), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function settledAssistant(frame: Frame): boolean {
  if (frame.type !== "message_end" || !isRecord(frame.message)) return false;
  if (frame.message.role !== "assistant") return false;
  return frame.message.stopReason === "stop";
}

function shortOf(texts: readonly string[]): string {
  return texts
    .map((text) => text.replace(/\s+/g, " ").slice(0, 150))
    .join(" | ")
    .slice(0, 400);
}
