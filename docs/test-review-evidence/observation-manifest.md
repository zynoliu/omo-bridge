# Observation manifest — test-system review (2026-11-06)
observer: lead session · independence basis: commands executed in this session · observed_at 2026-11-06T12:0x–12:3x+08

| id | source | layer | observer | observed_at | artifact / anchor |
|---|---|---|---|---|---|
| O1 | omo-bridge test suite | suite output | lead | 2026-11-06 12:19 | `bun test` → 874 pass / 5 skip / 0 fail, 879 tests, 41 files, 6.54s |
| O2 | coverage table | coverage | lead | 2026-11-06 12:19 | `bun test --coverage` → 93.39% funcs / 91.77% lines |
| O3 | per-layer case counts | suite output | lead | 2026-11-06 12:33 | http 469, contract 294, translate 34, model 24, senpi 14+1skip, bridge 11, e2e 4skip, root 28 |
| O4 | static gates | cmd output | lead | 2026-11-06 12:19 | typecheck 0; contracts ok (80 endpoints/80 samples/57 frames); surface 99 current; selfcheck ok |
| O5 | CI absence | repo tree | lead | 2026-11-06 12:19 | `ls -R .github` → none; bunfig.toml only `timeout=30000` |
| O6 | empty-catalog loop | test source | lead | 2026-11-06 12:5x | test/http/catalogs.test.ts:349-372 — 9 paths assert `data == []` |
| O7 | capabilities pin | test source | lead | 2026-11-06 12:5x | test/http/server.test.ts:49 — `capabilities == {persistentPty:false}` |
| O8 | degradation suite | suite output | lead | 2026-11-06 12:56 | `bun test ./test/http/degraded.test.ts` → 59 pass |
| O9 | surface sweep | test source | lead | 2026-11-06 12:5x | test/http/surface.test.ts:100-155 — status/envelope/schema only |
| O10 | QA chain | scenario run | lead | 2026-11-06 12:17 | send-message green (outcome reply, history 6/3) |
| O11 | QA chain red | scenario run | lead | 2026-11-06 12:31 | send-message exit 1: "Session failed — provider returned an unexpected error", history 5/2 |
| O12 | /models dialog | scenario run | lead | 2026-11-06 12:25/12:33 | `models-dialog` → Free models / No items available; bridge /api/model 33, /api/integration 1 |
| O13 | /connect dialog | scenario run | lead | 2026-11-06 12:33 | `Connect an integration` lists ✓ opencode-go / API key |
| O14 | command surface | HTTP probe | lead | 2026-11-06 13:0x | `GET /api/command` → 32 rows incl. 5 `skill:*` |
| O15 | degraded catalogs live | HTTP probe | lead | 2026-11-06 13:0x | /api/skill 0, /api/mcp 0, /api/plugin 0, /api/reference 0, usage null, /api/agent 1 |
| O16 | host MCP capability | dependency source | lead | 2026-11-06 13:0x | node_modules/@code-yeongyu/senpi/dist/core/extensions/builtin/mcp/commands.js:26 — "Inspect and manage MCP servers." |
| O17 | reply order | scenario frame | lead | 2026-11-06 12:17 | frame-after.txt — assistant footer at line 7, user bubble at line 12 |
| O18 | QA state-dir leak | fs read | lead | 2026-11-06 12:4x | 33→32 dirs under $TMPDIR; script/qa/lib/bridge.mjs has no rmSync on stop |
| O19 | fork test volume | fs read | lead | 2026-11-06 12:2x | 1172 *.test.ts under my-tui/opencode; packages/tui 195 |
| O20 | real-client e2e gate | test source | lead | 2026-11-06 12:2x | test/e2e/real-client.test.ts:17,70 — skipped unless OMO_BRIDGE_E2E_TUI_DIR |
| O21 | bun pin mismatch | cmd output | lead | 2026-11-06 12:19 | package.json packageManager bun@1.4.4; `bun --version` → 1.3.14 |
