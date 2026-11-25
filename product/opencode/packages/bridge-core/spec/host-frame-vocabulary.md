# Host frame vocabulary

What the OmO/Senpi host actually writes on the RPC socket for permission prompts, permission
answers, structured questions and their outcomes, with the source lines that establish each claim.

Read scope: `upstream/senpi` (the Senpi host) and this worktree's own `packages/schema`. The dialog
sections (a)-(d) are a static reading: no real host was started and no socket carried their frames.
The **Event-cluster frames** section is backed by a run of the stand-in host
(`tools/bridge-qa/cases/event-vocabulary-live.ts`, "the client event stream against a stand-in host"),
which drives the shipping launcher transport, projector and event stream with scripted records; it
proves the projection, not that a real host writes those records. The dialog rows in that section
(P-664, P-666, P-674 to P-677) use the same run: the frames are scripted from the shapes (a)-(d)
describe, and the run proves what the projector publishes for them. Where a runtime behaviour cannot be
read off the source, it is listed under **Unknowns** instead of being assumed.

The decoders that implement the verified subset live in `packages/bridge-core/src/host-frames.ts`.

## Summary

| Event | Frame the host writes | Direction |
| --- | --- | --- |
| (a) Permission prompt | `extension_ui_request`, `method: "select"`, title `Permission required: <permission>`, options `["Allow once", "Allow always", (wider label,) "Deny", "Deny with feedback"]`, `toolCallId` (and `parentToolCallId` when nested) | host to client |
| (b) Permission answer | `extension_ui_response` with `value` = the chosen option label, or `cancelled: true` | client to host |
| (c) Structured question prompt | `extension_ui_request`, `method: "question"`, with `requestId`, `toolCallId`, `waitForAnswer`, `questions[]`, `timeout`, `askedAtMs`, `deadlineAtMs`, `remainingMs`, optional `raisedBy` / `remoteOrigin` | host to client |
| (d) Question answer | `extension_ui_response` with `answers` (and optional `comment`) | client to host |
| (d) Question cancellation | `extension_ui_response` with `cancelled: true` | client to host |
| (d) Question outcome broadcast | `question_resolved` (after the answer settles, or on timeout/cancel) | host to client(s) |

The OpenCode-schema events `permission.asked`, `permission.replied`, `form.created`, `form.replied`
and `form.cancelled` are **never emitted by this host**. They exist only in the OpenCode fork's own
event manifest that the bridge validates today, and the host's permission lifecycle travels on the
extension-UI dialog sub-protocol instead.

## (a) Permission prompt

The permission-system extension asks through the extension UI context, not through an event:

- `upstream/senpi/packages/coding-agent/src/core/extensions/builtin/permission-system/index.ts:407-414`
  -- when `ctx.hasUI` is true it awaits `showPermissionPrompt(ctx, request, signal)` and feeds the
  result to `activeService.reply(reply)`; with no UI it takes the denial path instead.
- `upstream/senpi/packages/coding-agent/src/core/extensions/builtin/permission-system/prompt.ts:9-26`
  -- the title is `Permission required: ${request.permission}`, the options array is built at line 15,
  and the prompt is `ctx.ui.select(displayTitle, options, call)` at line 26.
- `upstream/senpi/packages/coding-agent/src/core/extensions/builtin/permission-system/prompt.ts:20-25`
  -- the dialog options carry `toolCallId: request.tool.callID` and `parentToolCallId` when the call was
  issued by another tool; these are the only ids the prompt carries besides its own frame `id`.

In RPC mode `ctx.ui.select` is translated into one `extension_ui_request` record:

- `upstream/senpi/packages/coding-agent/src/modes/rpc/connection-handler.ts:714-727` -- the RPC
  `ExtensionUIContext`; `select` calls `createDialogPromise` with `{ method: "select", title, options,
  timeout, ...dialogCall(opts) }`.
- `upstream/senpi/packages/coding-agent/src/modes/rpc/connection-handler.ts:645-690` -- the dialog
  promise allocates `id = crypto.randomUUID()` (line 653), registers it in
  `pendingExtensionRequests` (line 678), and writes the frame at line 687:
  `output({ type: "extension_ui_request", id, ...raised })`.
- `upstream/senpi/packages/coding-agent/src/modes/rpc/rpc-question-types.ts:46-60` -- the wire type for
  `method: "select"`: `id`, optional `remoteOrigin`, `grantSelect`, `title`, `options: string[]`,
  optional `timeout`, `toolCallId`, `parentToolCallId`.
- `upstream/senpi/packages/coding-agent/src/core/runtime/ui-broker.ts:81` and `:95` -- a runtime with no
  session uses the same `extension_ui_request` frames through `createRpcUiPresenter`, so the frame
  vocabulary is not specific to a session-bearing connection.

The shipped protocol reference states the same shape, including a worked permission example:
`upstream/senpi/packages/coding-agent/docs/rpc.md:7455-7483` (`#### select`, the example at
7474-7483 carries `"title": "Permission required: read\n\nPath: ..."` and `"toolCallId": "call-a"`).

## (b) Permission answer

The answer is not a permission-specific frame. It is the generic dialog response:

- `upstream/senpi/packages/coding-agent/docs/rpc.md:7470` -- "Expected response: `extension_ui_response`
  with `value` (the selected option string) or `cancelled: true`."
- `upstream/senpi/packages/coding-agent/docs/rpc.md:7765-7768` -- the value-response example.
- `upstream/senpi/packages/coding-agent/src/modes/rpc/rpc-question-types.ts:152-156` -- the response
  union: `{ value: string } | { confirmed: boolean } | { cancelled: true } | { answers, comment? }`.
- `upstream/senpi/packages/coding-agent/src/core/extensions/builtin/permission-system/prompt.ts:28-50`
  -- the selected label is mapped back to a `ReplyInput` (`"Allow once"` -> `once`, `"Allow always"` ->
  `always`, `"Deny"` -> `reject`; `"Deny with feedback"` opens a second `input` dialog first; a missing
  or `cancelled` answer becomes `reject`).

The permission decision is applied in-process (`index.ts:409-412` -> `service.reply(...)`), so no
`permission.replied` frame is written. The permission service's own reply event is an in-process bus
event only (see the next section).

## (c) Structured question prompt

A multi-question prompt is still an `extension_ui_request`, with `method: "question"`:

- `upstream/senpi/packages/coding-agent/src/modes/rpc/rpc-question-types.ts:27-41` -- the wire type:
  `id`, `method: "question"`, `requestId`, `toolCallId`, `waitForAnswer`, `questions[]` (each with
  `id`, `header`, `question`, `options[{label, description?}]`, `multiSelect`), optional `raisedBy`,
  optional `remoteOrigin`, `timeout`, `askedAtMs`, `deadlineAtMs`, `remainingMs`.
- `upstream/senpi/packages/coding-agent/src/modes/rpc/connection-question-bridge.ts:45-63` -- the
  frame is constructed with `id = crypto.randomUUID()`, `requestId: request.requestId` and
  `toolCallId: request.requestId`, then written at line 174.
- `upstream/senpi/packages/coding-agent/src/modes/rpc/connection-handler.ts:714-717` -- the `question`
  method is only used when the client advertised the `question` capability; otherwise the engine
  degrades the prompt into sequential `select`/`input` dialogs (`degradeQuestion`,
  `connection-question-bridge.ts:201-224`).
- `upstream/senpi/packages/coding-agent/docs/rpc.md:7626-7711` -- the full documented lifecycle,
  including the example frame at 7644-7665 and the note that questions are broadcast to all attached
  connections while `raisedBy` says which connection raised the work (7630).

MCP elicitation forms are a different, private lane and are not part of this vocabulary:
`mcp_form_request` / `mcp_form_response` travel on a granted presenter connection
(`upstream/senpi/packages/coding-agent/docs/rpc.md:7388-7400`, envelope written at
`upstream/senpi/packages/coding-agent/src/modes/interactive/terminal-presenter-surface.ts:196`), and
the session's generic UI frames never carry them.

## (d) Question answer, cancellation and outcome

Answer:

- `upstream/senpi/packages/coding-agent/docs/rpc.md:7672-7694` -- the answer carries `answers` (a map
  from question id to `{ selected: string[], text?: string }`) plus optional `comment`; a non-blank
  comment settles `comment-submitted`, otherwise any answer settles `answered`; a cancel settles
  `cancelled`; an answer with neither is refused `question_incomplete`.
- `upstream/senpi/packages/coding-agent/src/modes/rpc/connection-question-bridge.ts:146-189` -- the
  same rule in code: `cancelled` finishes as `"cancelled"` with `cancelOrigin: "user"`; otherwise
  `answers`/`comment` are read and `settledQuestionStatus` decides answered vs comment-submitted;
  a frame with neither returns `false`, which the handler maps to `question_incomplete`.
- `upstream/senpi/packages/coding-agent/src/modes/rpc/extension-ui-response.ts:36-39` -- the shared
  settlement rule (`settledQuestionStatus`).

Outcome broadcast:

- `upstream/senpi/packages/coding-agent/src/modes/rpc/rpc-question-types.ts:175-187` -- the
  `question_resolved` record: `id`, optional `resolvedBy`, `requestId`, `toolCallId`, `outcome`
  (`answered | comment-submitted | timed_out | cancelled | orphaned-after-restart | unavailable`),
  `answers`, optional `comment`, `unanswered[]`, optional `deadlineAtMs`.
- `upstream/senpi/packages/coding-agent/docs/rpc.md:7695-7715` -- the record is broadcast to all
  connections when the question resolves; `resolvedBy` is one of `local_ui`, `rpc_connection`,
  `control_endpoint` and is omitted for timeout and cancel.

## Correlation: which id a client must echo

An `extension_ui_response` carries two ids, and the rule is the same for dialogs and questions:

- `uiRequestId` names the `extension_ui_request` being answered (that frame's `id`).
- the response's own `id` is the correlation id of the reply; **without `uiRequestId`, `id` names the
  request** (the short form). Source: `upstream/senpi/packages/coding-agent/docs/rpc.md:7739-7745`.
- Implementation: `upstream/senpi/packages/coding-agent/src/modes/rpc/extension-ui-response.ts:24-30`
  (`answeredUiRequestId`: `uiRequestId` if it is a string, else `id`), used at
  `upstream/senpi/packages/coding-agent/src/modes/rpc/extension-ui-response.ts:94-100`, which
  re-keys the answer to that request id before resolving the pending dialog or question.

So the echoed id is the **dialogue frame id** (`crypto.randomUUID()` at
`connection-handler.ts:653` for dialogs, `connection-question-bridge.ts:46` for questions). It is not:

- the permission request id. That one is `permission-<n>` (`permission-system/service.ts:363-366`,
  used at 272) and is internal; `showPermissionPrompt` replies with it
  (`prompt.ts:31-50`) after the dialog outcome is mapped, and it never appears on the wire.
- the tool call id. `toolCallId` identifies what the prompt approves
  (`docs/rpc.md:7472`); it is not a correlation handle for the answer.
- for questions, `requestId` / `toolCallId` are both set to the extension's `request.requestId`
  (`connection-question-bridge.ts:52-53`) and appear again on `question_resolved`, but the answer is
  still correlated by the frame id.

Routed (multi-session) frames additionally carry the routing `sessionId`
(`upstream/senpi/packages/coding-agent/docs/rpc.md:544`).

An optional `answerId` (1-256 chars) turns the answer into a receipt-bearing one: the host replies
under the response frame's `id` with `disposition` `applied | replay | already_answered | unknown`
(`docs/rpc.md:7785-7800`, implemented in `extension-ui-response.ts:86-117`). It does not change which
request is answered.

## The OpenCode-schema events are not emitted by this host

`permission.asked`, `permission.replied`, `form.created`, `form.replied` and `form.cancelled` are
defined in this worktree's OpenCode fork schema, which is what
`packages/bridge-core/src/host-event.ts` validates today:

- `packages/schema/src/permission.ts:45` -- `permission.asked`;
- `packages/schema/src/permission.ts:47` -- `permission.replied`;
- `packages/schema/src/form.ts:173-175` -- `form.created`, `form.replied`, `form.cancelled`.

The Senpi host has no such wire events:

- A search of `upstream/senpi/packages/coding-agent/src` finds no occurrence of `permission.asked`,
  `form.created`, `form.replied` or `form.cancelled`, and the shipped protocol reference
  `upstream/senpi/packages/coding-agent/docs/rpc.md` never mentions `permission.asked`,
  `permission.replied` or `form.*`.
- The underscore-named `permission_asked` / `permission_replied` events are the permission
  extension's **in-process** bus events, not socket frames:
  `events.ts:70` and `events.ts:73` call `pi.events.emit(...)`; the emitter is wired at
  `permission-system/index.ts:260` and invoked from `permission-system/service.ts:322` and `:330`.
  `pi.events.emit` publishes on the extension event bus (`core/extensions/loader.ts:964-967`), while
  the RPC bridge only forwards `pi.rpc.emit` records published on
  `EXTENSION_RPC_EVENT_CHANNEL` (`loader.ts:925-933`, subscribed at `runner.ts:1226-1232` and
  written as `{ type: "extension_event", name, data }` at `connection-handler.ts:1001-1007`).
  Nothing in the host bridges `pi.events` onto that channel, so `permission_asked` / `permission_replied`
  never reach a client.
- The no-UI path is more explicit: `permission-system/index.ts:416-421` passes an `emitEvent` that
  drops `permission_asked` entirely, and `permission-system/non-interactive.ts:16` is the call site.

Consequence for the bridge: a permission prompt has to be consumed from the
`extension_ui_request`/`extension_ui_response` dialog sub-protocol. Validating host frames against
`EventManifest.ServerDefinitions` cannot see one, and a `permission.asked` decoder has nothing to
decode on this host. `host-projection.ts` therefore synthesizes the client's `permission.*` and
`form.*` events from those dialog frames ("Dialog frames: permission and form synthesis" below).

## Event-cluster frames (projected 2026-11-24)

`packages/bridge-core/src/host-projection.ts` projects the host's live event records onto this fork's
client event stream. The frame names and their fields come from the protocol reference's "Event Types"
section (`upstream/senpi/packages/coding-agent/docs/rpc.md:6285-6298` and the examples at 6751-6866) and
from `rpc-session-event-types.ts`; each is exercised against a stand-in host by
`tools/bridge-qa/cases/event-vocabulary-live.ts`.

| capability row | host frame | client event |
| --- | --- | --- |
| P-643 | `turn_start`, `turn_end` | `session.step.started`, `session.step.ended` |
| P-644 | `turn_end` with `message.stopReason` `"stop"` / `"aborted"` | `session.execution.succeeded` / `.interrupted` (`reason: "user"`); an `"error"` stop emits neither (the retry record carries `.failed`) |
| P-733 | `compaction_start` `{reason}`, `compaction_end` `{reason, result, aborted, willRetry}` | `session.compaction.started`, `.delta`, `.ended`; `aborted: true` ends as `.failed` |
| P-641 | `message_update` `{assistantMessageEvent: {type: "thinking_delta", delta}}` | `session.reasoning.started`, `.delta`, `.ended` |
| P-642 | `message_update` `{assistantMessageEvent: {type: "text_delta", delta}}` | `session.text.started`, `.delta`, `.ended` |
| P-647 | `entry_appended` `{entry}`, `message_end` `{message}` | `session.message.content.updated` for an assistant entry, and `session.text.ended` / `session.reasoning.ended` with the entry's message id |
| P-684 | `extension_event` `{name, data, sessionId?}` | `agent.custom.<name>`, and `rpc.extension.<name>` for a consumer already on the fork's extension channel |
| P-719 | `loaded_surfaces_changed` | `mcp.tools.changed`, and `mcp.status.changed` whose catalogue resync is the substitute's |
| P-762 | `queue_update` `{steering, followUp}`, `pending_input_update` `{changes}` | `session.inbox.enqueued` / `.delivered` / `.cancelled` / `.delivery.changed` |
| P-656 | `tool_execution_start` `{toolCallId, toolName, args}`, `tool_execution_update` `{partialResult}` | `session.tool.input.started`, `.input.ended`, `session.tool.called`; `session.tool.progress` |
| P-657 | `tool_execution_end` `{toolCallId, isError, result}` | `session.tool.success` when `isError` is false, `session.tool.failed` when true |
| P-664, P-666 | `extension_ui_request` `select` (title `Permission required: <action>`), `extension_ui_response` `value` / `cancelled` | `permission.asked`, `permission.replied`; the request is listed through `permission.list` |
| P-674, P-675, P-676 | `extension_ui_request` `question`, `extension_ui_response` `answers` / `cancelled`, `question_resolved` | `form.created`, `form.replied`, `form.cancelled`; the form is listed through `form.list`, and a reply or a dismissal settles it |
| P-677 | `extension_ui_request` `question` with a `required` question, then an answer that leaves it empty | no event: the answer is refused in the client schema's `FormInvalidAnswerError` shape |

### Dialog frames: permission and form synthesis (projected 2026-11-24)

The host writes no OpenCode event for a permission prompt or a structured question (see "The
OpenCode-schema events are not emitted by this host" above). `host-projection.ts` therefore
*synthesizes* `permission.asked` / `permission.replied` and `form.created` / `form.replied` /
`form.cancelled` from the dialog frames it does write, and three rules keep those synthesized events
inside the client's own contract:

- **Client-branded ids.** `Permission.ID` must start with `per` and `Form.ID` with `frm_`, so a host
  request id is carried as the suffix of a client id (`per_<host frame id>`, `frm_<question
  requestId>`) instead of being reused verbatim. `permission.replied.requestID` and the form
  settlement's `id` carry that same client id, so a store keyed by the published id settles on it.
- **Validated before publication.** Nothing upstream validated a synthesized event, so each one is
  decoded against the client's own definition for its type (`EventManifest.Server`, the same schema
  `decodeHostEvent` uses) before it travels. A payload the client would refuse is not published at
  all, and the projector's ignored-frame summary carries the schema's formatter reason — the same
  error shape a client validating that definition reports.
- **Required fields.** A question's `required` flag is published as the field's `required: true`, and
  an answer that leaves a required field empty is refused with the client's typed error
  `{"_tag":"FormInvalidAnswerError","id":<form id>,"message":"Missing required form field: <key>"}`
  (`Form.InvalidAnswerError` -> `FormInvalidAnswerError`, `packages/protocol/src/errors.ts:253`). The
  form stays pending, so a later complete answer still settles it. The documented question wire type
  carries no `required` flag: a host that sends none produces optional fields, the way the question
  tool's own form does (`packages/core/src/tool/plugin/question.ts`, `toField`).

Which frame settles a form: `question_resolved` with `answered` / `comment-submitted` publishes
`form.replied`, any other outcome publishes `form.cancelled`, and the client's own answer frame
(`extension_ui_response` with `answers` or `cancelled`) settles it the same way without waiting for
the broadcast.

### Execution outcomes for P-644

`session.execution.started` comes from `prompt_started` and `agent_start`, but the terminal outcomes
were never published: a `turn_end` only closed the step (`session.step.ended`), while the TUI's
notification and goal plugins subscribe to `session.execution.succeeded` and
`session.execution.interrupted`. The wire `turn_end` record is the agent's own -- the event union in
`upstream/senpi/packages/agent/src/types.ts` declares it as `{type: "turn_end", message, toolResults}`
-- so it carries **no outcome field**. The same-named extension boundary event adds
`outcome: "completed" | "aborted" | "error"` (`core/extensions/types.ts`), but that is a different
record, and the host derives it from the assistant message in any case
(`packages/coding-agent/src/core/agent-session.ts`, `_dispatchTurnEndBoundary`):
`message.stopReason === "aborted"` -> aborted, `"error"` -> error, otherwise completed.

The projector therefore reads `message.stopReason` (with the already-declared top-level `stopReason`
as the declared-vocabulary fallback) and publishes:

- `"aborted"` -> `session.execution.interrupted` with `reason: "user"`;
- `"error"` -> neither event: a failed execution already travels through the retry record
  (`auto_retry_end` -> `session.execution.failed`), and this mapping does not synthesize an error
  payload the frame does not carry;
- any other stop reason, or none -> `session.execution.succeeded`. The record's existence is the
  completion signal (`docs/rpc.md` "Events": "`turn_end` -- Turn completes"), so a frame that names no
  reason still ends a completed turn.

`session.step.ended` is published before the execution outcome, so a consumer that reacts to the
outcome sees the finished step first.

### Declared-vocabulary extension for P-657

The bridge's own `{kind: "tool_result"}` frame carries `callId` and `result` but no outcome, so it used
to project every result as `session.tool.success`. It now reads `isError` (and an optional `error`
text) as its producers declare it: `isError: true` projects `session.tool.failed` with the error text.

### Three names this fork now streams (closed 2026-11-24)

The capability rows ask for `session.message.content.updated`, `mcp.tools.changed` and `agent.custom.*`.
All three were outside the client's stream union; each is a member of it now, in
`packages/schema/src` and the generated event union:

- `session.message.content.updated` moved from `SessionEvent.DurableDefinitions` (the session log) into
  `SessionEvent.Definitions`, so `EventManifest.ServerDefinitions` and the generated union carry it.
  `host-projection.ts` publishes it from an `entry_appended` assistant entry with that entry's own
  message id and its text/reasoning parts; a tool part has no reproducible client shape and stays on
  `session.tool.*`. The id is the host's verbatim, like every other projected message id, while the
  client brands `SessionMessage.ID` with `msg_`; reconciling the two is the id-scheme decision recorded
  as a separate degraded row, not taken here.
- `McpEvent.ToolsChanged` joined `ServerDefinitions`, and `loaded_surfaces_changed` now publishes
  `mcp.tools.changed`.
- `agent.custom.<name>` is a templated event (`packages/schema/src/agent-custom-event.ts`). It cannot be
  a `Definition` -- `Event.latest` keys its map by the literal type and the generated unions enumerate
  literals -- so it travels beside them: `EventManifest.TemplatedDefinitions`, the protocol event
  group's stream schema and `host-event.ts`'s decoder append it, and `EventManifest.isServer` matches it
  by prefix. An `extension_event` publishes `agent.custom.<name>`.

The member each row used to be answered with keeps travelling beside the new event
(`session.text.ended`/`.reasoning.ended`, `mcp.status.changed`, `rpc.extension.<name>`), so a consumer
subscribed to the substitute is unaffected. Row status is recorded in the capability ledger, which this
document does not own.

### Identity the host frames do not carry

- `session.step.started` needs an `agent` and a `model`; a `turn_start` carries neither, so a frame or
  embedded-message value is used when present and `"bridge"` / `{id: "bridge", providerID: "bridge"}`
  stand in otherwise -- the same declared-bridge-identity rule as `version: "bridge"`.
- A queued text in `queue_update` has no host id, so the bridge mints one `msg_bridge_inbox_<n>` per text
  and reuses it for that text's delivery or cancellation; a text that leaves the queue snapshot is
  reported delivered, because the fork's inbox vocabulary has no third terminal.
- `extension_event` is routed by its documented `sessionId` only. An id the bridge does not know leaves
  the event unattached: the projector never mints a session from an extension record. `agent.custom.<name>`
  carries that routing `sessionId` (not a client `SessionID`) plus the resolved `sessionID` only when the
  routing id names a session the bridge knows, and passes the extension's `data` through as `payload`.
- `session.message.content.updated` carries the entry's own message id, so its `messageID` is a host id
  and not one of the bridge's `bridge-<session>-<n>` minted ids.

### Keepalive and idle watchdog (P-603)

`packages/bridge-core/src/opencode-api.ts` installs a 15 s activity timer on the bridge event stream, so a
subscriber's `onActivity` sees three ticks inside the 45 s idle window; the shipped client's watchdog
(`packages/client/src/solid/connection.ts`, `defaultIdleTimeout` 45 s) aborts a stream that produces no
activity for that window. Both are locked by fake-timer tests in
`packages/bridge-core/test/host-projection-event-cluster.test.ts`. The activity timer is local: the host
writes no heartbeat record, so a silently dead socket is still only caught by the subscriber's watchdog.

## Unknowns

These are not established by source reading and are deliberately left open:

1. **Other distribution layers.** The read covers `upstream/senpi` only. Whether the OmO desktop
   app, a relay, or a fork-level wrapper translates Senpi's dialog frames into an OpenCode-shaped
   event stream elsewhere (so a client of that layer could see `permission.asked`) is not
   established here.
2. **Runtime byte shape of `id`.** Source uses `crypto.randomUUID()`; no document promises a UUID
   format for UI frame ids, so a decoder must treat it as an opaque non-empty string.
3. **Transport-specific answer accounting.** The documentation says a single-session stdio connection
   ignores an unmatched unnamed response, while a routed host replies
   `unknown_extension_ui_request` (`docs/rpc.md:7747-7759`,
   `extension-ui-response.ts:100-117`). Which of these applies to the OmO host's specific socket is a
   runtime fact; it was not observed.
4. **Delivery scope of `question_resolved`.** The documentation says "all connections"
   (`docs/rpc.md:7695`); whether a connection that never advertised the `question` capability also
   receives it was not verified.
5. **MCP form envelopes.** `mcp_form_request` / `mcp_form_response` are documented
   (`docs/rpc.md:7388-7400`) but their complete field set was not read line-by-line and is out of
   scope for this decoder; they are not decoded here.
6. **Fire-and-forget requests.** `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`,
   `setSubagentCost`, `custom_unsupported` and `extension_ui_progress` are verified in
   `rpc-question-types.ts:92-127` and `:159-164` but are outside (a)-(d); `host-frames.ts` rejects
   them by name rather than guessing their payloads.
7. **Abort provenance in a `turn_end`.** The assistant message's `stopReason: "aborted"` does not say
   whether the user stopped the turn or a shutdown did (`core/changes.md` records the shutdown case),
   and the record carries no other discriminator. The projected `session.execution.interrupted`
   therefore always reports `reason: "user"`; a shutdown-driven abort is indistinguishable from a user
   abort on this wire.

## Decoder scope

`packages/bridge-core/src/host-frames.ts` decodes exactly the frames above:

- `extension_ui_request` with `method: "select"` (the permission prompt and any other select dialog),
- `extension_ui_request` with `method: "question"`,
- `extension_ui_response` with `value` (permission answer),
- `extension_ui_response` with `answers` and optional `comment` (question answer),
- `extension_ui_response` with `cancelled: true` (any dialog cancellation),
- `question_resolved`.

Decoding uses the same Effect `Schema` pipeline as `host-event.ts`; a field the schemas do not
declare is not carried into the decoded value (Effect `Struct` drops excess properties), so a
consumer keeps exactly the fields listed in this document plus the optional routing `sessionId`.

The event-cluster frames above are not decoded here: `host-projection.ts` reads them straight off the
published records and projects them onto the client event vocabulary, and the projector's stats counter
is what reports a record it does not map.
