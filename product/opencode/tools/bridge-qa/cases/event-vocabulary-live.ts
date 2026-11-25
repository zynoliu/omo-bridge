/**
 * The client event stream against a stand-in host, with one check per capability row.
 *
 * Most event-cluster rows are proven today only by unit tests because no provider credential exists
 * for a live model turn. This case drives the shipping pipeline instead: the launcher's transport
 * (`openBridgeTransport`), the shipping `BridgeData` fan-out, and `createBridgeOpencodeApi(...)
 * .event.subscribe` -- the same objects `packages/cli/src/bridge-run.ts` builds -- with only the far
 * end scripted by `tools/bridge-qa/fixtures/standin-host.ts`.
 *
 * Every frame records which lane it came from, because the lanes are not equally real:
 *
 * - `host-wire`: a record the documented host actually writes (`docs/rpc.md` "Event Types", the
 *   dialog protocol in `packages/bridge-core/spec/host-frame-vocabulary.md`);
 * - `declared-vocabulary`: the `{ kind: ... }` shapes `packages/bridge-core/src/stream.ts` declares.
 *   A literal producer for these kinds was not found in `upstream/senpi`, `upstream/oh-my-openagent`
 *   or this product, while the host's documented live records are `message_update` /
 *   `tool_execution_*` -- so a pass here proves the projection of that vocabulary, not that a host
 *   ever sends it;
 * - `tui-answer`: the answer frame the TUI publishes for its own write
 *   (`packages/tui/src/context/bridge-data.ts:302`).
 *
 * Frames the projector cannot map are sent after the script and must be counted, not thrown: the
 * projector's own stderr summary is the counter that is read back.
 */
import fs from "node:fs";
import path from "node:path";

import type { CaseContext, CaseResult, Check } from "../run.ts";
import { startStandinHost } from "../fixtures/standin-host.ts";
import { openBridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import type { BridgeTransport } from "../../../packages/cli/src/bridge-run.ts";
import { BridgeData } from "../../../packages/bridge-core/src/data.ts";
import { createEventSurface } from "../../../packages/bridge-core/src/event-surface.ts";
import { createBridgeOpencodeApi } from "../../../packages/bridge-core/src/opencode-api.ts";
import { createSessionSurface } from "../../../packages/bridge-core/src/opencode-surface.ts";
import { createPartSurface } from "../../../packages/bridge-core/src/part-surface.ts";
import { encodeHostResponseFrame } from "../../../packages/bridge-core/src/host-frames.ts";
import { applyFormEvent, applyPermissionEvent, decodeHostEvent } from "../../../packages/bridge-core/src/host-event.ts";
import type { HostEventFrame } from "../../../packages/bridge-core/src/host-event.ts";
import { defaultIdleTimeout } from "../../../packages/client/src/solid/connection.ts";

const EVENT_TIMEOUT_MS = 10_000;
const QUIET_WINDOW_MS = 1_500;

const ROUTING_ID = "rpc-1";
const DURABLE_ID = "ses_standin_1";
const PERMISSION_ID = "ui-perm-1";
const QUESTION_ONE = "ui-question-1";
const QUESTION_TWO = "ui-question-2";
/** The question a client answers with `extension_ui_response` (the `session.form.reply` leg). */
const QUESTION_THREE = "ui-question-3";
/** The question a client dismisses with `extension_ui_response` (the `session.form.cancel` leg). */
const QUESTION_FOUR = "ui-question-4";
/** The question whose answer is checked against a declared required field. */
const QUESTION_REQUIRED = "ui-question-5";

/** Inbox ids the projector minted for queued text, read back by the later delivery and cancel steps. */
const observedInboxIds: Record<string, string> = {};

/**
 * The client's `SessionMessage.ID` brand. The projector mints every message id through `id-scheme.ts`,
 * because a host id (a hex entry id) is refused by the client's own decoder.
 */
const CLIENT_MESSAGE_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const isClientMessageID = (value: unknown): boolean => typeof value === "string" && CLIENT_MESSAGE_ID.test(value);

/** A projected event's data as a plain frame; undefined when the expected event never arrived, so a
    mismatched sequence is reported instead of throwing inside a check. */
function dataOf(event: Frame | undefined): Frame | undefined {
  return event === undefined ? undefined : (event.data as Frame | undefined);
}

type Frame = Record<string, unknown>;

/**
 * The client's own verdict on one event this stream projected. The bridge mints its own envelope id
 * (`bridge-N`), so that id is replaced with a client-shaped one; every other field is validated by the
 * same `decodeHostEvent` the TUI's store path runs.
 */
function clientEvent(event: Frame | undefined): { readonly ok: true; readonly event: HostEventFrame } | { readonly ok: false; readonly reason: string } {
  if (event === undefined) return { ok: false, reason: "no projected event to validate" };
  return decodeHostEvent({ ...event, id: "evt_" + String(event.id).replace(/^bridge-/, "") });
}
/**
 * Which lane a frame came from:
 *
 * - `host-wire`: a record the documented host writes (`docs/rpc.md`, `spec/host-frame-vocabulary.md`);
 * - `declared-vocabulary`: the `{ kind: ... }` shapes `packages/bridge-core/src/stream.ts` declares;
 * - `declared-field`: a single field the bridge's synthesis reads but the documented question wire type
 *   does not carry (`required`); a host that omits it produces optional fields, the way the question
 *   tool's own form does;
 * - `tui-answer`: the answer frame the TUI publishes for its own write
 *   (`packages/tui/src/context/bridge-data.ts`).
 */
type Lane = "host-wire" | "declared-vocabulary" | "declared-field" | "tui-answer";

type Step = {
  readonly id: string;
  readonly lane: Lane;
  readonly frame: Frame;
  readonly expected: readonly string[];
  /**
   * The projector must ignore this frame. It owns no check: nothing is awaited for it (a zero-length
   * take cannot fail), so its silence is proven by the first event of the following step instead, and
   * its contribution to the ignored-frame count by the projection summary.
   */
  readonly refused?: boolean;
  readonly verify?: (events: readonly Frame[]) => { readonly ok: boolean; readonly detail: string };
};

const script: readonly Step[] = [
  {
    id: "session-status",
    lane: "host-wire",
    frame: {
      type: "session_status",
      subscriptionId: "sub-1",
      seq: 1,
      sessionId: ROUTING_ID,
      durableSessionId: DURABLE_ID,
      kind: "interactive",
      cwd: "/work",
      status: "running",
    },
    expected: ["session.created", "session.status"],
    verify: (events) => ({
      ok:
        events[0]?.data !== undefined &&
        (events[0].data as Frame).sessionID === DURABLE_ID &&
        (events[1]?.data as Frame | undefined)?.status !== undefined &&
        ((events[1]?.data as Frame | undefined)?.status as Frame | undefined)?.type === "busy",
      detail: "created.sessionID=" + String((events[0]?.data as Frame | undefined)?.sessionID) + " status.busy",
    }),
  },
  {
    id: "prompt-started",
    lane: "declared-vocabulary",
    frame: { kind: "prompt_started", sessionId: ROUTING_ID, sequence: 0, messageId: "msg-1" },
    expected: ["session.execution.started"],
  },
  {
    id: "agent-start",
    lane: "host-wire",
    frame: { type: "agent_start", sessionId: ROUTING_ID },
    expected: ["session.execution.started"],
  },
  {
    id: "partial-thinking-text",
    lane: "declared-vocabulary",
    frame: {
      kind: "partial",
      sessionId: ROUTING_ID,
      sequence: 1,
      messageId: "msg-1",
      thinking: "Reading the file",
      text: "Hello",
    },
    expected: ["session.reasoning.started", "session.reasoning.delta", "session.text.started", "session.text.delta"],
    verify: (events) => ({
      ok:
        (events[1]?.data as Frame | undefined)?.delta === "Reading the file" &&
        (events[3]?.data as Frame | undefined)?.delta === "Hello",
      detail: "reasoning.delta=" + JSON.stringify((events[1]?.data as Frame | undefined)?.delta) + " text.delta=" + JSON.stringify((events[3]?.data as Frame | undefined)?.delta),
    }),
  },
  {
    id: "tool-call",
    lane: "declared-vocabulary",
    frame: {
      kind: "tool_call",
      sessionId: ROUTING_ID,
      sequence: 2,
      callId: "call-1",
      arguments: '{"path":"/work/a.txt"}',
    },
    expected: ["session.tool.called"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.id === "call-1" &&
        (dataOf(events[0])?.input as Frame | undefined)?.path === "/work/a.txt" && dataOf(events[0])?.executed === false,
      detail: "id=call-1 input.path=/work/a.txt executed=false",
    }),
  },
  {
    id: "tool-result-ok",
    lane: "declared-vocabulary",
    frame: { kind: "tool_result", sessionId: ROUTING_ID, sequence: 3, callId: "call-1", result: "file body" },
    expected: ["session.tool.success"],
    verify: (events) => ({
      ok: JSON.stringify((events[0]?.data as Frame | undefined)?.content) === JSON.stringify([{ type: "text", text: "file body" }]),
      detail: "content carries the result text",
    }),
  },
  {
    id: "tool-result-error",
    lane: "declared-vocabulary",
    frame: {
      kind: "tool_result",
      sessionId: ROUTING_ID,
      sequence: 4,
      callId: "call-2",
      isError: true,
      result: "Error: ENOENT /work/missing.txt",
    },
    expected: ["session.tool.failed"],
    verify: (events) => ({
      ok:
        ((events[0]?.data as Frame | undefined)?.error as Frame | undefined)?.message === "Error: ENOENT /work/missing.txt" &&
        events.every((event) => event.type !== "session.tool.success"),
      detail: "error.message carries the failed result; no session.tool.success is emitted",
    }),
  },
  {
    id: "partial-extend",
    lane: "declared-vocabulary",
    frame: { kind: "partial", sessionId: ROUTING_ID, sequence: 5, text: "Hello world" },
    expected: ["session.text.delta"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.delta === " world",
      detail: "delta=" + JSON.stringify((events[0]?.data as Frame | undefined)?.delta),
    }),
  },
  {
    id: "message-end",
    lane: "declared-vocabulary",
    frame: { kind: "message_end", sessionId: ROUTING_ID, sequence: 6, text: "Hello world" },
    expected: ["session.reasoning.ended", "session.text.ended"],
    verify: (events) => ({
      ok: (events[1]?.data as Frame | undefined)?.text === "Hello world",
      detail: "text.ended.text=" + JSON.stringify((events[1]?.data as Frame | undefined)?.text),
    }),
  },
  {
    id: "agent-idle",
    lane: "host-wire",
    frame: { type: "agent_idle", sessionId: ROUTING_ID },
    expected: ["session.idle"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.sessionID === DURABLE_ID,
      detail: "idle names the durable session",
    }),
  },
  {
    id: "retry-start",
    lane: "host-wire",
    frame: {
      type: "auto_retry_start",
      sessionId: ROUTING_ID,
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2000,
      errorMessage: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    },
    expected: ["session.retry.scheduled"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.attempt === 1,
      detail: "attempt=1",
    }),
  },
  {
    id: "retry-end-ok",
    lane: "host-wire",
    frame: { type: "auto_retry_end", sessionId: ROUTING_ID, success: true, attempt: 2 },
    expected: ["session.status"],
    verify: (events) => ({
      ok: ((events[0]?.data as Frame | undefined)?.status as Frame | undefined)?.type === "busy",
      detail: "clears through session.status busy; this fork has no session.retry.cleared event",
    }),
  },
  {
    id: "retry-end-failed",
    lane: "host-wire",
    frame: { type: "auto_retry_end", sessionId: ROUTING_ID, success: false, attempt: 3, finalError: "529 overloaded_error: Overloaded" },
    expected: ["session.execution.failed"],
    verify: (events) => ({
      ok: ((events[0]?.data as Frame | undefined)?.error as Frame | undefined)?.message === "529 overloaded_error: Overloaded",
      detail: "error.message carries finalError",
    }),
  },
  {
    id: "turn-start",
    lane: "host-wire",
    frame: { type: "turn_start", sessionId: ROUTING_ID, messageId: "msg-turn-1", startedAtMs: 1_000 },
    expected: ["session.step.started"],
    verify: (events) => ({
      ok:
        isClientMessageID((events[0]?.data as Frame | undefined)?.assistantMessageID) &&
        (dataOf(events[0])?.model as Frame | undefined)?.id === "bridge",
      detail:
        "assistantMessageID=" +
        String((events[0]?.data as Frame | undefined)?.assistantMessageID) +
        " model=bridge/bridge (a turn_start carries neither agent nor model, and the id is minted)",
    }),
  },
  {
    id: "message-update-thinking",
    lane: "host-wire",
    frame: {
      type: "message_update",
      sessionId: ROUTING_ID,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Reading the file" },
    },
    expected: ["session.reasoning.started", "session.reasoning.delta"],
    verify: (events) => ({
      ok: (events[1]?.data as Frame | undefined)?.delta === "Reading the file",
      detail: "reasoning.delta=" + JSON.stringify((events[1]?.data as Frame | undefined)?.delta),
    }),
  },
  {
    id: "message-update-text",
    lane: "host-wire",
    frame: {
      type: "message_update",
      sessionId: ROUTING_ID,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hello" },
    },
    expected: ["session.text.started", "session.text.delta"],
    verify: (events) => ({
      ok: (events[1]?.data as Frame | undefined)?.delta === "Hello",
      detail: "text.delta=" + JSON.stringify((events[1]?.data as Frame | undefined)?.delta),
    }),
  },
  {
    id: "message-update-append",
    lane: "host-wire",
    frame: {
      type: "message_update",
      sessionId: ROUTING_ID,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " world" },
    },
    expected: ["session.text.delta"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.delta === " world",
      detail: "text.delta=" + JSON.stringify((events[0]?.data as Frame | undefined)?.delta),
    }),
  },
  {
    id: "entry-appended",
    lane: "host-wire",
    frame: {
      type: "entry_appended",
      sessionId: ROUTING_ID,
      entry: {
        id: "entry-1",
        parentId: "entry-0",
        message: { id: "msg-turn-1", role: "assistant", content: [{ type: "text", text: "Hello world" }] },
      },
    },
    expected: ["session.message.content.updated", "session.text.ended"],
    verify: (events) => ({
      ok:
        isClientMessageID((events[0]?.data as Frame | undefined)?.messageID) &&
        (events[0]?.data as Frame | undefined)?.messageID !== "msg-turn-1" &&
        JSON.stringify((events[0]?.data as Frame | undefined)?.content) ===
          JSON.stringify([{ type: "text", text: "Hello world" }]) &&
        (events[1]?.data as Frame | undefined)?.text === "Hello world",
      detail:
        "content.updated names the client id minted for entry-1 (" +
        String((events[0]?.data as Frame | undefined)?.messageID) +
        ") rather than the host id, with the entry text; text.ended keeps the block boundary",
    }),
  },
  {
    id: "message-end-host",
    lane: "host-wire",
    frame: {
      type: "message_end",
      sessionId: ROUTING_ID,
      message: {
        id: "msg-turn-1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "Reading the file" },
          { type: "text", text: "Hello world" },
        ],
      },
    },
    expected: ["session.reasoning.ended"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.text === "Reading the file",
      detail: "reasoning.ended.text=" + JSON.stringify((events[0]?.data as Frame | undefined)?.text),
    }),
  },
  {
    id: "turn-end",
    lane: "host-wire",
    frame: {
      type: "turn_end",
      sessionId: ROUTING_ID,
      stopReason: "end_turn",
      cost: 0.01,
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 3 } },
    },
    expected: ["session.step.ended", "session.execution.succeeded"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.finish === "stop" &&
        (events[0]?.data as Frame | undefined)?.cost === 0.01 &&
        (dataOf(events[0])?.tokens as Frame | undefined)?.output === 5,
      detail: "finish=stop cost=0.01 tokens.output=5",
    }),
  },
  {
    id: "turn-end-succeeded",
    lane: "host-wire",
    frame: {
      type: "turn_end",
      sessionId: ROUTING_ID,
      message: { id: "msg-turn-2", role: "assistant", stopReason: "stop", content: [{ type: "text", text: "All done" }] },
      toolResults: [],
    },
    expected: ["session.step.ended", "session.execution.succeeded"],
    verify: (events) => ({
      ok:
        (events[1]?.data as Frame | undefined)?.sessionID === DURABLE_ID &&
        isClientMessageID((events[0]?.data as Frame | undefined)?.assistantMessageID),
      detail:
        "message.stopReason=stop projects session.execution.succeeded for " +
        String((events[1]?.data as Frame | undefined)?.sessionID) +
        " with client id " +
        String((events[0]?.data as Frame | undefined)?.assistantMessageID),
    }),
  },
  {
    id: "turn-end-interrupted",
    lane: "host-wire",
    frame: {
      type: "turn_end",
      sessionId: ROUTING_ID,
      message: { id: "msg-turn-3", role: "assistant", stopReason: "aborted", content: [] },
      toolResults: [],
    },
    expected: ["session.step.ended", "session.execution.interrupted"],
    verify: (events) => ({
      ok:
        (events[1]?.data as Frame | undefined)?.reason === "user" &&
        events.every((event) => event.type !== "session.execution.succeeded"),
      detail:
        "message.stopReason=aborted projects session.execution.interrupted with reason=" +
        String((events[1]?.data as Frame | undefined)?.reason),
    }),
  },
  {
    id: "tool-execution-start",
    lane: "host-wire",
    frame: {
      type: "tool_execution_start",
      sessionId: ROUTING_ID,
      toolCallId: "call-host-1",
      toolName: "bash",
      args: { command: "ls" },
    },
    expected: ["session.tool.input.started", "session.tool.input.ended", "session.tool.called"],
    verify: (events) => ({
      ok:
        (events[2]?.data as Frame | undefined)?.id === "call-host-1" &&
        (dataOf(events[2])?.input as Frame | undefined)?.command === "ls" && dataOf(events[2])?.executed === false,
      detail: "called.id=call-host-1 input.command=ls executed=false",
    }),
  },
  {
    id: "tool-execution-update",
    lane: "host-wire",
    frame: {
      type: "tool_execution_update",
      sessionId: ROUTING_ID,
      toolCallId: "call-host-1",
      partialResult: { content: [{ type: "text", text: "a.txt" }] },
    },
    expected: ["session.tool.progress"],
    verify: (events) => ({
      ok: ((events[0]?.data as Frame | undefined)?.metadata as Frame | undefined)?.partial === "a.txt",
      detail: "metadata.partial=a.txt",
    }),
  },
  {
    id: "tool-execution-end-ok",
    lane: "host-wire",
    frame: {
      type: "tool_execution_end",
      sessionId: ROUTING_ID,
      toolCallId: "call-host-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "a.txt" }] },
    },
    expected: ["session.tool.success"],
    verify: (events) => ({
      ok: JSON.stringify((events[0]?.data as Frame | undefined)?.content) === JSON.stringify([{ type: "text", text: "a.txt" }]),
      detail: "content carries the result text",
    }),
  },
  {
    id: "tool-execution-end-error",
    lane: "host-wire",
    frame: {
      type: "tool_execution_end",
      sessionId: ROUTING_ID,
      toolCallId: "call-host-2",
      toolName: "bash",
      isError: true,
      result: { content: [{ type: "text", text: "ENOENT /work/missing.txt" }] },
    },
    expected: ["session.tool.failed"],
    verify: (events) => ({
      ok:
        ((events[0]?.data as Frame | undefined)?.error as Frame | undefined)?.message === "ENOENT /work/missing.txt" &&
        events.every((event) => event.type !== "session.tool.success"),
      detail: "isError=true projects session.tool.failed with the host message and no session.tool.success",
    }),
  },
  {
    id: "compaction-start",
    lane: "host-wire",
    frame: { type: "compaction_start", sessionId: ROUTING_ID, reason: "threshold" },
    expected: ["session.compaction.started"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.reason === "auto",
      detail: "the host's threshold reason maps to the client's auto",
    }),
  },
  {
    id: "compaction-end",
    lane: "host-wire",
    frame: {
      type: "compaction_end",
      sessionId: ROUTING_ID,
      reason: "threshold",
      result: { summary: "Condensed twelve messages" },
      aborted: false,
      willRetry: false,
    },
    expected: ["session.compaction.delta", "session.compaction.ended"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.text === "Condensed twelve messages" &&
        (events[1]?.data as Frame | undefined)?.text === "Condensed twelve messages",
      detail: "the summary travels as the delta and the authoritative ended text",
    }),
  },
  {
    id: "queue-update",
    lane: "host-wire",
    frame: { type: "queue_update", sessionId: ROUTING_ID, steering: ["fix the test"], followUp: ["then commit"] },
    expected: ["session.inbox.enqueued", "session.inbox.enqueued"],
    verify: (events) => {
      const steer = events[0]?.data as Frame | undefined;
      const follow = events[1]?.data as Frame | undefined;
      observedInboxIds.steer = String(steer?.inboxID ?? "");
      observedInboxIds.follow = String(follow?.inboxID ?? "");
      return {
        ok:
          ((steer?.item as Frame | undefined)?.delivery === "steer") &&
          ((follow?.item as Frame | undefined)?.delivery === "queue") &&
          ((steer?.item as Frame | undefined)?.payload as Frame | undefined)?.text === "fix the test",
        detail: "two enqueued items: steer text and queue text",
      };
    },
  },
  {
    id: "queue-update-move",
    lane: "host-wire",
    frame: { type: "queue_update", sessionId: ROUTING_ID, steering: ["fix the test", "then commit"], followUp: [] },
    expected: ["session.inbox.delivery.changed"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.inboxID === observedInboxIds.follow &&
        (events[0]?.data as Frame | undefined)?.delivery === "steer",
      detail: "the same item id now delivers as steer instead of being enqueued twice",
    }),
  },
  {
    id: "queue-update-drained",
    lane: "host-wire",
    frame: { type: "queue_update", sessionId: ROUTING_ID, steering: ["fix the test"], followUp: [] },
    expected: ["session.inbox.delivered"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.inboxID === observedInboxIds.follow,
      detail: "the item that left the queue is delivered by its minted id",
    }),
  },
  {
    id: "pending-input-cancel",
    lane: "host-wire",
    frame: { type: "pending_input_update", sessionId: ROUTING_ID, changes: [{ type: "cancelled", text: "fix the test" }] },
    expected: ["session.inbox.cancelled"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.inboxID === observedInboxIds.steer,
      detail: "cancellation reaches the item the queue update enqueued",
    }),
  },
  {
    id: "extension-event",
    lane: "host-wire",
    frame: { type: "extension_event", name: "agent_custom", sessionId: ROUTING_ID, data: { note: "extension owned" } },
    expected: ["agent.custom.agent_custom", "rpc.extension.agent_custom"],
    verify: (events) => {
      const custom = events[0]?.data as Frame | undefined;
      const rpc = events[1]?.data as Frame | undefined;
      return {
        ok:
          custom?.name === "agent_custom" &&
          custom?.sessionId === ROUTING_ID &&
          custom?.sessionID === DURABLE_ID &&
          (custom?.payload as Frame | undefined)?.note === "extension owned" &&
          rpc?.sessionID === DURABLE_ID &&
          (rpc?.payload as Frame | undefined)?.note === "extension owned",
        detail:
          "agent.custom.agent_custom carries sessionId=" +
          ROUTING_ID +
          " and sessionID=" +
          DURABLE_ID +
          "; rpc.extension.agent_custom still carries the payload",
      };
    },
  },
  {
    id: "extension-event-unattached",
    lane: "host-wire",
    frame: { type: "extension_event", name: "agent_custom", data: { note: "no session field" } },
    expected: ["agent.custom.agent_custom", "rpc.extension.agent_custom"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.sessionId === undefined &&
        (events[0]?.data as Frame | undefined)?.sessionID === undefined &&
        (events[1]?.data as Frame | undefined)?.sessionID === undefined,
      detail: "no sessionId means unattached on both channels; the projector does not mint a session",
    }),
  },
  {
    id: "loaded-surfaces",
    lane: "host-wire",
    frame: { type: "loaded_surfaces_changed", sessionId: ROUTING_ID },
    expected: ["mcp.tools.changed", "mcp.status.changed"],
    verify: (events) => ({
      ok: events[0]?.type === "mcp.tools.changed" && events[1]?.type === "mcp.status.changed",
      detail: "mcp.tools.changed names the catalogue change; mcp.status.changed keeps the resync the substitute triggers",
    }),
  },
  {
    id: "permission-select",
    lane: "host-wire",
    frame: {
      type: "extension_ui_request",
      id: PERMISSION_ID,
      method: "select",
      title: "Permission required: read\n\nPath: /work/a.txt",
      options: ["Allow once", "Allow always", "Deny", "Deny with feedback"],
      toolCallId: "call-1",
      sessionId: ROUTING_ID,
    },
    expected: ["permission.asked"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.id === "per_" + PERMISSION_ID &&
        dataOf(events[0])?.action === "read" && dataOf(events[0])?.sessionID === DURABLE_ID,
      detail: "id=per_" + PERMISSION_ID + " action=read (the client's Permission.ID carries the per_ brand)",
    }),
  },
  {
    id: "permission-answer",
    lane: "tui-answer",
    frame: {},
    expected: ["permission.replied"],
    verify: (events) => ({
      ok: dataOf(events[0])?.reply === "once" && dataOf(events[0])?.requestID === "per_" + PERMISSION_ID,
      detail: "reply=once requestID=per_" + PERMISSION_ID,
    }),
  },
  {
    id: "question-1",
    lane: "host-wire",
    frame: {
      type: "extension_ui_request",
      id: QUESTION_ONE,
      method: "question",
      requestId: "req-q-1",
      toolCallId: "req-q-1",
      waitForAnswer: true,
      questions: [
        {
          id: "q-1",
          header: "Pick a file",
          question: "Which file should be read?",
          options: [{ label: "a.txt", description: "the first file" }, { label: "b.txt" }],
          multiSelect: false,
        },
      ],
      timeout: 60_000,
      askedAtMs: 1,
      deadlineAtMs: 60_001,
      remainingMs: 60_000,
      sessionId: ROUTING_ID,
    },
    expected: ["form.created"],
    verify: (events) => {
      const form = (events[0]?.data as Frame | undefined)?.form as Frame | undefined;
      const fields = form?.fields as readonly Frame[] | undefined;
      return {
        ok: form?.id === "frm_req-q-1" && fields?.[0]?.key === "q0" && form?.sessionID === DURABLE_ID,
        detail: "form.id=frm_req-q-1 field.key=q0",
      };
    },
  },
  {
    id: "question-1-resolved",
    lane: "host-wire",
    frame: {
      type: "question_resolved",
      id: "ui-question-1:resolved",
      requestId: "req-q-1",
      toolCallId: "req-q-1",
      outcome: "answered",
      answers: { "q-1": { selected: ["a.txt"] } },
      unanswered: [],
      sessionId: ROUTING_ID,
    },
    expected: ["form.replied"],
    verify: (events) => ({
      ok: JSON.stringify((events[0]?.data as Frame | undefined)?.answer) === JSON.stringify({ q0: ["a.txt"] }),
      detail: "answer=" + JSON.stringify((events[0]?.data as Frame | undefined)?.answer),
    }),
  },
  {
    id: "question-2",
    lane: "host-wire",
    frame: {
      type: "extension_ui_request",
      id: QUESTION_TWO,
      method: "question",
      requestId: "req-q-2",
      toolCallId: "req-q-2",
      waitForAnswer: true,
      questions: [
        {
          id: "q-1",
          header: "Second prompt",
          question: "Anything else?",
          options: [{ label: "no" }],
          multiSelect: false,
        },
      ],
      timeout: 60_000,
      askedAtMs: 2,
      deadlineAtMs: 60_002,
      remainingMs: 60_000,
      sessionId: ROUTING_ID,
    },
    expected: ["form.created"],
    verify: (events) => ({
      ok: ((events[0]?.data as Frame | undefined)?.form as Frame | undefined)?.id === "frm_req-q-2",
      detail: "form.id=frm_req-q-2",
    }),
  },
  {
    id: "question-2-timeout",
    lane: "host-wire",
    frame: {
      type: "question_resolved",
      id: "ui-question-2:resolved",
      requestId: "req-q-2",
      toolCallId: "req-q-2",
      outcome: "timed_out",
      answers: {},
      unanswered: ["q-1"],
      sessionId: ROUTING_ID,
    },
    expected: ["form.cancelled"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.id === "frm_req-q-2",
      detail: "cancelled the form it names",
    }),
  },
  {
    id: "question-3",
    lane: "host-wire",
    frame: {
      type: "extension_ui_request",
      id: QUESTION_THREE,
      method: "question",
      requestId: "req-q-3",
      toolCallId: "req-q-3",
      waitForAnswer: true,
      questions: [
        { id: "q-3", header: "Colour", question: "Pick a colour", options: [{ label: "red" }, { label: "blue" }], multiSelect: false },
      ],
      timeout: 60_000,
      askedAtMs: 3,
      deadlineAtMs: 60_003,
      remainingMs: 60_000,
      sessionId: ROUTING_ID,
    },
    expected: ["form.created"],
    verify: (events) => ({
      ok: ((events[0]?.data as Frame | undefined)?.form as Frame | undefined)?.id === "frm_req-q-3",
      detail: "form.id=frm_req-q-3 (the client's Form.ID carries the frm_ brand)",
    }),
  },
  {
    id: "form-answer-response",
    lane: "tui-answer",
    frame: {},
    expected: ["form.replied"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.id === "frm_req-q-3" &&
        JSON.stringify((events[0]?.data as Frame | undefined)?.answer) === JSON.stringify({ q0: ["red"] }),
      detail: "answer=" + JSON.stringify((events[0]?.data as Frame | undefined)?.answer),
    }),
  },
  {
    id: "question-4",
    lane: "host-wire",
    frame: {
      type: "extension_ui_request",
      id: QUESTION_FOUR,
      method: "question",
      requestId: "req-q-4",
      toolCallId: "req-q-4",
      waitForAnswer: true,
      questions: [{ id: "q-4", header: "Confirm", question: "Anything else?", options: [], multiSelect: false }],
      timeout: 60_000,
      askedAtMs: 4,
      deadlineAtMs: 60_004,
      remainingMs: 60_000,
      sessionId: ROUTING_ID,
    },
    expected: ["form.created"],
    verify: (events) => ({
      ok: ((events[0]?.data as Frame | undefined)?.form as Frame | undefined)?.id === "frm_req-q-4",
      detail: "form.id=frm_req-q-4",
    }),
  },
  {
    id: "form-cancel-response",
    lane: "tui-answer",
    frame: {},
    expected: ["form.cancelled"],
    verify: (events) => ({
      ok: (events[0]?.data as Frame | undefined)?.id === "frm_req-q-4",
      detail: "cancelled the form the dismissed dialog named",
    }),
  },
  {
    id: "question-required",
    lane: "declared-field",
    frame: {
      type: "extension_ui_request",
      id: QUESTION_REQUIRED,
      method: "question",
      requestId: "req-q-5",
      toolCallId: "req-q-5",
      waitForAnswer: true,
      questions: [
        {
          id: "q-5",
          header: "Version",
          question: "Which version?",
          options: [{ label: "1" }, { label: "2" }],
          multiSelect: false,
          required: true,
        },
      ],
      timeout: 60_000,
      askedAtMs: 5,
      deadlineAtMs: 60_005,
      remainingMs: 60_000,
      sessionId: ROUTING_ID,
    },
    expected: ["form.created"],
    verify: (events) => {
      const form = (events[0]?.data as Frame | undefined)?.form as Frame | undefined;
      const field = (form?.fields as readonly Frame[] | undefined)?.[0];
      return {
        ok: form?.id === "frm_req-q-5" && field?.required === true,
        detail: "form.id=frm_req-q-5 field.required=true (the schema's required constraint reaches the client)",
      };
    },
  },
  {
    id: "required-answer-missing",
    lane: "host-wire",
    frame: {
      type: "question_resolved",
      id: "ui-question-5:missing",
      requestId: "req-q-5",
      toolCallId: "req-q-5",
      outcome: "answered",
      answers: {},
      unanswered: ["q-5"],
      sessionId: ROUTING_ID,
    },
    expected: [],
    refused: true,
  },
  {
    id: "required-answer-missing-marker",
    lane: "host-wire",
    frame: { type: "agent_idle", sessionId: ROUTING_ID },
    expected: ["session.idle"],
    verify: (events) => ({
      ok: events[0]?.type === "session.idle",
      detail: "the refused answer emitted nothing: the next frame's session.idle is the first event on the stream",
    }),
  },
  {
    id: "required-answer-present",
    lane: "host-wire",
    frame: {
      type: "question_resolved",
      id: "ui-question-5:answered",
      requestId: "req-q-5",
      toolCallId: "req-q-5",
      outcome: "answered",
      answers: { "q-5": { selected: ["1"] } },
      unanswered: [],
      sessionId: ROUTING_ID,
    },
    expected: ["form.replied"],
    verify: (events) => ({
      ok:
        (events[0]?.data as Frame | undefined)?.id === "frm_req-q-5" &&
        JSON.stringify((events[0]?.data as Frame | undefined)?.answer) === JSON.stringify({ q0: ["1"] }),
      detail: "the refused answer settled nothing; the answer that supplies the required field still settles the form",
    }),
  },
];

/**
 * Records this run sends that must stay unprojected: one documented refusal, one unknown frame type, and
 * one assistant event kind outside this row set. Each must be counted and none may close the stream.
 */
const unprojected: readonly Frame[] = [
  { type: "session_parked", sessionId: ROUTING_ID, sessionPath: "/work/session.jsonl", reason: "idle" },
  { type: "host.record.never.shipped", sessionId: ROUTING_ID },
  { type: "message_update", sessionId: ROUTING_ID, assistantMessageEvent: { type: "toolcall_delta", delta: '{"pa' } },
];

const UNMAPPED_FRAMES_NOTE = `# Host frames this run projected, and the records that stay unprojected

Measured by \`tools/bridge-qa/cases/event-vocabulary-live.ts\` against
\`packages/bridge-core/src/host-projection.ts\` (worktree head) with the stand-in host. Every row below
is backed by a frame this run sent through the shipping transport, projector and event stream.

| capability row | host frame this run sent | client event produced | note |
| --- | --- | --- | --- |
| P-643 | \`turn_start\`, \`turn_end\` | \`session.step.started\`, \`session.step.ended\` | a turn frame carries neither agent nor model, so the step carries the declared bridge identity |
| P-644 | \`turn_end\` whose assistant message carries \`stopReason: "stop"\` / \`"aborted"\` | \`session.execution.succeeded\` / \`session.execution.interrupted\` (\`reason: "user"\`) | the wire turn record carries no outcome field, so the outcome is read from \`message.stopReason\`, the field the host's own boundary dispatch reads; an \`"error"\` stop emits neither here (\`auto_retry_end\` carries \`.failed\`) |
| P-733 | \`compaction_start\`, \`compaction_end\` | \`session.compaction.started\`, \`.delta\`, \`.ended\` | the host streams no compaction delta record, so the summary travels as one delta before the ended event; \`aborted: true\` ends as \`session.compaction.failed\` |
| P-641 | \`message_update\` \`thinking_delta\` | \`session.reasoning.started\`, \`.delta\`, \`.ended\` | deltas are appended to the block state, so the ended event carries the accumulated text |
| P-642 | \`message_update\` \`text_delta\` | \`session.text.started\`, \`.delta\`, \`.ended\` | the same assembler as the declared \`{kind:"partial"}\` vocabulary |
| P-647 | \`entry_appended\`, \`message_end\` | \`session.message.content.updated\`, \`session.text.ended\`, \`session.reasoning.ended\` | an assistant entry publishes the content update with the entry's own message id and its text/reasoning parts (a tool part has no reproducible client shape and stays on \`session.tool.*\`); the block events keep travelling beside it |
| P-684 | \`extension_event\` | \`agent.custom.<name>\`, \`rpc.extension.<name>\` | both carry the payload; \`agent.custom.<name>\` also carries the routing \`sessionId\` and the resolved \`sessionID\` when the bridge knows that session. Routed only by the documented \`sessionId\`: an unknown id leaves the event unattached and no session is minted |
| P-719 | \`loaded_surfaces_changed\` | \`mcp.tools.changed\`, \`mcp.status.changed\` | \`mcp.tools.changed\` names the catalogue change; \`mcp.status.changed\` keeps travelling because that is the member a client on the older substitute resyncs from |
| P-762 | \`queue_update\`, \`pending_input_update\` | \`session.inbox.enqueued\`, \`.delivered\`, \`.cancelled\`, \`.delivery.changed\` | a queued text carries no host id, so the bridge mints one and reuses it; a text that left the queue snapshot is reported delivered |
| P-656 | \`tool_execution_start\`, \`tool_execution_update\` | \`session.tool.input.started\`, \`.input.ended\`, \`session.tool.called\`, \`session.tool.progress\` | a running tool part is created by the input events; the partial output travels as progress metadata |
| P-657 | \`tool_execution_end\` | \`session.tool.success\` / \`session.tool.failed\` | chosen by \`isError\`; the declared \`{kind:"tool_result", isError:true}\` form now takes the same failed branch |
| P-603 | (no host record) | n/a | the stream's 15 s activity timer and the client's 45 s idle watchdog are exercised with fake timers in \`packages/bridge-core/test/host-projection-event-cluster.test.ts\` |
| P-664, P-666 | \`extension_ui_request\` \`select\` (\`Permission required: <action>\`), \`extension_ui_response\` \`value\` / \`cancelled\` | \`permission.asked\`, \`permission.replied\` | the host writes no \`permission.*\` event; the prompt is the dialog frame. The projected request id carries the client's \`per_\` brand (\`per_<host frame id>\`), a required constraint of \`Permission.ID\`, so the event validates against the client's own definition and the store lists it for its session |
| P-674, P-675, P-676 | \`extension_ui_request\` \`question\`, \`extension_ui_response\` \`answers\` / \`cancelled\`, \`question_resolved\` | \`form.created\`, \`form.replied\`, \`form.cancelled\` | the host's \`question_resolved\` broadcast and the client's own answer frame both settle the form; the projected id carries the client's \`frm_\` brand. A reply that leaves a question the host declared \`required\` empty is refused and the form stays pending |
| P-677 | \`extension_ui_request\` \`question\` with a \`required\` question, then an answer that omits it | no event (refused) | \`form.created\` publishes the field as \`required\`; the omission is refused in the client schema's shape (\`{"_tag":"FormInvalidAnswerError","message":"Missing required form field: q0"}\`), which the projector summary reports. The documented question wire type carries no \`required\` flag, so a host that sends none produces optional fields, the way the question tool's own form does |

## Residual unprojected records

- \`session_parked\`: a parked handle is not a deletion (unchanged, by design).
- \`host.record.never.shipped\`: an unknown type; it is counted as ignored and the stream stays open.
- \`message_update\` with \`assistantMessageEvent.type: toolcall_delta\`: tool input deltas are outside this
  row set and are counted as ignored rather than dropped silently.
- the required-field answer that omits its question (P-677): refused in the client's
  \`FormInvalidAnswerError\` shape and counted as ignored, so no settlement the client would reject travels.

The capability ledger (\`packages/bridge-core/spec/capabilities.json\`) is not updated by this case; the
row statuses are owned by the matrix task.
`;

type StepOutcome = {
  readonly events: readonly Frame[];
  readonly end?: "timeout" | "done";
};

type NextResult = { readonly kind: "event"; readonly value: Frame } | { readonly kind: "done" } | { readonly kind: "timeout" };

/** One iterator step bounded by a deadline; the deadline only caps the wait, it never paces it. */
async function nextWithin(iterator: AsyncIterator<Frame>, ms: number): Promise<NextResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    const raced = await Promise.race([iterator.next(), deadline]);
    if (raced === "timeout") return { kind: "timeout" };
    if (raced.done === true) return { kind: "done" };
    return { kind: "event", value: raced.value as Frame };
  } finally {
    clearTimeout(timer);
  }
}

/** Exactly `count` events, each awaited; fewer means the projection did not produce them. */
async function take(iterator: AsyncIterator<Frame>, count: number): Promise<StepOutcome> {
  const events: Frame[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await nextWithin(iterator, EVENT_TIMEOUT_MS);
    if (next.kind === "timeout") return { events: events, end: "timeout" };
    if (next.kind === "done") return { events: events, end: "done" };
    events.push(next.value);
  }
  return { events: events };
}

const typesOf = (events: readonly Frame[]) => events.map((event) => String(event.type));

export async function run(context: CaseContext): Promise<CaseResult> {
  const checks: Check[] = [];
  const cleanupDetail: string[] = [];
  const artifacts: string[] = [];
  const record = (name: string, expected: string, observed: string, pass: boolean) => {
    checks.push({ name: name, expected: expected, observed: observed, pass: pass });
  };

  const answers = encodeHostResponseFrame({
    id: PERMISSION_ID + ":response",
    uiRequestId: PERMISSION_ID,
    answer: { kind: "value", value: "Allow once" },
  });

  /* The two frames a client writes to settle a question: the answer set (session.form.reply) and the
     dismissal (session.form.cancel). Both are built by the bridge's own encoder. */
  const publishedAnswers: Readonly<Record<string, ReturnType<typeof encodeHostResponseFrame>>> = {
    "permission-answer": answers,
    "form-answer-response": encodeHostResponseFrame({
      id: QUESTION_THREE + ":response",
      uiRequestId: QUESTION_THREE,
      answer: { kind: "answers", answers: { "q-3": { selected: ["red"] } } },
    }),
    "form-cancel-response": encodeHostResponseFrame({
      id: QUESTION_FOUR + ":response",
      uiRequestId: QUESTION_FOUR,
      answer: { kind: "cancelled" },
    }),
  };

  const host = startStandinHost({
    directory: context.out,
    socketPath: path.join(context.out, "host.sock"),
    responses: {
      open_session: { sessionId: ROUTING_ID, durableSessionId: DURABLE_ID, cwd: "/work", kind: "interactive" },
      prompt: { disposition: "started" },
      subscribe_sessions: { subscriptionId: "sub-1", snapshot: [] },
    },
  });

  const data = new BridgeData();
  const transports: BridgeTransport[] = [];
  const controller = new AbortController();
  const outcomes = new Map<string, StepOutcome>();
  const published: Frame[] = [];
  let iterator: AsyncIterator<Frame> | undefined;
  let connectedType = "none";
  let projectionLog: string[] = [];
  let quietHeld = false;
  let subscriberCountAfterAbort = -1;
  let eventIds: string[] = [];
  let failure: string | undefined;
  /* Interval delays observed while the stream installed its keepalive timer. */
  const intervalDelays: number[] = [];

  const originalStderrWrite = process.stderr.write;
  const captureStderr = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (text.includes("bridge-log: event projection:")) {
      projectionLog.push(text.trim());
      return true;
    }
    return (originalStderrWrite as (...args: unknown[]) => boolean).call(process.stderr, chunk, ...rest);
  }) as typeof process.stderr.write;

  try {
    const transport = await openBridgeTransport(
      {
        socket: host.socketPath,
        keyRecord: host.recordPath,
        cwd: "/work",
        mini: false,
        handshakeTimeoutMs: 10_000,
      },
      (frame) => data.publishEvent(frame),
    );
    transports.push(transport);

    const handshake = host.handshake;
    record(
      "handshake-authenticated",
      "info + authenticate received, both proofs verified, transport reports authenticated",
      "info=" +
        String(handshake.infoReceived) +
        " serverProof=" +
        String(handshake.serverProofSent) +
        " authenticate=" +
        String(handshake.authenticateReceived) +
        " clientProof=" +
        String(handshake.clientProofVerified) +
        " report=" +
        transport.report.state,
      handshake.infoReceived && handshake.serverProofSent && handshake.authenticateReceived && handshake.clientProofVerified && transport.report.state === "authenticated",
    );

    const opened = await transport.request("open_session", { cwd: "/work", durableSessionId: DURABLE_ID });
    record(
      "host-accepts-open-session",
      "the stand-in host answers open_session with success true",
      "success=" + String(opened.success) + " data=" + JSON.stringify(opened.data ?? {}).slice(0, 120),
      opened.success === true,
    );
    const prompted = await transport.request("prompt", { sessionId: ROUTING_ID, message: "hello" });
    record(
      "host-accepts-prompt",
      "the stand-in host answers prompt with success true",
      "success=" + String(prompted.success) + " commands=" + JSON.stringify(host.requests()),
      prompted.success === true && host.requests().includes("prompt"),
    );

    /* The stream installs its activity timer when the generator starts, so the capture wraps creation
       and the first read; the timer itself keeps running on the real clock. */
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((callback: Parameters<typeof setInterval>[0], ms?: number, ...rest: unknown[]) => {
      if (typeof ms === "number") intervalDelays.push(ms);
      return (realSetInterval as (...args: unknown[]) => ReturnType<typeof setInterval>)(callback, ms, ...rest);
    }) as typeof setInterval;
    let first: NextResult = { kind: "done" };
    try {
      const api = createBridgeOpencodeApi({
        data: data,
        defaultLocation: { directory: "/work" },
        events: createEventSurface(),
        sessions: createSessionSurface(data),
        parts: createPartSurface(data),
      });
      iterator = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]() as AsyncIterator<Frame>;

      first = await nextWithin(iterator, EVENT_TIMEOUT_MS);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
    connectedType = first.kind === "event" ? String(first.value.type) : first.kind;
    record(
      "P-603-server-connected-first",
      "the first event on the stream is server.connected",
      connectedType,
      connectedType === "server.connected",
    );

    process.stderr.write = captureStderr;

    for (const step of script) {
      const publishedFrame = publishedAnswers[step.id];
      const frame = publishedFrame === undefined ? step.frame : publishedFrame.ok ? publishedFrame.frame : undefined;
      if (frame === undefined) {
        outcomes.set(step.id, { events: [], end: "done" });
        continue;
      }
      const delivered = step.lane === "tui-answer" ? (data.publishEvent(frame), published.push(frame as Frame), true) : host.send(frame);
      if (!delivered) {
        outcomes.set(step.id, { events: [], end: "done" });
        continue;
      }
      const outcome = await take(iterator, step.expected.length);
      outcomes.set(step.id, outcome);
      for (const event of outcome.events) eventIds.push(String(event.id));
    }

    for (const frame of unprojected) host.send(frame);
    const quiet = await nextWithin(iterator, QUIET_WINDOW_MS);
    quietHeld = quiet.kind === "timeout";

    controller.abort();
    const ended = await nextWithin(iterator, EVENT_TIMEOUT_MS);
    subscriberCountAfterAbort = data.eventSubscriberCount();
    cleanupDetail.push("stream ended after abort: " + (ended.kind === "done" ? "done" : ended.kind));
  } catch (error) {
    failure = String(error).slice(0, 300);
  } finally {
    process.stderr.write = originalStderrWrite;
    for (const transport of transports) {
      try {
        transport.close();
      } catch {
        cleanupDetail.push("a transport did not close cleanly");
      }
    }
    const stopped = await host.stop();
    cleanupDetail.push(...stopped.detail);
  }

  const names: Readonly<Record<string, string>> = {
    "session-status": "P-619-session-created",
    "prompt-started": "P-644-execution-started",
    "agent-start": "P-644-execution-started-host-wire",
    "partial-thinking-text": "P-641-reasoning-started-delta",
    "tool-call": "P-656-tool-running",
    "tool-result-ok": "P-657-tool-success",
    "tool-result-error": "P-657-tool-error-declared-vocabulary",
    "partial-extend": "P-642-text-delta-append",
    "message-end": "P-644-text-ended",
    "agent-idle": "P-644-agent-idle",
    "retry-start": "P-645-retry-scheduled",
    "retry-end-ok": "P-645-retry-cleared",
    "retry-end-failed": "P-645-retry-failed",
    "permission-select": "P-666-permission-asked",
    "permission-answer": "P-666-permission-replied",
    "question-1": "P-676-form-created",
    "question-1-resolved": "P-676-form-replied",
    "question-2": "P-674-form-created-second",
    "question-2-timeout": "P-676-form-cancelled",
    "question-3": "P-675-form-created-before-reply",
    "form-answer-response": "P-675-form-replied-from-response",
    "question-4": "P-675-form-created-before-cancel",
    "form-cancel-response": "P-675-form-cancelled-from-response",
    "question-required": "P-677-required-field-published",
    "required-answer-missing-marker": "P-677-required-field-refused",
    "required-answer-present": "P-677-required-field-settled",
    "turn-start": "P-643-step-started",
    "turn-end": "P-643-step-ended",
    "turn-end-succeeded": "P-644-execution-succeeded",
    "turn-end-interrupted": "P-644-execution-interrupted",
    "message-update-thinking": "P-641-reasoning-delta-host-wire",
    "message-update-text": "P-642-text-started-delta-host-wire",
    "message-update-append": "P-642-text-delta-append-host-wire",
    "entry-appended": "P-647-content-update-from-entry",
    "message-end-host": "P-647-reasoning-ended-from-host-message-end",
    "tool-execution-start": "P-656-tool-running-host-wire",
    "tool-execution-update": "P-656-tool-progress",
    "tool-execution-end-ok": "P-657-tool-success-host-wire",
    "tool-execution-end-error": "P-657-tool-error",
    "compaction-start": "P-733-compaction-started",
    "compaction-end": "P-733-compaction-delta-ended",
    "queue-update": "P-762-inbox-enqueued",
    "queue-update-move": "P-762-inbox-delivery-changed",
    "queue-update-drained": "P-762-inbox-delivered",
    "pending-input-cancel": "P-762-inbox-cancelled",
    "extension-event": "P-684-extension-event-routed",
    "extension-event-unattached": "P-684-extension-event-unattached",
    "loaded-surfaces": "P-719-mcp-catalogue-refresh",
  };

  for (const step of script) {
    /* A refused frame is a delivery fixture, not a check of its own: `take(0)` returns before any event
       could arrive, so the assertion would always be green. The step after it asserts its silence. */
    if (step.refused === true) continue;
    const outcome = outcomes.get(step.id) ?? { events: [], end: "done" as const };
    const observedTypes = typesOf(outcome.events);
    const matches = observedTypes.join(" -> ") === step.expected.join(" -> ");
    const verification = step.verify === undefined ? { ok: true, detail: "" } : step.verify(outcome.events);
    const short = observedTypes.length < step.expected.length;
    record(
      names[step.id] ?? step.id,
      step.expected.join(" -> ") + " (lane " + step.lane + ")",
      observedTypes.length === 0
        ? "no event" + (outcome.end === undefined ? "" : " (" + outcome.end + ")")
        : observedTypes.join(" -> ") + " [" + String(outcome.events.length) + "]" + (short && outcome.end !== undefined ? " (" + outcome.end + ")" : "") + (verification.detail.length > 0 ? " | " + verification.detail : ""),
      matches && verification.ok,
    );
  }

  record(
    "P-658-unknown-frames-ignored",
    "each of the " + String(unprojected.length) + " records this run sends stays unprojected and the stream stays open",
    quietHeld
      ? "no event within " + String(QUIET_WINDOW_MS) + "ms after " + unprojected.map((frame) => String(frame.type)).join(", ")
      : "an event arrived for a frame the projector should ignore",
    quietHeld,
  );

  /*
   * The list surfaces, driven the way the TUI drives them: the projected event is validated by the
   * client's own definitions and handed to the same store projection `onHostEvent` runs, then read
   * back through the list the TUI's data layer serves.
   */
  const storeApply = (
    decoded: ReturnType<typeof clientEvent>,
    kind: "permission" | "form",
  ): boolean =>
    decoded.ok ? (kind === "permission" ? applyPermissionEvent(data, decoded.event) : applyFormEvent(data, decoded.event)) : false;
  const heldPermissions = () => data.permissionsFor(DURABLE_ID).map((request) => request.id);
  const heldForms = () => data.formsFor(DURABLE_ID).map((form) => form.id);

  const askedStore = clientEvent(outcomes.get("permission-select")?.events[0]);
  const permissionListed = storeApply(askedStore, "permission") && heldPermissions().includes("per_" + PERMISSION_ID);
  record(
    "P-664-permission-list-store",
    "permission.list reads the projected permission.asked back for its session",
    askedStore.ok ? "held " + JSON.stringify(heldPermissions()) : "the client schema refused the projected event: " + askedStore.reason,
    permissionListed,
  );

  const createdOne = clientEvent(outcomes.get("question-1")?.events[0]);
  const firstFormListed = storeApply(createdOne, "form") && heldForms().includes("frm_req-q-1");
  record(
    "P-674-form-list-store",
    "form.list reads the projected form.created back for its session",
    createdOne.ok ? "held " + JSON.stringify(heldForms()) : "the client schema refused the projected event: " + createdOne.reason,
    firstFormListed,
  );

  /* the reply and the dismissal each leave the list, through the settlement events the stream sent */
  storeApply(clientEvent(outcomes.get("question-3")?.events[0]), "form");
  const replyRemoved =
    storeApply(clientEvent(outcomes.get("form-answer-response")?.events[0]), "form") && !heldForms().includes("frm_req-q-3");
  storeApply(clientEvent(outcomes.get("question-4")?.events[0]), "form");
  const cancelRemoved =
    storeApply(clientEvent(outcomes.get("form-cancel-response")?.events[0]), "form") && !heldForms().includes("frm_req-q-4");
  record(
    "P-675-form-reply-cancel-store",
    "the reply and the dismissal each settle their form in the store",
    "reply removed frm_req-q-3: " + String(replyRemoved) + ", dismissal removed frm_req-q-4: " + String(cancelRemoved) + ", held " + JSON.stringify(heldForms()),
    replyRemoved && cancelRemoved,
  );

  const summary = projectionLog.join(" ");
  const projectedExpected = script.reduce((total, step) => total + step.expected.length, 0);
  /* every frame this run sends that must project nothing: the documented refusals plus the
     required-field answer the client's own rule rejects */
  const refusedFrames = script.filter((step) => step.refused === true).length;
  record(
    "P-603-projection-summary",
    "the projector reports " +
      String(projectedExpected) +
      " projected events and " +
      String(unprojected.length + refusedFrames) +
      " ignored frames when the subscriber closes",
    summary.length > 0 ? summary.slice(0, 300) : "no bridge-log projection summary was written",
    summary.includes(String(projectedExpected) + " events projected") &&
      summary.includes(String(unprojected.length + refusedFrames) + " frames ignored"),
  );

  record(
    "P-677-required-field-error-shape",
    'the refused answer is reported in the client schema\'s FormInvalidAnswerError shape, naming the field',
    summary.includes('"_tag":"FormInvalidAnswerError"') && summary.includes("Missing required form field: q0")
      ? "the projector reported FormInvalidAnswerError / Missing required form field: q0"
      : summary.slice(0, 300),
    summary.includes('"_tag":"FormInvalidAnswerError"') && summary.includes("Missing required form field: q0"),
  );

  /* One check per capability row this wave closed: each new event is decoded by the client's own
     host-event decoder, so a type outside the client union or a payload the client refuses fails here.
     The projector mints message ids through `id-scheme.ts`, so the content update the host addressed by
     entry id (`entry-1`) is published under a client `msg_` id the schema accepts. */
  const contentRaw = outcomes.get("entry-appended")?.events[0];
  const contentData = contentRaw === undefined ? undefined : (contentRaw.data as Frame | undefined);
  const contentDecoded =
    contentRaw === undefined
      ? { ok: false as const, reason: "no projected event to validate" }
      : decodeHostEvent({ ...contentRaw, id: "evt_" + String(contentRaw.id).replace(/^bridge-/, "") });
  record(
    "P-647-content-updated-client-contract",
    "the projected session.message.content.updated decodes against the client's own definition and names its message by a client id",
    contentData === undefined
      ? "no projected event to validate"
      : "messageID=" +
        String(contentData.messageID) +
        " content=" +
        JSON.stringify(contentData.content) +
        (contentDecoded.ok ? " decodes under the client's msg_ brand" : " refused: " + contentDecoded.reason),
    isClientMessageID(contentData?.messageID) && contentData?.messageID !== "msg-turn-1" && contentDecoded.ok,
  );

  const customProjected = clientEvent(outcomes.get("extension-event")?.events[0]);
  const customData = customProjected.ok ? (customProjected.event.data as unknown as Frame) : undefined;
  record(
    "P-684-agent-custom-client-contract",
    "the projected agent.custom.<name> decodes against the client's own definition with the routing session id and the payload",
    customProjected.ok
      ? "type=" + String(customProjected.event.type) + " sessionId=" + String(customData?.sessionId) + " payload=" + JSON.stringify(customData?.payload)
      : "the client schema refused the projected event: " + customProjected.reason,
    customProjected.ok &&
      customProjected.event.type === "agent.custom.agent_custom" &&
      customData?.sessionId === ROUTING_ID &&
      (customData?.payload as Frame | undefined)?.note === "extension owned",
  );

  const toolsProjected = clientEvent(outcomes.get("loaded-surfaces")?.events[0]);
  record(
    "P-719-mcp-tools-changed-client-contract",
    "the projected mcp.tools.changed decodes against the client's own definition for the catalogue refresh",
    toolsProjected.ok
      ? "type=" + String(toolsProjected.event.type) + " server=" + JSON.stringify((toolsProjected.event.data as unknown as Frame).server)
      : "the client schema refused the projected event: " + toolsProjected.reason,
    toolsProjected.ok && toolsProjected.event.type === "mcp.tools.changed",
  );

  record(
    "P-603-keepalive-and-idle-watchdog",
    "the stream installs its 15 s activity timer and the shipped client idle timeout is the 45 s watchdog (three ticks per window)",
    "intervals=" + JSON.stringify([...new Set(intervalDelays)]) + " defaultIdleTimeout=" + String(defaultIdleTimeout),
    intervalDelays.includes(15_000) && defaultIdleTimeout === 45_000,
  );

  const ordinals = eventIds.map((id) => Number(id.replace("bridge-", "")));
  const ascending = ordinals.every(
    (ordinal, index) => Number.isFinite(ordinal) && (index === 0 || ordinal > (ordinals[index - 1] ?? Number.NaN)),
  );
  record(
    "P-603-event-ids-ascend",
    "strictly ascending ids across every projected event",
    String(ordinals.length) + " ids: " + eventIds.slice(0, 3).join(", ") + " ... " + eventIds.slice(-1).join(""),
    ordinals.length >= 2 && ascending,
  );

  record(
    "P-603-subscriber-released",
    "no event subscriber survives the closed stream",
    String(subscriberCountAfterAbort) + " subscriber(s)",
    subscriberCountAfterAbort === 0,
  );

  const evidence = {
    script: script.map((step) => ({ id: step.id, lane: step.lane, frame: step.frame, expected: step.expected })),
    unprojected: unprojected,
    published: published,
    stderr: projectionLog,
  };
  try {
    fs.writeFileSync(path.join(context.out, "frames-script.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
    artifacts.push("frames-script.json");
    const projected = [...outcomes.entries()].flatMap((entry) => entry[1].events);
    fs.writeFileSync(path.join(context.out, "events-projected.json"), JSON.stringify(projected, null, 2) + "\n", {
      mode: 0o600,
    });
    artifacts.push("events-projected.json");
    fs.writeFileSync(path.join(context.out, "projection-stderr.txt"), (summary.length > 0 ? summary : "(none)") + "\n", {
      mode: 0o600,
    });
    artifacts.push("projection-stderr.txt");
    fs.writeFileSync(path.join(context.out, "unmapped-frames.md"), UNMAPPED_FRAMES_NOTE, { mode: 0o600 });
    artifacts.push("unmapped-frames.md");  } catch (error) {
    cleanupDetail.push("evidence write failed: " + String(error).slice(0, 120));
  }
  record(
    "evidence-complete",
    "script, projected events, projector summary and the unmapped-frame table are under the evidence directory",
    artifacts.join(", "),
    artifacts.length === 4,
  );

  if (failure !== undefined) record("case-completed", "no unexpected failure", failure, false);

  const cleanupOk =
    cleanupDetail.every(
      (entry) =>
        !entry.includes("still present") &&
        !entry.includes("still accepts") &&
        !entry.includes("did not close") &&
        !entry.includes("could not remove"),
    ) && artifacts.length === 4;
  return { checks: checks, cleanup: { ok: cleanupOk, detail: cleanupDetail }, artifacts: artifacts };
}
