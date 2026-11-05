# Degradations

The bridge only serves what senpi can back. The endpoint families below have no senpi capability; they are
answered by shims so the TUI degrades visibly instead of breaking. Every shim answers JSON with the declared
error envelope (or `204 NoContent`), and none of them answers 5xx. The one path with no shim,
`DELETE /api/worktree`, is refused by the router with `405 MethodNotAllowedError` before any handler runs.

Graded rule (`src/http/handlers/degraded.ts`):

- read-only family -> contract-valid empty value (`[]` / `null`);
- idempotent write with no state to change -> `204 NoContent`;
- write that would change state the user can see -> the endpoint's declared error `_tag`.

Catalog families that already had no senpi capability are answered by `src/http/handlers/catalogs.ts`, except
`GET /api/form`, which lives in `src/http/handlers/form.ts` and is re-exported there. They are listed here for
completeness, not duplicated in `degraded.ts`. `GET /api/session/:sessionID/diff` is answered by
`src/http/handlers/sessions.ts` and is listed here for the same reason.

Tests: `bun test test/http/degraded.test.ts` asserts every status and `_tag`, plus a sweep over all handlers that
fails on any 5xx. TUI references are relative to `/Users/zyno/OmO Projects/my-tui/opencode`.

| Endpoint(s) | Degraded answer | TUI behaviour | Why | Follow-up: senpi would need to expose |
| --- | --- | --- | --- | --- |
| `GET /api/worktree` | `200 []` (`Worktree.List` is a bare array) | Workspaces / Open dialogs render the empty list ("No worktrees available" / "No worktrees found"), no toast, `packages/tui/src/component/dialog-open.tsx:122`, `packages/tui/src/component/dialog-workspaces.tsx:83`, `:357`, `:363` | The bridge has no checkout manager; a senpi session is bound to one cwd, not to a worktree set | A worktree/checkout inventory per project (list, create, remove, refresh events) |
| `POST /api/worktree/refresh` | `204 NoContent` | Fire-and-forget after a list; failures are already swallowed, `packages/tui/src/component/dialog-open.tsx:133`, `packages/tui/src/component/dialog-workspaces.tsx:107` | Discovery has no state to reconcile, so the request is an idempotent no-op | Worktree discovery (git worktree scan/config strategy) |
| `POST /api/worktree` | `409 {_tag:"WorktreeError", message}` | Create flow fails loudly: toast "Creating workspace failed" with the message instead of a fake directory, `packages/tui/src/component/prompt/move.tsx:41`, `:59` | Creating a worktree changes user-visible state; a success answer would make the TUI open a session in a directory that does not exist | Worktree creation with branch/from/setup-script semantics, returning `{directory}` |
| `DELETE /api/worktree` (remove) | not a shim: the router answers `405 {_tag:"MethodNotAllowedError"}`, allow `POST` | Delete in the Workspaces dialog shows "Failed to delete worktree" (`packages/tui/src/component/dialog-workspaces.tsx:244`, `:296`; the forced retry toasts at `:282`) | Same missing capability, and the plan's endpoint inventory did not include remove, so no shim was added. `POST /api/worktree` matches the same path, so the router rejects DELETE with 405 rather than a route-missing 404 | Worktree removal with `forceRequired` reporting |
| `GET /api/experimental/session/:sessionID/terminal` | `200 {data:[]}` | Capability gate already hides terminal panes: `capabilities.persistentPty:false` in `/api/info` -> `available=false`, `packages/tui/src/context/session-terminals.tsx:73`; list is only called when available, `:37` | senpi has no PTY service; the empty list matches the declared `{data: PersistentPty.Info[]}` shape | A persistent PTY/terminal service with attach, snapshot and event stream |
| `POST /api/experimental/session/:sessionID/terminal` | `409 {_tag:"ServiceUnavailableError"}` | New-terminal only runs when the capability is on; a direct call surfaces the error instead of a phantom terminal, `packages/tui/src/context/session-terminals.tsx:104` | `ServiceUnavailableError` is the endpoint's declared error; 409 keeps it out of the 5xx band | Persistent PTY creation |
| `GET /api/experimental/persistent-pty/:ptyID/snapshot`, `GET .../connect` | `404 {_tag:"PtyNotFoundError", ptyID}` | Terminal pane shows its connect failure; both paths are hidden behind the capability gate, `packages/tui/src/component/terminal-pane.tsx:182`; `connect` is the attach call, `packages/client/src/solid/pty.ts:65` | No terminal can exist, so the declared not-found error is the truthful answer | PTY snapshot/text/checkpoint and attach |
| `POST /api/experimental/persistent-pty/:ptyID/connect-token` | `404 {_tag:"PtyNotFoundError", ptyID}` | Only reached through `client.persistentPty.connect`, `packages/tui/src/component/terminal-pane.tsx:189` -> `packages/client/src/solid/pty.ts:65` | There is no ticket to issue for a terminal that cannot exist | Connect-token issuance and WebSocket attach |
| `GET /api/experimental/migration/v1` | `200 {status:"completed"}` | Overlay stays closed: the poll loop returns on `completed` and only renders on `running`, `packages/tui/src/component/migration-overlay.tsx:22` | The bridge starts from an empty state directory; there is no V1 history to migrate | (none) keep answering `completed`; a real migration only matters if V1 data is ever imported |
| `GET /api/session/:sessionID/diff` | `200 {data:[]}` (sessions.ts) | The "Last turn" source renders no files, exactly like a turn that changed nothing; only a request error would say "Diff unavailable", `packages/tui/src/feature-plugins/system/diff-viewer.tsx:84`, `:147-152`, `:185` | The endpoint answers a turn's diff by comparing the snapshot recorded before that turn with the one after it (`packages/protocol/src/groups/session.ts:535`); senpi records no per-turn file snapshots. The bridge's own `vcs.diff` is the working tree against HEAD, a different range: serving it here would label uncommitted changes as one turn's work | Per-turn file snapshots and a range diff over them |
| `GET /api/integration` | `200 {location, data:[]}` (catalogs.ts) | Integrations dialog shows "No integrations available", `packages/tui/src/component/dialog-integration.tsx:109`, `:161`; model picker / onboarding treat nothing as connected, `packages/tui/src/component/use-connected.tsx:7` | senpi has no provider integration registry | An integration registry with auth methods and connections |
| `POST /api/integration/:id/connect/key`, `.../connect/external` | `409 {_tag:"IntegrationNotFoundError", integrationID}` | Key flow shows the error inline; external flow shows a toast, `packages/tui/src/component/dialog-integration.tsx:568`, `:372` | Connecting stores a credential and flips the integration to connected; a 204 would be a fake state change | Key/external credential connect |
| `POST /api/integration/:id/connect/oauth` | `404 {_tag:"IntegrationAttemptNotFoundError", integrationID, attemptID:""}` | OAuth flow shows a toast and clears the dialog, `packages/tui/src/component/dialog-integration.tsx:617`, `packages/tui/src/component/dialog-go-upsell.tsx:332` | No attempt can be started, so there is no attempt id or authorization URL to return | OAuth attempt creation (authorization URL/instructions) |
| `GET .../connect/oauth/:attemptID`, `POST .../oauth/:attemptID/complete` | `404 {_tag:"IntegrationAttemptNotFoundError", integrationID, attemptID}` | Poll/complete error paths toast the message, `packages/tui/src/component/dialog-integration.tsx:698`, `:780`, `packages/tui/src/component/dialog-go-upsell.tsx:285` | The attempt never existed | OAuth attempt status and code completion |
| `DELETE .../connect/oauth/:attemptID` | `204 NoContent` | Cleanup on dialog close is fire-and-forget, `packages/tui/src/component/dialog-integration.tsx:729`, `:766`, `packages/tui/src/component/dialog-go-upsell.tsx:336`, `:377` | Cancelling an attempt that cannot exist is an idempotent no-op, not a failed state change (listed as a 204 operation in the plan's D3 rule) | OAuth attempt cancellation |
| `POST .../connect/command`, `GET .../command/:attemptID`, `DELETE .../command/:attemptID` | `404 {_tag:"IntegrationAttemptNotFoundError", integrationID, attemptID}` | Command flow toasts the error at connect/status; cancel is unreachable because no attempt starts, `packages/tui/src/component/dialog-integration.tsx:423`, `:478`, `:431`, `:513` | No command attempt can be started | Command-based auth attempt runner |
| `POST /api/credential/:credentialID/activate`, `PATCH /api/credential/:credentialID`, `DELETE /api/credential/:credentialID` | `409 {_tag:"InvalidRequestError", kind:"unsupported"}` | Activate/rename/delete show an error toast; the dialog does not pretend the credential changed, `packages/tui/src/component/dialog-integration.tsx:232`, `:254`, `:271` | The bridge stores no credentials; a 204 would silently fake a credential switch | Credential storage with active-credential selection |
| `POST /api/pair` | `409 {_tag:"InvalidRequestError", kind:"unsupported"}` | Pair dialog fails as a whole ("Could not load server information" + message) instead of rendering links with no code, `packages/tui/src/component/dialog-pair.tsx:22`, `:114` | Pairing exists to hand a browser the server password; the bridge is attached through `--server` with Basic auth, so there is no pairing code or `/auth/connect/:code` session to create | Pairing-code issuance and session-token redemption |
| `GET /api/experimental/usage/limits` | `200 {location, data:null}` | `/usage` shows the signed-out copy ("Sign in to OpenCode Console with /connect…") and no budget warnings, `packages/tui/src/component/usage.tsx:37`, `:122`, `:125` | senpi has no OpenCode Console workspace, so the location is not signed in; `null` is part of the endpoint's declared success type | Console workspace budgets / Go allowance reporting |
| `POST /api/experimental/mcp/:server/connect`, `.../disconnect` | `204 NoContent` | Nothing to toggle: the MCP list is always empty, so no row is rendered, `packages/tui/src/component/dialog-mcp.tsx:46`, `:124` | With zero servers the toggle is a request with nothing to start or stop (the plan's D3 rule treats it as accepted-and-idempotent) | MCP server registry, connect/disconnect lifecycle and events |
| `GET /api/mcp`, `GET /api/mcp/resource` | `200 {location, data:[]}` / `200 {location, data:{resources:[],templates:[]}}` (catalogs.ts) | MCP dialog/list and devtools resource rows are empty, `packages/tui/src/component/dialog-mcp.tsx:46`, `packages/tui/src/component/devtools-bar.tsx:204` | No MCP servers or resource catalog exist | MCP server and resource listing |
| `GET /api/plugin` | `200 {location, data:[]}` (catalogs.ts) | Startup inventory is empty, so `/plugins` lists only the builtins and the home footer's failed counter stays at 0, `packages/tui/src/plugin/context.tsx:540`, `packages/tui/src/feature-plugins/system/plugins.tsx:36`, `packages/tui/src/feature-plugins/home/footer.tsx:59` | senpi has no server plugin registry: it loads no package or local plugins, so the empty inventory is the truthful answer instead of the 404 the TUI hit at startup | A plugin registry with per-plugin source/features/state and `plugin.updated` events |
| `GET /api/permission/saved` | `200 {location, data:[...records]}` (catalogs.ts; the declared body is `{data:[]}`) | The client stores whatever rules exist, which is empty until a reply picks "always" (`packages/client/src/solid/data.ts:2030`; no direct `tui/src` reader) | senpi approvals are per-request. The bridge records "always" replies in its in-memory saved store (`src/http/handlers/permission.ts:57`, `:436`), so this list reflects bridge-local state, not a senpi store | Saved permission persistence with `PATCH` and `DELETE /api/permission/saved/:id`, neither mounted today |
| `GET /api/form` | `200 {location, data:[...pending forms]}` (form.ts, re-exported through catalogs.ts) | Home shows no pending forms unless an engine frame filed one: `packages/tui/src/routes/home.tsx:38`, `packages/tui/src/routes/session/index.tsx:215` | Forms are session-scoped interaction requests. A fresh bridge has none; a question or dialog frame that arrives over the event stream is listed here until it is answered or cancelled | None: this path is already state-backed from `extension_ui_request` frames, not a degraded empty |
| `GET /api/agent` | `200 {location, data:[build]}` (catalogs.ts) | The agent picker lists the single Build agent, primary and visible, whose id is the one every projected message carries, `packages/tui/src/context/local.tsx:60` | senpi has no agent registry and no per-session agent switch, so the bridge projects the one agent it models. An empty list would read as "no agent available" instead of "this is the agent every turn ran as" | An agent registry with per-session selection and agent events |
| `GET /api/skill`, `/api/reference`, `/api/websearch/provider` | `200 {location, data:[]}` (catalogs.ts) | Skill and reference autocomplete contribute nothing, and the websearch provider list is empty, `packages/tui/src/component/dialog-skill.tsx:26`, `packages/tui/src/component/prompt/autocomplete.tsx:293`, `packages/client/src/solid/data.ts:2134` (websearch has no direct `tui/src` reader) | senpi has no skill discovery, reference store or search-provider registry | Skill/reference/search-provider catalogs |

## Session usage totals

`cost` and `tokens` on `GET /api/session` and `GET /api/session/:id` are cumulative over the session's
executions. The host's own transcript is the authority: the map sums the `usage` of every assistant
message in the session file (the `cost.total`, `input`, `output`, `reasoning`, `cacheRead` and
`cacheWrite` fields). It seeds that total when a session is adopted (startup, create, fork, re-list)
and re-reads it when `session.usage.updated` arrives, because senpi persists an assistant message
before its `message_end` frame and therefore before the run's `agent_end` total. A session with no
readable transcript is the exception: the bridge adds the event's total to its record and persists it.
The re-read is also what keeps a reconnect from double counting: a seed replaces the aggregate
instead of being added to it, and a seed that has not caught up with the live total is ignored rather
than added. `list_sessions` carries no totals, so the transcript is the only host-provided seed.

When the transcript has no assistant usage (a provider that reports none) or the file cannot be read,
the bridge keeps the last total the event stream reported and otherwise answers the contract's zero.
It never estimates cost or invents token counts: a zero on this surface means "senpi reported no
usage for this session", not "free". The same zero applies to a row the session map has not adopted
(for example a listing row read before the startup seed ran).

## Deliberate status choices

Upstream declares some of these errors at different statuses. The bridge keeps the declared `_tag` and message
(the TUI renders `error.message`) but chooses statuses that keep the degradation surface out of 5xx:

- `worktree.create` -> `409` (upstream `WorktreeError` is 400).
- `integration.*.connect` -> `409` (upstream `IntegrationNotFoundError` is 404).
- `persistentPty.create` -> `409 ServiceUnavailableError` (upstream declares 503). A 503 would trip the
  no-5xx sweep and make a permanent capability gap look like an outage.
- `integration.oauth.cancel` -> `204` rather than the `404` shorthand for `oauth.*`: it is an idempotent
  cancellation of an attempt that never existed, and the plan's D3 rule lists it as a no-op write.

## Known gaps outside this lane

- `DELETE /api/worktree` (remove) has no shim. `POST /api/worktree` owns the path, so the router answers
  405 `MethodNotAllowedError` and the TUI shows its failure toast. A real remove needs `forceRequired`
  reporting.
- `GET /api/permission/saved` is answered by `catalogs.ts` with an extra `location` field. The TUI client
  reads `data` and ignores the extra field, but the routes lane should either drop `location` there or move
  the handler next to the other degradation shims. The companion `PATCH` and `DELETE /api/permission/saved/:id`
  routes are not mounted, so a saved rule can be listed but not edited or removed.
- Route mounting now lives in `src/http/routes/index.ts`; this file is the ledger for what each path answers.
