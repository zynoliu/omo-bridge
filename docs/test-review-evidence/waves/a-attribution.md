# a-attribution

Audit of how a senpi host failure becomes a TUI string, in `/Users/zyno/Developer/github/omo-bridge`
against `/Users/zyno/OmO Projects/my-tui/opencode`. Read-only.

## Facts

- A mid-turn provider failure does not use the HTTP path at all: the host's `agent_end` frame carries `failure`, and the bridge projects that frame into an SSE event. [src/translate/lifecycle.ts:298-299]
- The sentence "the provider returned an unexpected error" is generated in the host package, not in the bridge or the TUI: `describeProviderFailure` returns it as `reason` whenever the diagnostic category is `unknown`. [node_modules/@code-yeongyu/senpi/dist/core/provider-failure.js:42-56] (the literal is line 50)
- The host attaches it to the turn-end event as `{ ...event, failure }` via `withProviderFailure(providerFailureOf(event.messages, selected))`. [node_modules/@code-yeongyu/senpi/dist/core/agent-session.js:200-202]
- The failure object the host hands over is `{ category, provider, model, httpStatus, code, resetsAt, reason, action, ... }`, where `reason`/`action` come from the fixed `ACTIONS` table or the `unknown` fallback. [node_modules/@code-yeongyu/senpi/dist/core/provider-failure.js:55-63] [node_modules/@code-yeongyu/senpi/dist/core/provider-failure.js:48-53]
- The bridge keeps three of those fields and drops the rest: `category -> type`, `reason -> message`, `httpStatus -> status`; `provider`, `model`, `code`, `resetsAt`, `action` never leave `failureError`. [src/translate/lifecycle.ts:165-174]
- The bridge emits it as `session.execution.failed` with `{ sessionID, error: failureError(failure) }`. [src/translate/lifecycle.ts:248]
- The SSE route serialises the event object verbatim as `data: <json>`. [src/http/routes/events.ts:48-49]
- On the client, "Session failed" is a **toast title**, and the message is the event's `error.message` (`notify(...)` uses the same message). [packages/tui/src/feature-plugins/system/notifications.ts:91-93]
- The toast renders `title` (bold) and `message` on separate rows, so the TUI never contains the literal string "Session failed — ..."; the dash is an observer's join. [packages/tui/src/ui/toast.tsx:90-98]
- The mandated client grep finds nothing: the string does not exist anywhere under `packages/tui/src`. [cmd: grep -rn "provider returned an unexpected error" opencode/packages/tui/src | head -5 -> 0 lines]
- The same failure also sets `terminalError = new Error(errorMessage(event.data.error))`, where `errorMessage` is `error.message || error._tag || "Session execution failed"`. [packages/tui/src/mini/stream-v2.transport.ts:1438-1440] [packages/tui/src/mini/stream-v2.transport.ts:193-195]
- The client's canonical schema for this event allows more than the bridge sends: `{ type, message, status?, response?: { body }, retryAfterMs? }`. [packages/schema/src/session-error.ts:6-13]
- The bridge never populates `response` or `retryAfterMs`; the emitted error is exactly `{ type, message, status? }`. [src/translate/lifecycle.ts:173]
- Nothing in the bridge's translate layer logs: no `console.*` in lifecycle/stream/tools. [cmd: grep -c console src/translate/lifecycle.ts src/translate/stream.ts src/translate/tools.ts -> 0,0,0]
- A failed turn is not persisted either: the session map has no error field. [cmd: grep -n "lastError" src/model/session-map.ts -> 0 hits]
- `session.step.failed` (the event that renders an inline error row in the chat) is never emitted by the bridge; only `session.step.streamed` exists. [cmd: grep -rn "step\.failed" src -> 0 hits] [src/translate/lifecycle.ts:211]
- The client's inline-error branch depends on that missing event, so a failed turn reaches the user only as a transient toast plus the terminal error row. [packages/tui/src/mini/stream-v2.transport.ts:1402-1412]
- On the HTTP path, handlers wrap work in `respond()`, which serialises `{ _tag, message, ...fields }` and logs nothing. [src/http/handlers/problem.ts:81-88]
- Prompt submission runs on that path: `handleSessionPrompt` returns `respond(url, async () => { ... caller.prompt(...) })`. [src/http/handlers/prompt.ts:437-438] [src/http/handlers/prompt.ts:340]
- Any error that is not a `SenpiTransportError` becomes `503 ServiceUnavailableError` with `service: "senpi"` and the raw error message. [src/http/handlers/problem.ts:75-79]
- Only `session_not_found` is special-cased; every other transport code (gone, missing socket, auth, command_failed) is the same 503. [src/http/handlers/problem.ts:66-73]
- `mapSenpiError` is the catch-all that produces `command_failed` for everything unrecognised. [src/senpi/errors.ts:94]
- The server forwards the router promise with no catch of its own, so the only error rendering is the handler's own `respond()`. [src/http/server.ts:107-111]
- `validateEvent` exists but is called only from tests and `scripts/contracts-check.ts`; production dispatch publishes projector events straight to the bus without validating them. [src/contract/validate.ts:76] [src/runtime.ts:111]
- The bridge's transcript projection maps assistant content blocks only (text / thinking / toolCall), so `stopReason` and `errorMessage` from the host transcript never surface to the client. [src/http/handlers/sessions.ts:490-499] [src/model/session-map.ts:472-474]

## Gaps

- No bridge-side record of a failed turn: no log line, no state field, no event log file — after the SSE frame is consumed the cause is gone. [cmd: grep -rn "console\." src/translate -> 0 hits] [cmd: grep -n "lastError" src/model/session-map.ts -> 0 hits]
- Diagnostic identity is discarded at the boundary: `provider`, `code`, `httpStatus` beyond the number, `resetsAt` and the suggested `action` are dropped, so "unknown" tells an operator nothing about which provider failed or how. [src/translate/lifecycle.ts:165-174]
- Provider failure and bridge bug are indistinguishable in the HTTP answer: an internal `TypeError` and a host refusal both come out as `503 ServiceUnavailableError` with `service: "senpi"`; nothing marks the producer. [src/http/handlers/problem.ts:78]
- `respond()` has no logging branch, so the caught error's stack (and `SenpiTransportError.cause`) is dropped once the body is written. [src/http/handlers/problem.ts:81-88]
- The failure is not durable: after the toast expires or the client reconnects, neither bridge nor client state retains it; the chat row exists only while the run object lives. [packages/tui/src/mini/stream-v2.transport.ts:1644-1649] [cmd: grep -n "lastError" src/model/session-map.ts -> 0 hits]
- The inline chat error is dead in bridge mode because `session.step.failed` is never projected; the observed surface is the toast only. [cmd: grep -rn "step\.failed" src -> 0 hits]
- The client's richer error channels (`response.body`, `retryAfterMs`) are never filled, so the one place an operator could read the provider's own body stays empty. [packages/schema/src/session-error.ts:9-12] [src/translate/lifecycle.ts:173]
- Event contract validation is test-only, so a malformed failure projection would reach the TUI unchecked. [src/contract/validate.ts:76] [src/runtime.ts:111]
- `error.type` is the host's raw category vocabulary (`unknown`, `rate_limit`, `quota`), mixed with the client's expected `provider.*` limit tags; only two of those tags are special-cased client-side. [src/translate/lifecycle.ts:166] [packages/tui/src/feature-plugins/system/notifications.ts:87]

## Claims

- The text "the provider returned an unexpected error" is authored in the senpi host package, not in omo-bridge and not in the TUI | node_modules/@code-yeongyu/senpi/dist/core/provider-failure.js:50 | high
- "Session failed" is a TUI toast title rendered above the message; no concatenated "Session failed — ..." string exists in either repo | packages/tui/src/feature-plugins/system/notifications.ts:91 + packages/tui/src/ui/toast.tsx:90-98 + cmd: grep -> 0 | high
- The bridge passes through only type/message/status and drops provider, code, action and resetsAt | src/translate/lifecycle.ts:165-174 | high
- A mid-turn provider failure leaves no bridge-side trace: no log, no persisted field | cmd: grep console in src/translate -> 0,0,0 | high
- An operator cannot tell a provider failure from a bridge bug from the HTTP answer: both are 503 ServiceUnavailableError tagged service=senpi | src/http/handlers/problem.ts:72,78 | high
- Only the wording of `message` distinguishes them (a generated provider sentence versus a JS exception text) | node_modules/@code-yeongyu/senpi/dist/core/provider-failure.js:50 + src/http/handlers/problem.ts:78 | medium
- The original provider text survives upstream on the assistant message (`errorMessage`, `providerDiagnostic`) but the bridge's transcript projection never exposes it | node_modules/@code-yeongyu/senpi/dist/core/agent-session.js:202 + src/http/handlers/sessions.ts:490-499 | medium
- The missing `session.step.failed` projection is why the TUI shows only a toast for a failed turn, not an inline chat error | cmd: grep step.failed in src -> 0 hits + packages/tui/src/mini/stream-v2.transport.ts:1402-1412 | medium
