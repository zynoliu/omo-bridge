# TUI surface audit

## Answer

**The defects are systemic, not isolated.** The bridge was verified by a harness that drove session flows; the TUI calls a much wider surface.

At the branch point (`e75a1bf`), of the **99 endpoints the TUI actually calls**:

| Finding | Count | Severity |
| --- | --- | --- |
| Unmounted endpoints (router 404/405) | **12** | S4, S6 |
| Unmounted at startup, user-visible crash/gate | 2 (`/api/plugin`, and `/api/location` before its branch merge) | S1, S2 |
| Undeclared HTTP status (client throws `UnexpectedStatus`) | **10 endpoints / 7 families**, plus the 501 capability path of rename/fork | S5 |
| Success status/body drift | 1 (`session.compact`: 204 vs 200 + body) | S5 |
| Control-flow gates from an empty/degraded answer | 3 (`integration.list`, `vcs.base`, `usage.limits`) | S3, S7 |
| Empty answers that are truthful and flip no branch | 19 | S8 |

After the fixes on this branch: **0 unmounted, 0 undeclared statuses, 0 5xx** across all 99 endpoints against a live bridge.

## Method

- **Endpoint list.** Generated, never hand-written: `scripts/surface-extract.ts` parses the fork's `packages/client/src/promise/generated/client.ts` descriptors (method, path, `successStatus`, `declaredStatuses`, `empty`, `binary`, SSE) and narrows them to the chains that appear in `packages/tui/src` and `packages/client/src/solid` (TypeScript AST, so multi-line chains count). Output: `contracts/surface/tui-endpoints.json`. A new client descriptor the TUI starts calling changes this fixture, and `test/http/surface.test.ts` fails until it is regenerated.
- **Live evidence.** A real launcher + private senpi host (`bin/omo-bridge start`, private state dir) was probed for every endpoint with a fresh session per session-scoped call; `location[directory]` pointed at the checkout. Statuses and bodies are from that run.
- **Schema evidence.** For the 37 endpoints with a bridge contract id, the live body was validated with `validateResponse`; all passed. Endpoints without an extracted contract are marked `no extracted schema` and only their status/envelope was checked.
- **Probe limitation.** Write endpoints were probed with `{}` so required-payload paths answer their declared 400/404; their success bodies were reviewed statically and are exercised by the in-process fake host where the fixture leads to a 2xx.

## The audit

Sorted by severity. `Pre-fix` is the status at `e75a1bf` (live probe, or the route table for endpoints the first probe list did not include; `n/p` = not probed pre-fix). `Post-fix` is this branch against the live bridge.

| Sev | Class | Endpoint | Pre-fix | Post-fix | In declaredStatuses | Success schema | Empty/degraded | TUI consumer | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | c | `GET /api/location` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:2065, packages/client/src/solid/data.ts:733 | **c, fixed before this branch.** Was `{location:{...}}`; the protocol declares a bare `Location.PublicInfo`. The TUI read `location.directory` as undefined and crashed at startup. `/api/location` now returns the bare object; this suite pins the envelope. |
| S2 | c | `GET /api/plugin` | 200 | 200 | yes | pass | yes | packages/tui/src/feature-plugins/system/plugins.tsx:36, packages/tui/src/plugin/context.tsx:540 | **c, fixed before this branch (6a7a8db).** Was 404 at startup. `plugin.list` now returns the empty inventory; the surface test fails on the pre-fix commit (see Pre-fix proof). |
| S3 | b | `GET /api/integration` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:2117, packages/tui/src/component/dialog-go-upsell.tsx:222 | **b, accepted and documented.** Empty `data` → `hasConnectedProvider([])` is false → with `experimental.new-designs` on, `/models` renders the free/connect dialog instead of the model list (`dialog-model.tsx:48-49`). No truthful integration exists to project; DEGRADATIONS.md now names the `/models` consequence. |
| S4 | c | `GET /api/experimental/session/:sessionID/export` | 404 | 200 | yes | no extracted schema | - | packages/tui/src/routes/session/index.tsx:1335, packages/tui/src/routes/session/index.tsx:1361 | **c, fixed.** Was unmounted; `/export` and "Copy session transcript" failed. Now a real projection: `{data:{info, messages}}` from the same read path as `session.get` + `message.list`. |
| S4 | c | `GET /api/experimental/session/stats` | 404 | 400 | yes | no extracted schema | - | packages/tui/src/feature-plugins/system/stats.tsx:143 | **c, fixed.** Was unmounted: 404 outside `declaredStatuses` (`invalid ClientError` on `/stats`). Now the declared 400 `InvalidRequestError`; `/stats` shows "Could not load stats" (`stats.tsx:160`). No daily ledger exists to aggregate honestly. |
| S4 | c | `GET /api/fs/read/:path` | 404 | 200 | yes | no extracted schema | - | packages/tui/src/feature-plugins/system/diff-viewer.tsx:206 | **c, fixed.** Was unmounted; diff-viewer image previews 404'd (`diff-viewer.tsx:206`). Now a real, location-confined file read with a wildcard route. |
| S4 | c | `GET /api/model/default` | 404 | 200 | yes | no extracted schema | - | packages/tui/src/mini/runtime.ts:657, packages/tui/src/mini/stream-v2.transport.ts:464 | **c, fixed (truthful empty).** Was unmounted; the mini runtime's default-model load 404'd. Now `200 {location}` with no `data`: the host declares no default model, and `runtime.ts:667` falls back when `data` is absent. |
| S4 | c | `POST /api/rpc/:rpcID/:method` | 404 | 400 | yes | no extracted schema | - | packages/client/src/promise/rpc.ts:102, packages/tui/src/feature-plugins/prompt/goal.tsx:14 | **c, fixed.** Was unmounted; `/goal` silently had no goal (`goal.tsx:14` catches). Now the declared 400 `RpcError` ("no plugin RPC registered"), which the TUI already treats as "no goal plugin". |
| S4 | c | `POST /api/session/:sessionID/generate` | 404 | 400 | yes | no extracted schema | - | packages/tui/src/feature-plugins/prompt/btw.tsx:68 | **c, fixed.** Was unmounted; `/btw` failed. Now the declared 400 `InvalidRequestError`; `/btw` toasts the reason (`btw.tsx:68-80`). |
| S4 | c | `GET /api/vcs/branch` | 404 | 200 | yes | no extracted schema | - | packages/tui/src/feature-plugins/system/diff-viewer.tsx:268 | **c, fixed.** Was unmounted; the base-branch picker always showed "Could not load branches" (`diff-viewer.tsx:268`). Now real `git for-each-ref`, honoring search/limit. |
| S4 | c | `GET /api/vcs/status` | 404 | 200 | yes | no extracted schema | - | packages/tui/src/component/dialog-workspaces.tsx:257 | **c, fixed.** Was unmounted; the worktree-delete confirmation reads it (`dialog-workspaces.tsx:257`). Now real `git status` + numstat. |
| S5 | c | `POST /api/credential/:credentialID/activate` | 409 | 400 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:232 | **c, fixed.** 409 was outside `[400,401]`. Now 400. |
| S5 | c | `DELETE /api/credential/:credentialID` | n/p | 400 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:271 | **c, fixed.** 409 was outside `[400,401]`. Now 400. |
| S5 | c | `PATCH /api/credential/:credentialID` | n/p | 400 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:254 | **c, fixed.** 409 was outside `[400,401]`. Now 400. |
| S5 | c | `POST /api/experimental/session/:sessionID/terminal` | 409 | 400 | yes | no extracted schema | - | packages/tui/src/context/session-terminals.tsx:104 | **c, fixed.** 409 was outside `declaredStatuses` `[400,401,503]`. Now 400 `InvalidRequestError` (declared, non-5xx). |
| S5 | c | `POST /api/integration/:integrationID/connect/external` | n/p | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:372 | **c, fixed.** 409 was outside `[400,401,404]`. Now 404 `IntegrationNotFoundError`. |
| S5 | c | `POST /api/integration/:integrationID/connect/key` | n/p | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:568 | **c, fixed.** 409 was outside `[400,401,404]`; upstream declares `IntegrationNotFoundError` at 404. Now 404. |
| S5 | c | `POST /api/pair` | 409 | 400 | yes | no extracted schema | - | packages/tui/src/component/dialog-pair.tsx:22 | **c, fixed.** 409 was outside `declaredStatuses` `[400,401]`; the client threw `UnexpectedStatus`. Now 400 `InvalidRequestError`. |
| S5 | c | `POST /api/session/:sessionID/compact` | 501 | 400 | yes | no extracted schema | - | packages/client/src/solid/data.ts:1714, packages/tui/src/mini/runtime.ts:927 | **c, fixed.** Two defects: the missing-capability path answered **501** (an undeclared 5xx), and the success path answered **204** where the client expects **200 `{data: Session.Inbox.Compaction}`**. Now 400 on the capability gap and a real 200 receipt when the host compacts. |
| S5 | c | `PATCH /api/session/:sessionID` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/component/dialog-session-rename.tsx:20, packages/tui/src/component/session-nav.tsx:313 | **c, fixed (capability path).** A transport that cannot rename answered **501** (undeclared). Now 400 `InvalidRequestError`; the endpoint itself answers 204 when rename works. |
| S5 | c | `POST /api/worktree` | 409 | 400 | yes | no extracted schema | - | packages/tui/src/component/dialog-open.tsx:463, packages/tui/src/component/prompt/move.tsx:41 | **c, fixed.** 409 was outside `declaredStatuses` `[400,401,404]`; upstream declares `WorktreeError` at 400. Now 400. |
| S6 | c | `POST /api/location/reload` | 404 | 204 | yes | no extracted schema | - | packages/tui/src/app.tsx:1112 | **c, fixed.** Was unmounted; `/reload` toasted the 404. Now an idempotent 204 (no location service state to reconcile). |
| S6 | c | `POST /api/plugin/check` | 404 | 200 | yes | no extracted schema | yes | packages/tui/src/feature-plugins/system/plugins.tsx:168 | **c, fixed.** Was unmounted; the plugins dialog's check button toast-ed. Now `200 {location,data:[]}`: no server plugins to re-check. |
| S6 | c | `POST /api/plugin/update` | 404 | 204 | yes | no extracted schema | - | packages/tui/src/feature-plugins/system/plugins.tsx:146 | **c, fixed.** Was unmounted; the update path toast-ed. Now an idempotent 204: no package plugin to update. |
| S6 | c | `POST /api/session/:sessionID/fork` | n/p | 400 | yes | n/a (error) | - | packages/tui/src/app.tsx:710, packages/tui/src/app.tsx:723 | **c, fixed (capability path).** A transport that cannot fork answered **501**; now 400. A cancelled fork keeps its declared 409. |
| S6 | c | `DELETE /api/worktree` | 405 | 400 | yes | no extracted schema | - | packages/tui/src/component/dialog-workspaces.tsx:244, packages/tui/src/component/dialog-workspaces.tsx:270 | **c, fixed.** The router answered 405 (POST owned the path). Now the declared 400 `WorktreeError`; the TUI still shows "Failed to delete worktree" but through a declared error. |
| S7 | b | `GET /api/experimental/usage/limits` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:1486 | **b, accepted.** `data:null` = not signed in to OpenCode Console; `/usage` renders the signed-out copy and no budget warnings (`usage.tsx:42`, `:96`). |
| S7 | b | `GET /api/vcs/base` | 200 | 200 | yes | pass | yes | packages/tui/src/feature-plugins/system/diff-viewer.tsx:127 | **b, left.** The bridge always answers `data:null`; `diff-viewer` shows "Base not reported" and disables the "Committed" source (`diff-viewer.tsx:146-150`, `:191`). Truthful only for repos without a base; DEGRADATIONS.md records it as a gap. |
| S8 | a | `GET /api/agent` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:2111, packages/tui/src/component/dialog-agent.tsx:11 |  |
| S8 | a | `GET /api/command` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:2112, packages/tui/src/component/prompt/autocomplete.tsx:503 |  |
| S8 | a | `GET /api/config` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:2115, packages/tui/src/app.tsx:218 | Empty config is real: `useConfig` falls back to defaults (`app.tsx:218`). |
| S8 | a | `GET /api/event` | 200 | 200 | yes | no extracted schema | - | packages/client/src/solid/connection.ts:97, packages/tui/src/mini/stream-v2.transport.ts:1504 |  |
| S8 | a | `POST /api/experimental/mcp/:server/connect` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/component/dialog-mcp.tsx:124 |  |
| S8 | a | `POST /api/experimental/mcp/:server/disconnect` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/component/dialog-mcp.tsx:124 |  |
| S8 | a | `GET /api/experimental/media/:hash` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/util/media.ts:27 |  |
| S8 | a | `GET /api/experimental/migration/v1` | 200 | 200 | yes | pass | yes | packages/tui/src/component/migration-overlay.tsx:22 | "completed" keeps the migration overlay closed (`migration-overlay.tsx:22`). |
| S8 | a | `POST /api/experimental/persistent-pty/:ptyID/connect-token` | 404 | 404 | yes | no extracted schema | - | packages/client/src/solid/pty.ts:65 |  |
| S8 | a | `GET /api/experimental/session/:sessionID/terminal` | 200 | 200 | yes | pass | yes | packages/tui/src/context/session-terminals.tsx:37 | Empty list is behind `capabilities.persistentPty:false` (`session-terminals.tsx:73`); no pane is offered. |
| S8 | a | `GET /api/experimental/persistent-pty/:ptyID/snapshot` | 404 | 404 | yes | no extracted schema | - | packages/tui/src/component/terminal-pane.tsx:182 |  |
| S8 | a | `GET /api/experimental/session/:sessionID/log` | 200 | 200 | yes | no extracted schema | - | packages/tui/src/component/devtools-bar.tsx:165 |  |
| S8 | a | `POST /api/experimental/session/:sessionID/wait` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/mini/stream-v2.transport.ts:914, packages/tui/src/routes/session/index.tsx:1138 |  |
| S8 | a | `GET /api/fs/find` | 400 | 400 | yes | n/a (error) | - | packages/tui/src/component/prompt/autocomplete.tsx:378, packages/tui/src/mini/runtime.ts:234 |  |
| S8 | a | `GET /api/fs/list` | 200 | 200 | yes | pass | - | packages/tui/src/app.tsx:228 |  |
| S8 | a | `GET /api/form` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:1972, packages/client/src/solid/data.ts:1988 | No pending forms; home shows none (`home.tsx:38`). |
| S8 | a | `DELETE /api/integration/:integrationID/connect/command/:attemptID` | 404 | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:431, packages/tui/src/component/dialog-integration.tsx:513 |  |
| S8 | a | `POST /api/integration/:integrationID/connect/command` | n/p | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:423 |  |
| S8 | a | `GET /api/integration/:integrationID/connect/command/:attemptID` | n/p | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:478 |  |
| S8 | a | `DELETE /api/integration/:integrationID/connect/oauth/:attemptID` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/component/dialog-go-upsell.tsx:336, packages/tui/src/component/dialog-go-upsell.tsx:377 |  |
| S8 | a | `POST /api/integration/:integrationID/connect/oauth/:attemptID/complete` | n/p | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-integration.tsx:780 |  |
| S8 | a | `POST /api/integration/:integrationID/connect/oauth` | 404 | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-go-upsell.tsx:332, packages/tui/src/component/dialog-integration.tsx:617 |  |
| S8 | a | `GET /api/integration/:integrationID/connect/oauth/:attemptID` | 404 | 404 | yes | no extracted schema | - | packages/tui/src/component/dialog-go-upsell.tsx:285, packages/tui/src/component/dialog-integration.tsx:698 |  |
| S8 | a | `GET /api/mcp` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:2119 | No MCP servers: dialog lists nothing (`dialog-mcp.tsx:46`). |
| S8 | a | `GET /api/mcp/resource` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:2121 | No MCP catalog; devtools resource rows empty (`devtools-bar.tsx:204`). |
| S8 | a | `GET /api/session/:sessionID/message` | 200 | 200 | yes | pass | - | packages/client/src/promise/media.ts:33, packages/client/src/solid/data.ts:1823 |  |
| S8 | a | `GET /api/model` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:2125, packages/tui/src/component/dialog-go-upsell.tsx:244 |  |
| S8 | a | `GET /api/session/:sessionID/permission` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:1938, packages/tui/src/component/devtools-bar.tsx:194 | No pending permission requests (`session-tabs.tsx:165`). |
| S8 | a | `POST /api/session/:sessionID/permission/:requestID/reply` | 404 | 404 | yes | no extracted schema | - | packages/client/src/solid/data.ts:1947, packages/tui/src/component/session-nav.tsx:304 |  |
| S8 | a | `GET /api/permission/saved` | 200 | 200 | yes | no extracted schema | yes | packages/client/src/solid/data.ts:2030 | No saved rules yet; bridge-local store (`data.ts:2030`). |
| S8 | a | `GET /api/project` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:2017, packages/tui/src/component/dialog-open.tsx:239 |  |
| S8 | a | `GET /api/provider` | 200 | 200 | yes | no extracted schema | - | packages/client/src/solid/data.ts:2126, packages/tui/src/component/dialog-integration.tsx:1275 |  |
| S8 | a | `GET /api/reference` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:2127, packages/tui/src/component/prompt/autocomplete.tsx:293 | Autocomplete contributes nothing (`autocomplete.tsx:293`). |
| S8 | a | `GET /api/info` | 200 | 200 | yes | pass | - | packages/tui/src/component/devtools-bar.tsx:57, packages/tui/src/component/dialog-pair.tsx:22 |  |
| S8 | a | `GET /api/session/active` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:710, packages/tui/src/component/dialog-open.tsx:180 | No running session; `{}` is truthful (`dialog-open.tsx:180`). |
| S8 | a | `POST /api/session/:sessionID/background` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/component/prompt/index.tsx:544, packages/tui/src/mini/runtime.ts:392 |  |
| S8 | a | `POST /api/session/:sessionID/command` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/component/prompt/index.tsx:1325, packages/tui/src/feature-plugins/prompt/goal.tsx:111 |  |
| S8 | a | `POST /api/session` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:1676, packages/tui/src/component/prompt/index.tsx:1239 |  |
| S8 | a | `GET /api/session/:sessionID/diff` | 200 | 200 | yes | pass | yes | packages/tui/src/feature-plugins/system/diff-viewer.tsx:151 | Empty turn diff renders as "no files"; documented in DEGRADATIONS.md. |
| S8 | a | `PUT /api/session/:sessionID/environment` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/app.tsx:537, packages/tui/src/component/prompt/index.tsx:1255 |  |
| S8 | a | `DELETE /api/session/:sessionID/form/:formID` | 404 | 404 | yes | no extracted schema | - | packages/client/src/solid/data.ts:2002, packages/tui/src/component/session-nav.tsx:307 |  |
| S8 | a | `GET /api/session/:sessionID/form` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:1988, packages/tui/src/component/devtools-bar.tsx:195 | Empty render; no control-flow effect. |
| S8 | a | `POST /api/session/:sessionID/form/:formID/reply` | 404 | 404 | yes | no extracted schema | - | packages/client/src/solid/data.ts:1999, packages/tui/src/mini/runtime.ts:278 |  |
| S8 | a | `GET /api/session/:sessionID` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:1788, packages/tui/src/app.tsx:533 |  |
| S8 | a | `DELETE /api/session/:sessionID/inbox/:inboxID` | 404 | 404 | yes | no extracted schema | - | packages/tui/src/mini/runtime.ts:398, packages/tui/src/routes/session/index.tsx:768 |  |
| S8 | a | `GET /api/session/:sessionID/inbox` | 200 | 200 | yes | pass | yes | packages/client/src/promise/media.ts:45, packages/client/src/solid/data.ts:1596 | No queued work; truthful empty inbox. |
| S8 | a | `PATCH /api/session/:sessionID/inbox/:inboxID` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/mini/runtime.ts:401, packages/tui/src/routes/session/index.tsx:765 |  |
| S8 | a | `POST /api/session/:sessionID/interrupt` | 200 | 200 | yes | no extracted schema | - | packages/tui/src/component/prompt/index.tsx:524, packages/tui/src/component/session-nav.tsx:300 |  |
| S8 | a | `GET /api/session` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:570, packages/client/src/solid/retention.ts:34 |  |
| S8 | a | `GET /api/session/:sessionID/message/:messageID` | 404 | 404 | yes | n/a (error) | - | packages/client/src/promise/media.ts:40, packages/client/src/solid/data.ts:795 |  |
| S8 | a | `POST /api/session/:sessionID/move` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/component/dialog-workspaces.tsx:318, packages/tui/src/component/prompt/index.tsx:303 |  |
| S8 | a | `POST /api/session/:sessionID/prompt` | 400 | 400 | yes | no extracted schema | - | packages/client/src/solid/data.ts:1774, packages/tui/src/component/prompt/index.tsx:1366 |  |
| S8 | a | `DELETE /api/session/:sessionID` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/component/dialog-session-list.tsx:269, packages/tui/src/component/session-nav.tsx:338 |  |
| S8 | a | `DELETE /api/session/:sessionID/revert` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/routes/session/index.tsx:1154, packages/tui/src/routes/session/index.tsx:2277 |  |
| S8 | a | `POST /api/session/:sessionID/revert/commit` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/component/prompt/index.tsx:1346 |  |
| S8 | a | `POST /api/session/:sessionID/revert/stage` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/routes/session/dialog-message.tsx:45, packages/tui/src/routes/session/index.tsx:1139 |  |
| S8 | a | `POST /api/session/:sessionID/shell` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/component/prompt/index.tsx:1315, packages/tui/src/mini/stream-v2.transport.ts:1602 |  |
| S8 | a | `POST /api/session/:sessionID/agent` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/component/prompt/index.tsx:1288, packages/tui/src/mini/stream-v2.transport.ts:1817 |  |
| S8 | a | `POST /api/session/:sessionID/model` | 400 | 400 | yes | no extracted schema | - | packages/client/src/solid/data.ts:1713, packages/tui/src/component/prompt/index.tsx:1294 |  |
| S8 | a | `POST /api/session/:sessionID/synthetic` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/component/prompt/index.tsx:1352 |  |
| S8 | a | `POST /api/session/:sessionID/view` | 400 | 400 | yes | no extracted schema | - | packages/tui/src/context/session-tabs.tsx:245 |  |
| S8 | a | `GET /api/shell/:id` | 404 | 404 | yes | n/a (error) | - | packages/tui/src/component/dialog-shell-output.tsx:41, packages/tui/src/routes/session/index.tsx:3012 |  |
| S8 | a | `GET /api/shell` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:1488, packages/tui/src/feature-plugins/prompt/footer.tsx:32 | No shell commands; footer shows none (`prompt/footer.tsx:32`). |
| S8 | a | `GET /api/shell/:id/output` | 404 | 404 | yes | n/a (error) | - | packages/tui/src/component/dialog-shell-output.tsx:46, packages/tui/src/component/dialog-shell-output.tsx:51 |  |
| S8 | a | `DELETE /api/shell/:id` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/routes/session/composer/shell-tab.tsx:104 |  |
| S8 | a | `GET /api/skill` | 200 | 200 | yes | pass | yes | packages/client/src/solid/data.ts:2139, packages/tui/src/component/dialog-skill.tsx:26 | Autocomplete contributes nothing (`dialog-skill.tsx:26`). |
| S8 | a | `GET /api/vcs/diff` | 200 | 200 | yes | pass | - | packages/tui/src/feature-plugins/system/diff-viewer.tsx:163 |  |
| S8 | a | `GET /api/vcs` | 200 | 200 | yes | pass | - | packages/client/src/solid/data.ts:1485 |  |
| S8 | a | `GET /api/websearch/provider` | 200 | 200 | yes | no extracted schema | yes | packages/client/src/solid/data.ts:2134 | No provider list; no websearch entry (`data.ts:2134`). |
| S8 | a | `GET /api/worktree` | 200 | 200 | yes | pass | yes | packages/tui/src/component/dialog-open.tsx:122, packages/tui/src/component/dialog-workspaces.tsx:83 | Empty list renders "No worktrees available" (`dialog-open.tsx:122`); documented. |
| S8 | a | `POST /api/worktree/refresh` | 204 | 204 | yes | no extracted schema | - | packages/tui/src/component/dialog-open.tsx:133, packages/tui/src/component/dialog-workspaces.tsx:107 |  |

## Class (b) — empty answer flips a TUI branch

| Endpoint | Bridge answer | TUI gate | Consequence | Decision |
| --- | --- | --- | --- | --- |
| `GET /api/integration` | `200 {location, data: []}` | `packages/tui/src/component/use-connected.tsx:7` → `packages/tui/src/component/dialog-model.tsx:48-49`; also `packages/tui/src/feature-plugins/sidebar/footer.tsx:16-25` | `hasConnectedProvider([])` is false, so under `experimental["new-designs"]` `/models` opens the free-model/connect dialog instead of the model list; the sidebar shows the "Getting started" onboarding. | **Left + documented.** senpi has no integration registry; projecting fake credentials would be inventing data. `DEGRADATIONS.md` now names the `/models` consequence. |
| `GET /api/vcs/base` | `200 {location, data: null}` | `packages/tui/src/feature-plugins/system/diff-viewer.tsx:146-150`, `:191`, `:236` | "Base not reported"; the "Committed" diff source is disabled. | **Left + documented.** The bridge stub always nulls it; real base inference (reflog/upstream) is a follow-up with its own semantics. |
| `GET /api/experimental/usage/limits` | `200 {location, data: null}` | `packages/tui/src/component/usage.tsx:42`, `:96`, `:122` | `/usage` shows the signed-out copy and no budget warnings. | **Truthful, documented.** The bridge has no OpenCode Console workspace, so "not signed in" is the real state. |

The `persistentPty.list` empty list is **not** a gate: `/api/info` advertises `capabilities.persistentPty:false`, which hides every terminal control before the list is read (`packages/tui/src/context/session-terminals.tsx:70-73`).

## Class (c) — contract violations

Fixed on this branch:

- **12 unmounted endpoints** (`experimental.session.export`, `fs.read`, `vcs.status`, `vcs.branch`, `model.default`, `location.reload`, `plugin.check`, `plugin.update`, `rpc.call`, `session.generate`, `experimental.session.stats`, `DELETE /api/worktree`).
- **Status corrections** to a declared status: `server.pair`, `worktree.create`, `experimental.persistentPty.create`, `credential.*`, `integration.connect.key/external`, and the 501 missing-capability path of `session.update`/`session.fork`/`session.compact`.
- **`session.compact` success shape**: 204 → 200 `{data: Session.Inbox.Compaction}`.

Accepted + documented (no truthful data to serve):

- `experimental.session.stats` answers the declared `400 InvalidRequestError`; the bridge has no daily step/tool ledger, and zeros would claim the user ran nothing.
- `session.generate` answers the declared `400 InvalidRequestError`; the bridge has no transient-generation host command.
- `rpc.call` answers the declared `400 RpcError`; no plugin RPC is registered, which is exactly what `/goal` treats as "no goal plugin".

## Out of scope: CLI-only call sites

The fork's CLI calls 8 further endpoints. They are outside the TUI surface this audit and test cover, and all are currently unmounted: `POST /api/experimental/integration/wellknown`, `PUT /api/experimental/mcp/:server`, `POST /api/experimental/persistent-pty/shutdown`, `GET /api/experimental/job`, `GET /api/integration/:integrationID`, `GET /api/credential`, `POST /api/credential`, `POST /api/debug/heap-dump`. Treat them as a separate CLI-surface follow-up, not as TUI regressions.

## Pre-fix proof

```sh
# On e75a1bf (this branch's base): the mount check fails on the 12 unmounted endpoints.
git checkout e75a1bf
cp <this branch>/scripts/surface-extract.ts scripts/ && cp -R <this branch>/contracts/surface contracts/ && \
  cp <this branch>/test/http/surface.test.ts test/http/ && cp <this branch>/test/senpi/surface-harness.ts test/senpi/
bun test test/http/surface.test.ts   # "the router mounts every endpoint the TUI calls" lists the 12
# On 99d6499 (before fix/location): the same mount check lists GET /api/plugin.
```

Observed while writing this audit: at `99d6499` the mount check lists `GET /api/plugin` (plus the other
unmounted endpoints); at `e75a1bf` it lists the 12 endpoints above and the status sweep fails on
`credential.activate` (409). On this branch the same run is 102 pass / 0 fail.

## Reproduce

```sh
bun run scripts/surface-extract.ts      # regenerate contracts/surface/tui-endpoints.json
bun test test/http/surface.test.ts      # mount + status + schema sweep over the TUI surface
```
