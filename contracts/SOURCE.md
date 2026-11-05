# Contract sources

Everything under `contracts/` is derived from a source of truth, never hand-invented. This file records
which source, at which revision, and by which rule.

## opencode (the my-tui TUI fork)

- Fork: `/Users/zyno/OmO Projects/my-tui/opencode` (read-only reference; never edited).
- Commit: `9937869a9d436f880b1536c103a4fbc567f82065` (`@opencode/protocol` 2.2.5).
- Extracted on: 2026-11-05, by `scripts/contracts-extract.ts`.
- Regenerate: `bun run scripts/contracts-extract.ts --write`.
- Verify: `bun run scripts/contracts-extract.ts` (default mode compares the fork against the checked-in files).

| schema | endpoint id | source |
| --- | --- | --- |
| `server.info.json` | `server.info` | `packages/protocol/src/groups/server.ts:5` (`ServerInfo`) |
| `session.publicInfo.json` | `session.publicInfo` | `packages/protocol/src/groups/session.ts:45` (`PublicSessionInfo`, annotated `Session.Info`) |
| `session.v1Info.json` | `session.v1Info` | `packages/schema/src/v1/session.ts:534` (`SessionInfo`) |
| `session.messages.json` | `session.messages` | `packages/protocol/src/groups/message.ts:105` (`SessionMessagesResponse`) |
| `permission.request.json` | `permission.request` | `packages/schema/src/permission.ts:36` (`Request`) |
| `form.info.json` | `form.info` | `packages/schema/src/form.ts:136` (`Info`) |
| `location.publicInfo.json` | `location.publicInfo` | `packages/schema/src/location.ts:29` (`PublicInfo`) |
| `error.envelope.json` | `error.envelope` | `packages/protocol/src/errors.ts:5` (every `Schema.TaggedError`) |

Each schema carries its own `description` with the source `file:line` it was derived from. Line numbers are
informational: the drift comparison ignores only the top-level `description` (a moved declaration must not fail
the check), while nested descriptions that are real data fields are compared like any other key, as are all
other top-level keys including `$comment` and `required`.

### Extraction rules

`scripts/contracts-extract.ts` parses the fork's TypeScript with the TypeScript compiler API; it never imports
or executes fork code, never writes to the fork, and never needs the fork's dependencies.

1. Objects come from `Schema.Struct({...})`, `Schema.Class<T>("id")({...})` and `Schema.TaggedError<T>()(...)`.
   Properties are emitted in declaration order; a property is `required` unless it is wrapped in
   `Schema.optional(...)`, `optional(...)`, or piped through either marker (`.pipe(Schema.optional)`).
2. Spreads (`...X.fields`), `Struct.omit(...)` and `Struct.pick(...)` are resolved. An unresolvable spread is a
   hard error, so a shape can never silently lose fields.
3. References are followed across the fork's modules: `@opencode/schema/<name>` maps to
   `packages/schema/src/<name>.ts`, relative imports resolve in place, `export * as X from` is followed, and
   `import { X } from "..."` may name such a namespace. Resolution stops at depth 8; a deeper reference becomes
   `{}` annotated with `"$comment": "unresolved: <name> (depth limit)"`. The current fork resolves fully, so no
   checked-in schema contains an unresolved leaf.
4. Leaves: `String`/`AbsolutePath`/`RelativePath`/`DateTimeUtcFromMillis` -> `string`, `Int`/`NonNegativeInt`/
   `PositiveInt` -> `integer` (with `minimum`), `Finite`/`Number` -> `number`, `Boolean`, `Unknown`/`Any`/`Json`
   -> `{}`, `Literal`/`tag` -> `const`, `Literals` -> `enum`, `Union` -> `anyOf` (or `enum` when every member is
   a literal), `Array`/`NonEmptyArray` -> `array` (`minItems: 1` for non-empty), `Record` -> `object` with
   `additionalProperties`, `TemplateLiteral` -> `string`.
5. Not modelled on purpose: `.check(...)` constraints (a branded ID stays a plain `string`), `.brand(...)`,
   `decodeTo`/`encodeTo` codecs (the declared side is used), `Schema.Json` payloads (kept open), and
   `Schema.Class` methods. These are wire-value compatible, not semantic validators.
6. `error.envelope` is generated from the tagged-error classes: every class must declare a required
   `message` field (the extraction fails otherwise), the envelope requires `_tag` and `message`, allows any
   extra error-specific field, and lists every declared tag in its `$comment` so a rename or removal is drift.

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
| `OMO_BRIDGE_CONTRACTS_SENPI_DIR` | check | fixture directory to validate |
| `OMO_BRIDGE_OMO_BIN` | record | host binary to spawn |
