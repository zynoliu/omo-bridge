# a-contract

## Facts
- The opencode side is generated, not hand-written: `deriveSchemas()` walks the fork's TypeScript schema AST and emits one JSON Schema per endpoint with `$id: opencode/<id>` [scripts/contracts-extract.ts:1462].
- Regeneration is `writeSchemas()` [scripts/contracts-extract.ts:1543]; `contracts:check` diffs every on-disk file against a fresh derivation and ignores only the root `description` [scripts/contracts-extract.ts:1478].
- The pinned opencode set is 80 endpoints: 44 response bodies plus 36 event frames [contracts/SOURCE.md:16].
- Samples are one-per-endpoint: 44 body files under `contracts/opencode/samples/` plus 36 lines in `events.jsonl`; the check enforces both directions (sample missing, sample without endpoint) [scripts/contracts-check.ts:33].
- The check passes at 80 endpoints, 80 samples, 57 frames [cmd: bun run contracts:check -> contracts: ok (opencode 80 endpoints, 80 samples, senpi 57 frames)].
- The senpi side is hand-written TypeScript, not extracted: 14 event types in `EVENT_SCHEMAS` [src/contract/senpi-schema.ts:65] and 6 commands in `RESPONSE_DATA_SCHEMAS` [src/contract/senpi-schema.ts:233].
- Senpi fixtures total 57 frames in 4 jsonl files (12 live responses, 17 events, 13 stream, 15 tools); the live ones were recorded from a real host and only `events.jsonl` is documentation-derived [contracts/senpi/DERIVED.md:3].
- Those fixtures pin exactly six commands, all `source: "live"` [test/contract/senpi.test.ts:25], and all nine streaming delta kinds [test/contract/senpi.test.ts:43].
- A separate surface layer parses the fork's generated promise client plus TUI call sites into 99 endpoints [scripts/surface-extract.ts:47] [cmd: node -e "require('./contracts/surface/tui-endpoints.json').endpoints.length" -> 99].
- What the tests validate is shape: required-key presence and primitive type via Ajv, plus a per-endpoint mutation that deletes one required field and expects rejection [test/contract/opencode.test.ts:96].
- Targeted negative controls exist for real regressions: assistant message without `agent` [test/contract/opencode.test.ts:121], ISO string instead of epoch millis [test/contract/opencode.test.ts:131], and a `location.get` body wrapped in a `location` envelope [test/contract/opencode.test.ts:151].
- Senpi tests cover type/command mismatch and required data fields [test/contract/senpi.test.ts:82] [test/contract/senpi.test.ts:94].
- HTTP status is asserted only in the live surface harness, and only as membership in `{successStatus} ∪ declaredStatuses` [test/http/surface.test.ts:108].
- The contract tests are green as a whole: 294 pass, 0 fail across 5 files [cmd: bun test test/contract -> 294 pass, 0 fail].
- Runtime enforcement is narrow: `validateResponse` gates only three responses (`server.info`, `model.info`, `integration.list`) [src/http/server.ts:87] [src/http/handlers/catalogs.ts:228].

## Gaps
- No generated schema forbids extra properties (0 files contain `"additionalProperties": false`), so envelope/wrapper drift passes; adding `location` beside the bare `location.get` body still validates [cmd: bun run /tmp/probe-contract.ts -> extra-field-body: {"ok":true}].
- Value domains are mostly unconstrained: `status` is a bare string and `attachments` any integer [src/contract/senpi-schema.ts:226], so `status: "banana"` and `attachments: -5` validate [cmd: bun run /tmp/probe-contract.ts -> status-banana: {"ok":true}].
- The event-shape suite checks only that required keys are present and not `undefined`, never their value, type or order [test/contract/event-shapes.test.ts:467].
- Two cross-repo checks self-disable when the fork is absent: client-type transcription [test/contract/event-shapes.test.ts:441] and surface currency [test/http/surface.test.ts:84]; both report green as skips.
- Status semantics are unpinned: any declared status is accepted, so answering 200 where the client expects 404 stays green as long as 200 is the success status [test/http/surface.test.ts:108].
- Error envelopes are checked only for string `_tag`/`message`, with no binding of error code to endpoint or status [src/contract/validate.ts:84].
- Nothing asserts ordering, duplication, or session ownership across frames: each senpi event frame is validated in isolation [scripts/contracts-check.ts:143].

## Claims
- The contract layer is a type-shape gate, not a behaviour gate. | [src/contract/validate.ts:55] | high
- The opencode schemas are fully derived from the fork and drift-checked byte-for-byte; the senpi schemas are hand-written and only fixture-checked. | [scripts/contracts-extract.ts:1516] | high
- Extra or wrongly wrapped response fields cannot be caught, because no schema sets `additionalProperties: false`. | [cmd: bun run /tmp/probe-contract.ts -> extra-field-body: {"ok":true}] | high
- Wrong-but-schema-valid values (status strings, session ids, timestamp magnitude, negative counts) pass validation. | [cmd: bun run /tmp/probe-contract.ts -> status-banana: {"ok":true}] | high
- Status-code substitution, event reordering, duplicate delivery and cross-session leaks survive the whole contract suite. | [test/http/surface.test.ts:108] | high
- Pinned magnitude is 80 opencode endpoints, 57 senpi frames and 99 TUI surface endpoints. | [cmd: bun run contracts:check -> opencode 80 endpoints / senpi 57 frames] | high
