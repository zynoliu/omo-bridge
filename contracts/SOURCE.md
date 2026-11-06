# Contract sources

Everything under `contracts/` is derived from a source of truth, never hand-invented. This file records
which source, at which revision, and by which rule.

## opencode (the my-tui TUI fork)

- Fork: `/Users/zyno/OmO Projects/my-tui/opencode` (read-only reference; never edited).
- Commit: `9937869a9d436f880b1536c103a4fbc567f82065` (`@opencode/protocol` 2.2.5).
- Extracted on: 2026-11-05, by `scripts/contracts-extract.ts`.
- Regenerate: `bun run scripts/contracts-extract.ts --write`.
- Verify: `bun run contracts:check` (fork drift, sample validation and senpi fixtures in one run).

Coverage now follows the route table in `src/http/routes/index.ts`: every route family the bridge
serves has at least one pinned schema, and every schema has a sample. The registry currently holds
80 endpoints: 44 response bodies and 36 event frames.

### Response schemas

| schema | source | pins |
| --- | --- | --- |
| `server.info` | `packages/protocol/src/groups/server.ts:5` | success body of GET /api/info |
| `error.envelope` | `packages/protocol/src/errors.ts:5` | tagged error envelope shared by every failing endpoint |
| `session.publicInfo` | `packages/protocol/src/groups/session.ts:45` | Session.Info with location narrowed to Location.PublicRef; session.list rows |
| `session.list` | `packages/protocol/src/groups/session.ts:128` | success body of GET /api/session (data + cursor) |
| `session.get` | `packages/protocol/src/groups/session.ts:45` | success body of GET /api/session/:sessionID |
| `session.create` | `packages/protocol/src/groups/session.ts:45` | success body of POST /api/session |
| `session.fork` | `packages/protocol/src/groups/session.ts:45` | success body of POST /api/session/:sessionID/fork |
| `session.active` | `packages/protocol/src/groups/session.ts:41` | success body of GET /api/session/active (session id -> running marker) |
| `session.messages` | `packages/protocol/src/groups/message.ts:105` | success body of GET /api/session/:sessionID/message |
| `session.message.get` | `packages/protocol/src/groups/message.ts:54` | success body of GET /api/session/:sessionID/message/:messageID |
| `session.inbox.list` | `packages/protocol/src/groups/session.ts:65` | success body of GET /api/session/:sessionID/inbox |
| `session.diff` | `packages/schema/src/file-diff.ts:6` | success body of GET /api/session/:sessionID/diff |
| `session.v1Info` | `packages/schema/src/v1/session.ts:534` | v1 session shape still served to older clients |
| `permission.request` | `packages/schema/src/permission.ts:36` | pending permission request |
| `permission.list` | `packages/schema/src/permission.ts:36` | success body of GET /api/session/:sessionID/permission |
| `form.info` | `packages/schema/src/form.ts:136` | pending form description |
| `form.list` | `packages/schema/src/form.ts:136` | success body of GET /api/form |
| `form.session.list` | `packages/schema/src/form.ts:136` | success body of GET /api/session/:sessionID/form |
| `model.info` | `packages/schema/src/model.ts:114` | success body rows of GET /api/model |
| `model.list` | `packages/schema/src/model.ts:114` | success body of GET /api/model |
| `agent.list` | `packages/schema/src/agent.ts:23` | success body of GET /api/agent |
| `command.list` | `packages/schema/src/command.ts:10` | success body of GET /api/command |
| `skill.list` | `packages/schema/src/skill.ts:27` | success body of GET /api/skill |
| `reference.list` | `packages/schema/src/reference.ts:33` | success body of GET /api/reference |
| `mcp.list` | `packages/schema/src/mcp.ts:91` | success body of GET /api/mcp |
| `mcp.resourceCatalog` | `packages/schema/src/mcp.ts:120` | success body of GET /api/mcp/resource |
| `integration.list` | `packages/schema/src/integration.ts:74` | success body of GET /api/integration |
| `plugin.list` | `packages/schema/src/plugin.ts:51` | success body of GET /api/plugin (empty: senpi has no plugin registry) |
| `fs.list` | `packages/schema/src/filesystem.ts:18` | success body of GET /api/fs/list |
| `fs.find` | `packages/schema/src/filesystem.ts:18` | success body of GET /api/fs/find |
| `location.publicInfo` | `packages/schema/src/location.ts:29` | success body of GET /api/location |
| `location.get` | `packages/schema/src/location.ts:29` | success body of GET /api/location |
| `project.list` | `packages/schema/src/project.ts:40` | success body of GET /api/project (a bare array, no location envelope) |
| `vcs.get` | `packages/schema/src/vcs.ts:12` | success body of GET /api/vcs |
| `vcs.base` | `packages/schema/src/vcs.ts:21` | success body of GET /api/vcs/base (null when no base is resolvable) |
| `vcs.diff` | `packages/schema/src/file-diff.ts:6` | success body of GET /api/vcs/diff |
| `config.get` | `packages/schema/src/config.ts:135` | success body of GET /api/config (a bare array, no location envelope) |
| `shell.list` | `packages/schema/src/shell.ts:41` | success body of GET /api/shell |
| `shell.get` | `packages/schema/src/shell.ts:41` | success body of GET /api/shell/:id |
| `shell.output` | `packages/schema/src/shell.ts:77` | success body of GET /api/shell/:id/output |
| `worktree.list` | `packages/schema/src/worktree.ts:35` | success body of GET /api/worktree (a bare array) |
| `persistentPty.list` | `packages/schema/src/persistent-pty.ts:9` | success body of GET /api/experimental/session/:sessionID/terminal |
| `migration.status` | `packages/protocol/src/groups/migration.ts:10` | success body of GET /api/experimental/migration/v1 |
| `usage.limits` | `packages/schema/src/usage-limits.ts:67` | success body of GET /api/experimental/usage/limits (data is null when signed out) |

### Event-frame schemas

The bridge publishes these types on `GET /api/event`. The fork declares the same types as
`Event.durable(...)`/`Event.ephemeral(...)` definitions in `packages/schema/src/session-event.ts`,
`server-event.ts`, `permission.ts` and `form.ts`; the extractor takes the `data` shape from the
`schema:` of that definition.

The modelled envelope is `{ id, type, created, data }`. That is the frame the TUI reads
(`packages/tui/src/context/event.ts` switches on `type` and reads `data`; the SSE parser in
`packages/client/src/promise/generated/client.ts` hands the parsed JSON through untouched). The
fork's durable events additionally carry a `durable` envelope, which the bridge does not emit, so
`durable`, `location` and `metadata` stay unmodelled (raised as absent-ok, never required).

| schema | source | pins |
| --- | --- | --- |
| `event.server.connected` | `packages/schema/src/server-event.ts:5` | first frame of every event stream |
| `event.session.execution.started` | `packages/schema/src/session-event.ts:245` | agent_start opened a run |
| `event.session.execution.succeeded` | `packages/schema/src/session-event.ts:248` | agent_end without failure or abort |
| `event.session.execution.failed` | `packages/schema/src/session-event.ts:251` | agent_end with a failure record |
| `event.session.execution.interrupted` | `packages/schema/src/session-event.ts:258` | agent_end with aborted=true |
| `event.session.step.started` | `packages/schema/src/session-event.ts:334` | assistant message opened (agent + model present) |
| `event.session.step.streamed` | `packages/schema/src/session-event.ts:350` | provider response boundary inside a run |
| `event.session.step.ended` | `packages/schema/src/session-event.ts:360` | assistant message closed with usage |
| `event.session.text.started` | `packages/schema/src/session-event.ts:397` | text block opened |
| `event.session.text.delta` | `packages/schema/src/session-event.ts:409` | text fragment (live only) |
| `event.session.text.ended` | `packages/schema/src/session-event.ts:420` | text block closed |
| `event.session.reasoning.started` | `packages/schema/src/session-event.ts:435` | reasoning block opened |
| `event.session.reasoning.delta` | `packages/schema/src/session-event.ts:448` | reasoning fragment (live only) |
| `event.session.reasoning.ended` | `packages/schema/src/session-event.ts:459` | reasoning block closed |
| `event.session.tool.input.started` | `packages/schema/src/session-event.ts:481` | tool call announced |
| `event.session.tool.input.delta` | `packages/schema/src/session-event.ts:492` | tool argument fragment (live only) |
| `event.session.tool.input.ended` | `packages/schema/src/session-event.ts:501` | tool arguments settled |
| `event.session.usage.updated` | `packages/schema/src/session-event.ts:172` | run usage totals |
| `event.session.compaction.started` | `packages/schema/src/session-event.ts:588` | compaction began |
| `event.session.shell.started` | `packages/schema/src/session-event.ts:311` | shell command registered |
| `event.session.shell.ended` | `packages/schema/src/session-event.ts:321` | shell command settled with its output page |
| `event.session.inbox.enqueued` | `packages/schema/src/session-event.ts:220` | queued input admitted |
| `event.session.inbox.cancelled` | `packages/schema/src/session-event.ts:230` | queued input cancelled |
| `event.session.inbox.delivery.changed` | `packages/schema/src/session-event.ts:237` | queued input delivery switched |
| `event.session.renamed` | `packages/schema/src/session-event.ts:92` | session title changed |
| `event.session.archived` | `packages/schema/src/session-event.ts:133` | session archived |
| `event.session.unarchived` | `packages/schema/src/session-event.ts:140` | session unarchived |
| `event.session.metadata.updated` | `packages/schema/src/session-event.ts:102` | session metadata replaced |
| `event.session.permissions` | `packages/schema/src/session-event.ts:112` | session permission ruleset replaced |
| `event.session.deleted` | `packages/schema/src/session-event.ts:182` | session deleted |
| `event.session.moved` | `packages/schema/src/session-event.ts:82` | session moved to another directory |
| `event.permission.asked` | `packages/schema/src/permission.ts:45` | permission prompt opened |
| `event.permission.replied` | `packages/schema/src/permission.ts:46` | permission prompt answered |
| `event.form.created` | `packages/schema/src/form.ts:173` | form prompt opened |
| `event.form.replied` | `packages/schema/src/form.ts:174` | form prompt answered |
| `event.form.cancelled` | `packages/schema/src/form.ts:175` | form prompt cancelled |

### Envelopes

Most endpoints answer inside an envelope the fork declares once. The extractor derives the wrapper
instead of repeating it: `{ data: T }`, `{ data: T[] }`, `{ data: Record<string, T> }`,
`{ location: Location.PublicRef }`, `{ location, data }`, `{ location, data: T[] }`,
`{ location, data: T | null }`, and a bare `T[]` for the routes that answer an array directly
(`project.list`, `config.get`, `worktree.list`). `Location.PublicRef` is itself derived from
`packages/schema/src/location.ts:14`, so a changed envelope fails the check too.

### Samples

Every endpoint has one sample of the body it serves under `contracts/opencode/samples/`:

- `<id>.json` for response bodies (one file per endpoint id).
- `events.jsonl` for event frames, one `{ "endpoint": "<type>", "frame": {...} }` record per line.

`bun run contracts:check` fails when a sample is missing, when a sample names an endpoint the
registry does not have, when the sample does not validate against the schema, and when an event
record's `frame.type` differs from its `endpoint`. The samples are the shape the handlers in
`src/http/handlers/` emit; when a handler changes the shape it serves, the sample must change with
it and the schema decides whether that change is allowed.

Deliberately covered by samples but not by the live handlers: nothing. `vcs.diff` used to emit
`{file, additions, deletions}` from `git diff --numstat`, which is missing the `patch` and `status`
that `FileDiff.Info` requires and the TUI renders
(`packages/tui/src/feature-plugins/system/diff-viewer.tsx:67-74`,
`packages/client/src/promise/generated/types.ts:71-77`); `handleVcsDiff` now parses the unified
`git diff` instead.

### Deliberately not covered

- `GET /api/provider` — the bridge answers `{id, name}` rows, but `Provider.Info`
  (`packages/schema/src/provider.ts:111`) requires `activation` and `package` as well. The TUI's
  provider rows are read for `id`/`name` only, so there is no client-required shape to pin yet; a
  `provider.summary` schema would pin a bridge-only invention. Tracked as a provider-catalog gap.
- `GET /api/permission/saved` — the TUI never consumes it (no client call site), and the bridge's
  `{sessionID, action, resource, savedAt}` rows are not `PermissionSaved.Info`
  (`{id, projectID, action, resource, time}`). Nothing the TUI reads can be pinned here.
- Session write bodies (`prompt`, `command`, `synthetic`, `compact`, `revert`, `view`, `environment`,
  `move`, `model`, `agent`) — their responses are admission/204 envelopes whose payload is senpi
  specific (or empty). `session.create`/`session.fork` are covered because they return
  `PublicSessionInfo`.
- Integration connect/credential/pair flows, persistent-pty snapshot/connect-token, media reads and
  the `session.log` SSE stream: degraded or streamed surfaces with no JSON body the TUI decodes.
- `session.compaction.ended` / `session.compaction.failed` events: their fork schemas reference
  sibling event definitions through `Started.data.fields.*`, which the extractor cannot resolve, and
  an unresolved leaf is a hard error rather than an accept-anything schema. Extending the extractor
  for that reference form is a follow-up; the bridge's emit sites are in `src/translate/lifecycle.ts`.

Known runtime gap the fixtures expose but the checker cannot: `session.step.started` requires
`agent` and `model`, and the TUI's mini transport dereferences `event.data.model.providerID`
(`packages/tui/src/mini/stream-v2.transport.ts:1092-1094`). The bridge always sends `agent` and sends
`model` only when senpi's `message_start` carried both an id and a provider
(`src/translate/stream.ts`), so a model-less host frame is a live gap. The sample pins the contract
that must hold; making the handler synthesise a model is a separate runtime decision.

### Extraction rules

`scripts/contracts-extract.ts` parses the fork's TypeScript with the TypeScript compiler API; it never imports
or executes fork code, never writes to the fork, and never needs the fork's dependencies.

1. Objects come from `Schema.Struct({...})`, `Schema.Class<T>("id")({...})` and `Schema.TaggedError<T>()(...)`.
   Properties are emitted in declaration order; a property is `required` unless it is wrapped in
   `Schema.optional(...)`, `optional(...)`, or piped through either marker (`.pipe(Schema.optional)`).
2. Spreads (`...X.fields`), `Struct.omit(...)` and `Struct.pick(...)` are resolved. An unresolvable spread is a
   hard error, so a shape can never silently lose fields.
3. `Schema.StructWithRest(struct, [rest])` is a struct plus an index signature: the struct contributes the
   named fields and the rest member contributes `additionalProperties` (never required fields).
4. References are followed across the fork's modules: `@opencode/schema/<name>` maps to
   `packages/schema/src/<name>.ts`, relative imports resolve in place, `export * as X from` is followed,
   `import { X } from "..."` may name such a namespace, and a re-exported binding (`export { X }` beside
   `import { X }`) resolves to the module that declares it. Declarations inside `namespace` blocks are
   visible for the schemas that share field fragments there (`ToolBase` in `session-event.ts`).
   Resolution stops at depth 8.
5. Leaves: `String`/`AbsolutePath`/`RelativePath`/`DateTimeUtcFromMillis` -> `string`, `Int`/`NonNegativeInt`/
   `PositiveInt` -> `integer` (with `minimum`), `Finite`/`Number` -> `number`, `Boolean`, `Unknown`/`Any`/`Json`
   -> `{}`, `Literal`/`tag` -> `const`, `Literals` -> `enum`, `Union`/`NullOr` -> `anyOf` (or `enum` when every
   member is a literal), `Array`/`NonEmptyArray` -> `array` (`minItems: 1` for non-empty),
   `Record` -> `object` with `additionalProperties`, `TemplateLiteral`/`Trim`/`DurationFromString` -> `string`,
   `UndefinedOr` -> the inner schema.
6. Not modelled on purpose: `.check(...)` constraints (a branded ID stays a plain `string`), `.brand(...)`,
   `.mapFields(...)` refinements (the declared field requiredness is used), `decodeTo`/`encodeTo` codecs (the
   declared side is used), `Schema.Json` payloads (kept open), and `Schema.Class` methods. These are
   wire-value compatible, not semantic validators.
7. `error.envelope` is generated from the tagged-error classes: every class must declare a required
   `message` field (the extraction fails otherwise), the envelope requires `_tag` and `message`, allows any
   extra error-specific field, and lists every declared tag in its `$comment` so a rename or removal is drift.
8. Event endpoints are `Event.durable(...)`/`Event.ephemeral(...)` definitions located by their `type`
   literal; the frame envelope is `{id, type, created, data}` and `data` is the definition's `schema:`.
9. Every generated struct is closed: a `Schema.Struct`/`Schema.Class` emits `additionalProperties: false`, and so
   does each response envelope (`{data}`, `{location, data}`, ...) and the event frame. The only objects that stay
   open are the ones a declaration opens — `Record(...)`, `StructWithRest(...)` and the `error.envelope` in rule 7.
   Sample validation therefore rejects a body that grows a field no declaration names, and `test/contract`
   stamps one undeclared key onto every endpoint's sample to prove it.
   This strictness found two bridge responses that served undeclared fields, and both were corrected on the
   response side rather than exempted: an enveloped `location` is `Location.PublicRef` (`{directory}` only — the
   project belongs to the bare `Location.PublicInfo` of `GET /api/location`), and a `fs.list`/`fs.find` entry is
   `FileSystem.Entry` (`{path, type}` only).
9. An unresolved reference is a hard error: `deriveSchemas()` walks every derived schema and fails on any
   `$comment` beginning with `unresolved:`. A leaf that silently degrades to `{}` would accept every value
   and turn the assertion into a no-op.

Drift policy: a fork change to a field name, type, optionality, or tag list fails `bun run contracts:check`
with the exact JSON path. The fix is to re-run `--write`, read the diff, and decide whether the bridge or the
contract needs the change.

## senpi (the runtime behind `omo --mode rpc`)

- Pinned package: `@code-yeongyu/senpi` `2026.11.4-2` (`package.json`). Its `docs/rpc.md` is the normative
  wire reference at that version.
- Live recording host: `/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo`, reporting
  `omo 5.1.60 (engine: senpi 2026.11.2-3)`. The hosted engine is one CalVer release behind the pinned package;
  frames were recorded from the host that actually runs today, and every shape used is present in the pinned
  package's `docs/rpc.md` as well. Treat this as a known version skew, not a guarantee.
- Recorded on: 2026-11-05, by `scripts/contracts-record.ts`.
- Regenerate: `bun run scripts/contracts-record.ts` (spawns the host, records, cleans up).
- Verify: `bun run scripts/contracts-check.ts`.

### What is recorded live vs derived

`contracts/senpi/live.jsonl` holds frames produced by a real host: the request that was sent and the
`type: "response"` frame it answered, for `get_protocol_info`, `list_sessions`, `open_session`, `get_state`,
`get_entries`, and `close_session`. The host runs with `--multi-session` over stdio, a throwaway working
directory and a throwaway `OMO_CODING_AGENT_DIR`; no prompt is ever sent, so no model is called.

`contracts/senpi/events.jsonl` holds event frames taken from `node_modules/@code-yeongyu/senpi/docs/rpc.md`
examples. They are marked `"source": "derived"`; the exact doc line for each frame, and the one deliberate
completion we added (a full `usage` object instead of the doc's `{...}` placeholder), are listed in
`contracts/senpi/DERIVED.md`.

Recording rules:

1. Only JSONL records separated by LF. A record is `{"frame": <wire frame>, "role": "request"|"response"|"event",
   "endpoint": "<command or event type>", "source": "live"|"derived"}` plus optional `"derivedFrom"`.
2. Live frames are scrubbed of ephemeral paths: the throwaway root becomes `<tmp>`. IDs, timestamps and
   versions stay as the host reported them.
3. Request frames are evidence, not a schema; `validateResponse` checks response frames by `command` and
   `validateEvent` checks event frames by `type`.
4. Never record a frame that implies a model call. `message_update`, `agent_*`, `tool_execution_*` and
   `queue_update` cannot be produced without a model turn, which is why they are derived from documentation.
5. The plan asked for "all 8 delta kinds"; `docs/rpc.md` and the pinned package's
   `@earendil-works/pi-ai` types both define nine block-level kinds (`text_start/delta/end`,
   `thinking_start/delta/end`, `toolcall_start/delta/end`). All nine are shipped.

## Environment overrides

| variable | used by | meaning |
| --- | --- | --- |
| `OMO_BRIDGE_OPENCODE_FORK` | extract | fork path to parse (default: the my-tui fork above) |
| `OMO_BRIDGE_CONTRACTS_OPENCODE_DIR` | extract, validate, check | schema directory to write, compare or load |
| `OMO_BRIDGE_CONTRACTS_SAMPLE_DIR` | check | sample directory (defaults to `<opencode dir>/samples`) |
| `OMO_BRIDGE_CONTRACTS_SENPI_DIR` | check | fixture directory to validate |
| `OMO_BRIDGE_OMO_BIN` | record | host binary to spawn |
