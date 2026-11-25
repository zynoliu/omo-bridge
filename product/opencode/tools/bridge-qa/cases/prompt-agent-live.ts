import type { CaseContext, CaseResult, Check } from "../run.ts";
import { createBridgeHostOps, createBridgePromptSender, pullHostState } from "../../../packages/cli/src/bridge-run.ts";
import type { HostSessionStatus } from "../../../packages/cli/src/bridge-run.ts";
import { AGENT_REQUEST_MARKER } from "../../../packages/bridge-core/src/prompt-input.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { DialogRegistry } from "../../../packages/bridge-core/src/dialogs.ts";
import { InteractionController } from "../../../packages/bridge-core/src/interaction.ts";
import { SessionRegistry } from "../../../packages/bridge-core/src/sessions.ts";
import { createBridgeTuiContext } from "../../../packages/tui/src/context/bridge.ts";
import { assistantText, isRecord, MODEL_HOST_MODEL, MODEL_HOST_PROVIDER, openModelHost } from "./model-host.ts";

/**
 * P-685 against a real model turn: a prompt that names an agent is translated, not refused.
 *
 * The host prompt command carries no agent field, so the bridge prefixes one documented instruction,
 * sends the turn, records the translation on the session, and writes the request into the host's own
 * session context. Nothing may claim an agent ran: the record says the host field was not used, and
 * the assistant row carries no agent attribution.
 */

const REQUESTED_AGENT = "build";

export async function run(_context: CaseContext): Promise<CaseResult> {
  const host = await openModelHost("bridge-agent-");
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
      },
      () => "ready",
    );

    const session = await ops.createSession({ title: "agent-run" });
    const routingId = routingById.get(session.id);
    if (routingId === undefined) throw new Error("the host never announced session " + session.id);
    await host.transport.request("set_model", { sessionId: routingId, provider: MODEL_HOST_PROVIDER, modelId: MODEL_HOST_MODEL });

    const startIndex = host.frames.list().length;
    await context.tuiData.session.prompt({
      sessionID: session.id,
      text: "Reply with exactly: AGENT-OK",
      agent: REQUESTED_AGENT,
      clientMessageId: "agent-request-1",
    });
    const settled = await host.frames.waitFor(
      (frame) =>
        frame.type === "message_end" &&
        isRecord(frame.message) &&
        frame.message.role === "assistant" &&
        frame.message.stopReason === "stop",
      240_000,
    );
    record("the-turn-completed", "a completed assistant message", settled === undefined ? "timeout" : "stop", settled !== undefined);
    record(
      "the-model-answered-the-prompt",
      "AGENT-OK",
      assistantText(settled).replace(/\s+/g, " ").slice(0, 80),
      assistantText(settled).includes("AGENT-OK"),
    );

    const messages = await host.transport.request("get_messages", { sessionId: routingId });
    const raw = isRecord(messages.data) && Array.isArray(messages.data.messages) ? messages.data.messages : [];
    const user = raw.find((message) => isRecord(message) && message.role === "user");
    const blocks = isRecord(user) && Array.isArray(user.content) ? user.content : [];
    const userText = blocks
      .flatMap((block) => (isRecord(block) && typeof block.text === "string" ? [block.text] : []))
      .join("\n");
    record(
      "the-prompt-the-host-received-names-the-agent",
      "an instruction containing " + REQUESTED_AGENT,
      userText.replace(/\s+/g, " ").slice(0, 220),
      userText.includes(AGENT_REQUEST_MARKER) && userText.includes('"' + REQUESTED_AGENT + '"'),
    );
    record(
      "the-instruction-says-nothing-was-switched",
      "the text states the bridge switched no agent",
      userText.includes("switched no agent") ? "present" : "absent",
      userText.includes("switched no agent"),
    );

    const translated = context.tuiData.session.agentRequest(session.id);
    record(
      "the-session-records-the-translation",
      "requested, carried by a prompt prefix, host field unused",
      JSON.stringify(translated ?? null),
      translated?.requested[0] === REQUESTED_AGENT && translated.carrier === "prompt-prefix" && translated.hostField === false,
    );

    const subscriptions = await host.transport.request("subscribe_sessions", {
      sessions: "all",
      include_context: true,
      include_workers: false,
      mirror: "none",
      effects: false,
    });
    /* The host's own record of the patch is its reply to `set_session_context`; a subscription that echoes
       the context is reported beside it, not substituted for it. */
    record(
      "the-host-accepted-the-agent-request-session-context",
      "the host applied bridge_requested_agent",
      JSON.stringify({ recorded: translated?.hostContext ?? "absent", echoedBySubscription: JSON.stringify(subscriptions).includes("bridge_requested_agent") }),
      translated?.hostContext === "applied",
    );

    await pullHostState(host.transport, data, sessions);
    const assistant = data.hostMessagesFor(session.id).find((message) => message.type === "assistant");
    record(
      "no-row-claims-an-agent-ran",
      "the assistant row carries no agent attribution",
      JSON.stringify(assistant?.type === "assistant" ? assistant.agent : null),
      assistant?.type === "assistant" && (assistant.agent ?? "") === "",
    );
    record(
      "the-transcript-rows-came-from-the-prefixed-turn",
      "at least one user row and one assistant row",
      String(data.hostMessagesFor(session.id).length) + " row(s) after " + String(host.frames.list().length - startIndex) + " frame(s)",
      data.hostMessagesFor(session.id).some((message) => message.type === "user") &&
        data.hostMessagesFor(session.id).some((message) => message.type === "assistant"),
    );
  } catch (error) {
    record("case-completed", "no unexpected failure", String(error).slice(0, 240), false);
  }
  const detail = await host.close();
  return { checks: checks, cleanup: { ok: checks.every((check) => check.pass), detail: detail } };
}
