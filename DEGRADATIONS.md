# Degradations

The bridge only serves what senpi can back. The endpoint families below have no senpi capability; they are
answered by shims so the TUI degrades visibly instead of breaking. Every shim answers JSON with the declared
error envelope (or `204 NoContent`), and none of them answers 5xx.

Graded rule (`src/http/handlers/degraded.ts`):

- read-only family -> contract-valid empty value (`[]` / `null`);
- idempotent write with no state to change -> `204 NoContent`;
- write that would change state the user can see -> the endpoint's declared error `_tag`.

Catalog families that already had no senpi capability are answered by `src/http/handlers/catalogs.ts` and are
listed here for completeness, not duplicated in `degraded.ts`.

Tests: `bun test test/http/degraded.test.ts` asserts every status and `_tag`, plus a sweep over all handlers that
fails on any 5xx. TUI references are relative to `/Users/zyno/OmO Projects/my-tui/opencode`.

| Endpoint(s) | Degraded answer | TUI behaviour | Why | Follow-up: senpi would need to expose |
| --- | --- | --- | --- | --- |
| `GET /api/worktree` | `200 []` (`Worktree.List` is a bare array) | Workspaces / Open dialogs render the empty list ("No worktrees available" / "No worktrees found"), no toast — `packages/tui/src/component/dialog-open.tsx:122`, `packages/tui/src/component/dialog-workspaces.tsx:83`, `:357`, `:363` | The bridge has no checkout manager; a senpi session is bound to one cwd, not to a worktree set | A worktree/checkout inventory per project (list, create, remove, refresh events) |
| `POST /api/worktree/refresh` | `204 NoContent` | Fire-and-forget after a list; failures are already swallowed — `packages/tui/src/component/dialog-open.tsx:133`, `packages/tui/src/component/dialog-workspaces.tsx:107` | Discovery has no state to reconcile, so the request is an idempotent no-op | Worktree discovery (git worktree scan/config strategy) |
| `POST /api/worktree` | `409 {_tag:"WorktreeError", message}` | Create flow fails loudly: toast "Creating workspace failed" with the message instead of a fake directory — `packages/tui/src/component/prompt/move.tsx:41`, `:59` | Creating a worktree changes user-visible state; a success answer would make the TUI open a session in a directory that does not exist | Worktree creation with branch/from/setup-script semantics, returning `{directory}` |
| `DELETE /api/worktree` (remove) | not served by this lane; the router answers `404 NotFoundError` | Delete in the Workspaces dialog shows "Failed to delete worktree" — `packages/tui/src/component/dialog-workspaces.tsx:244` | Same missing capability; the plan's endpoint inventory did not include remove, so no shim was added here | Worktree removal with `forceRequired` reporting |
| `GET /api/experimental/session/:sessionID/terminal` | `200 {data:[]}` | Capability gate already hides terminal panes: `capabilities.persistentPty:false` in `/api/info` -> `available=false` — `packages/tui/src/context/session-terminals.tsx:73`; list is only called when available — `:37` | senpi has no PTY service; the empty list matches the declared `{data: PersistentPty.Info[]}` shape | A persistent PTY/terminal service with attach, snapshot and event stream |
| `POST /api/experimental/session/:sessionID/terminal` | `409 {_tag:"ServiceUnavailableError"}` | New-terminal only runs when the capability is on; a direct call surfaces the error instead of a phantom terminal — `packages/tui/src/context/session-terminals.tsx:104` | `ServiceUnavailableError` is the endpoint's declared error; 409 keeps it out of the 5xx band | Persistent PTY creation |
| `GET /api/experimental/persistent-pty/:ptyID/snapshot` | `404 {_tag:"PtyNotFoundError", ptyID}` | Terminal pane shows its connect failure; hidden behind the capability gate — `packages/tui/src/component/terminal-pane.tsx:182` | No terminal can exist, so the declared not-found error is the truthful answer | PTY snapshot/text/checkpoint |
| `POST /api/experimental/persistent-pty/:ptyID/connect-token` | `404 {_tag:"PtyNotFoundError", ptyID}` | Only reached through `client.persistentPty.connect` — `packages/tui/src/component/terminal-pane.tsx:189` -> `packages/client/src/solid/pty.ts:65` | There is no ticket to issue for a terminal that cannot exist | Connect-token issuance and WebSocket attach |
| `GET /api/experimental/migration/v1` | `200 {status:"completed"}` | Overlay stays closed: the poll loop returns on `completed` and only renders on `running` — `packages/tui/src/component/migration-overlay.tsx:22` | The bridge starts from an empty state directory; there is no V1 history to migrate | (none) keep answering `completed`; a real migration only matters if V1 data is ever imported |
| `GET /api/integration` | `200 {location, data:[]}` (catalogs.ts) | Integrations dialog shows "No integrations available" — `packages/tui/src/component/dialog-integration.tsx:109`, `:161`; model picker / onboarding treat nothing as connected — `packages/tui/src/component/use-connected.tsx:7` | senpi has no provider integration registry | An integration registry with auth methods and connections |
| `POST /api/integration/:id/connect/key`, `.../connect/external` | `409 {_tag:"IntegrationNotFoundError", integrationID}` | Key flow shows the error inline; external flow shows a toast — `packages/tui/src/component/dialog-integration.tsx:568`, `:372` | Connecting stores a credential and flips the integration to connected; a 204 would be a fake state change | Key/external credential connect |
| `POST /api/integration/:id/connect/oauth` | `404 {_tag:"IntegrationAttemptNotFoundError", integrationID, attemptID:""}` | OAuth flow shows a toast and clears the dialog — `packages/tui/src/component/dialog-integration.tsx:617`, `packages/tui/src/component/dialog-go-upsell.tsx:332` | No attempt can be started, so there is no attempt id or authorization URL to return | OAuth attempt creation (authorization URL/instructions) |
| `GET .../connect/oauth/:attemptID`, `POST .../oauth/:attemptID/complete` | `404 {_tag:"IntegrationAttemptNotFoundError", integrationID, attemptID}` | Poll/complete error paths toast the message — `packages/tui/src/component/dialog-integration.tsx:698`, `:780`, `packages/tui/src/component/dialog-go-upsell.tsx:285` | The attempt never existed | OAuth attempt status and code completion |
| `DELETE .../connect/oauth/:attemptID` | `204 NoContent` | Cleanup on dialog close is fire-and-forget — `packages/tui/src/component/dialog-integration.tsx:729`, `:766`, `packages/tui/src/component/dialog-go-upsell.tsx:336`, `:377` | Cancelling an attempt that cannot exist is an idempotent no-op, not a failed state change (listed as a 204 operation in the plan's D3 rule) | OAuth attempt cancellation |
| `POST .../connect/command`, `GET .../command/:attemptID`, `DELETE .../command/:attemptID` | `404 {_tag:"IntegrationAttemptNotFoundError", integrationID, attemptID}` | Command flow toasts the error at connect/status; cancel is unreachable because no attempt starts — `packages/tui/src/component/dialog-integration.tsx:423`, `:478`, `:431`, `:513` | No command attempt can be started | Command-based auth attempt runner |
| `POST /api/credential/:credentialID/activate`, `PATCH /api/credential/:credentialID`, `DELETE /api/credential/:credentialID` | `409 {_tag:"InvalidRequestError", kind:"unsupported"}` | Activate/rename/delete show an error toast; the dialog does not pretend the credential changed — `packages/tui/src/component/dialog-integration.tsx:232`, `:254`, `:271` | The bridge stores no credentials; a 204 would silently fake a credential switch | Credential storage with active-credential selection |
| `POST /api/pair` | `409 {_tag:"InvalidRequestError", kind:"unsupported"}` | Pair dialog fails as a whole ("Could not load server information" + message) instead of rendering links with no code — `packages/tui/src/component/dialog-pair.tsx:22`, `:114` | Pairing exists to hand a browser the server password; the bridge is attached through `--server` with Basic auth, so there is no pairing code or `/auth/connect/:code` session to create | Pairing-code issuance and session-token redemption |
| `GET /api/experimental/usage/limits` | `200 {location, data:null}` | `/usage` shows the signed-out copy ("Sign in to OpenCode Console with /connect…") and no budget warnings — `packages/tui/src/component/usage.tsx:37`, `:122`, `:125` | senpi has no OpenCode Console workspace, so the location is not signed in; `null` is part of the endpoint's declared success type | Console workspace budgets / Go allowance reporting |
| `POST /api/experimental/mcp/:server/connect`, `.../disconnect` | `204 NoContent` | Nothing to toggle: the MCP list is always empty, so no row is rendered — `packages/tui/src/component/dialog-mcp.tsx:46`, `:124` | With zero servers the toggle is a request with nothing to start or stop (the plan's D3 rule treats it as accepted-and-idempotent) | MCP server registry, connect/disconnect lifecycle and events |
| `GET /api/mcp`, `GET /api/mcp/resource` | `200 {location, data:[]}` / `200 {location, data:{resources:[],templates:[]}}` (catalogs.ts) | MCP dialog/list and devtools resource rows are empty — `packages/tui/src/component/dialog-mcp.tsx:46`, `packages/tui/src/component/devtools-bar.tsx:204` | No MCP servers or resource catalog exist | MCP server and resource listing |
| `GET /api/permission/saved` | `200 {location, data:[]}` (catalogs.ts; the endpoint's declared body is `{data:[]}`) | No saved permission rows are synced; the client stores the empty list — `packages/client/src/solid/data.ts:2030` (no direct `tui/src` reader) | senpi approvals are per-request; there is no saved-permission store | Saved permission persistence (`PermissionSaved.Info`) |
| `GET /api/form` | `200 {location, data:[]}` (catalogs.ts) | Home and session routes render no pending forms — `packages/tui/src/routes/home.tsx:38`, `packages/tui/src/routes/session/index.tsx:215` | Forms are session-scoped interaction requests; there are none without a live request | Location-level pending forms |
| `GET /api/agent`, `/api/skill`, `/api/reference`, `/api/websearch/provider` | `200 {location, data:[]}` (catalogs.ts) | Agent picker is empty, skill/reference autocomplete contributes nothing, websearch provider list is empty — `packages/tui/src/context/local.tsx:60`, `packages/tui/src/component/dialog-skill.tsx:26`, `packages/tui/src/component/prompt/autocomplete.tsx:293`, `packages/client/src/solid/data.ts:2134` (websearch has no direct `tui/src` reader) | senpi reports models and slash commands only; it has no agent registry, skill discovery, reference store or search-provider registry | Agent/skill/reference/websearch-provider catalogs |

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

- `DELETE /api/worktree` (remove) has no shim; see the worktree row above.
- `GET /api/permission/saved` is answered by `catalogs.ts` with an extra `location` field. The TUI client reads
  `data` and ignores the extra field, but the routes lane should either drop `location` there or move the
  handler next to the other degradation shims.
- Route mounting for these handlers is a separate change; this file is the ledger for what each path answers.
