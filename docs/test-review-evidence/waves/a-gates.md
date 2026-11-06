# a-gates

Audit of the gate set in `/Users/zyno/Developer/github/omo-bridge` (read-only). All runs below were executed once on 2026-11-06 from the repo root with the shell `bun` on PATH.

## Facts

- Six gates are declared as scripts; `dev` is the only non-gate entry. [package.json:12-18]
- `test` is bare `bun test` against `test/` with a 30 s per-test timeout from bunfig. [package.json:12] [bunfig.toml:2]
- `test` run: `874 pass / 5 skip / 0 fail`, 2992 `expect()` calls, 879 tests across 41 files, 5.55 s. [cmd: cd omo-bridge && bun test -> exit=0, "874 pass", "Ran 879 tests across 41 files. [5.55s]"]
- `typecheck` is `tsc --noEmit` under `"strict": true`, i.e. it proves only that types resolve and agree; it executes no behavior. [package.json:13] [tsconfig.json:6]
- `typecheck` run: exit 0, 2.81 s, no output beyond the script echo. [cmd: bun run typecheck -> exit=0 ms=2805]
- `contracts:check` derives schemas from the fork's generated client (`compareSchemas`/`deriveSchemas`) and validates every recorded sample and senpi fixture; a missing sample, an unknown endpoint, or a wrong frame shape is drift. [scripts/contracts-check.ts:23] [scripts/contracts-check.ts:30]
- `contracts:check` run: `contracts: ok (opencode 80 endpoints, 80 samples, senpi 57 frames)`, exit 0, 0.48 s. [cmd: bun run contracts:check -> exit=0 ms=476]
- `surface:check` re-extracts the endpoint/call-site surface the TUI actually uses and byte-compares it with the checked-in fixture, failing with "surface fixture is stale" on mismatch. [scripts/surface-extract.ts:3] [scripts/surface-extract.ts:198]
- `surface:check` run: `surface fixture is current (99 endpoints)`, exit 0, 0.56 s. [cmd: bun run surface:check -> exit=0 ms=562]
- Surface extraction reads the fork checkout from an absolute default path `OMO_BRIDGE_OPENCODE_FORK ?? "/Users/zyno/OmO Projects/my-tui/opencode"`. [scripts/surface-extract.ts:16]
- `selfcheck` first asserts `@code-yeongyu/senpi` is pinned to exactly `2026.11.4-2`, then runs `typecheck`, `contracts:check`, `test` as child processes and prints `selfcheck: ok`. [scripts/selfcheck.ts:4] [scripts/selfcheck.ts:8-12] [scripts/selfcheck.ts:60]
- `selfcheck` step list contains exactly three steps and does not include `surface:check` or `qa:tui`. [scripts/selfcheck.ts:9-11]
- `selfcheck` run: `selfcheck: ok`, exit 0, 8.17 s (it re-runs the 5.5 s test suite). [cmd: bun run selfcheck -> exit=0 ms=8173, "selfcheck: ok"]
- `qa:tui` starts a real bridge plus a real TUI renderer (xterm, falling back to tmux), runs one scenario, and returns the scenario's own exit code; the default `send-message` scenario exits 1 unless the reply, ordering and error checks pass. [script/qa/web-terminal-visual-qa.mjs:3-5] [script/qa/web-terminal-visual-qa.mjs:64-66] [script/qa/web-terminal-visual-qa.mjs:77-80] [script/qa/scenarios/send-message.mjs:187]
- `qa:tui` was not executed in this audit: it starts servers and PTYs, which the task forbids; its runtime is therefore unmeasured. [cmd: not run - scope forbids servers/PTYs]
- `packageManager` pins `bun@1.4.4`, and `bun.lock` is `lockfileVersion: 1`. [package.json:6] [bun.lock:2]
- The machine's shell `bun --version` is `1.3.14` at `/opt/homebrew/bin/bun` — the same binary `qa:tui` hardcodes. [cmd: bun --version -> 1.3.14] [script/qa/web-terminal-visual-qa.mjs:44]
- `qa:tui`'s default bun is the absolute path `/opt/homebrew/bin/bun`, so a script-invoked run ignores whatever bun the caller has. [script/qa/web-terminal-visual-qa.mjs:44]
- There is no `.github/`, no `.husky/`, and no `Makefile` in the repo root. [cmd: ls -a omo-bridge -> .git .gitignore AGENTS.md DEGRADATIONS.md README.md bin bun.lock bunfig.toml contracts docs launch-spec.json node_modules package.json script scripts src state test tsconfig.json; ls .github .husky Makefile -> "No such file or directory"]
- `.git/hooks` contains only the stock `*.sample` files, and `core.hooksPath` is unset. [cmd: ls .git/hooks -> only *.sample entries; git config core.hooksPath -> empty]
- `bunfig.toml` configures only `[test] timeout = 30000`; it has no preload, install hook, or script hook. [bunfig.toml:1-2]
- Gates are invoked by prose only: README and upgrade docs tell a human to finish with `bun run selfcheck`. [README.md:131] [docs/upgrade.md:93] [docs/upgrade.md:96]

## Gaps

- No gate runs automatically today: nothing on commit (hooks are samples only, hooksPath unset), nothing on push or PR (no CI directory), nothing on `bun install` (no bunfig hook). Every gate is manual. [cmd: git config core.hooksPath -> empty] [cmd: ls .github .husky Makefile -> all "No such file or directory"]
- `docs/upgrade.md` says to "finish with `bun run selfcheck`", but selfcheck omits `surface:check`, so a fork that adds a TUI call can pass the documented finishing gate while `contracts/surface/tui-endpoints.json` is stale. [docs/upgrade.md:96] [scripts/selfcheck.ts:8-12]
- The real-client E2E layer is skipped by default unless `OMO_BRIDGE_E2E_TUI_DIR` names the fork checkout; 4 of the 5 skips are that suite, so a green `874 pass` does not exercise the client contract on a fresh clone. [test/e2e/real-client.test.ts:15] [test/e2e/real-client.test.ts:70] [cmd: bun test -> "(skip) the real my-tui client against the bridge" x4]
- The senpi host integration test is skipped unless `OMO_BRIDGE_INTEGRATION=1`, so the host frame contract is never checked by default. [test/senpi/integration.test.ts:7] [test/senpi/integration.test.ts:73]
- Two tests self-disable when fork artifacts are missing: surface fixture currency skips without the fork, and client event-shape transcription skips without the fork's generated types — both count as green. [test/http/surface.test.ts:84] [test/contract/event-shapes.test.ts:441]
- `surface:check` itself has no skip path: without the fork at its hardcoded absolute path it reads a missing file and fails, so the gate is machine-bound rather than portable. [scripts/surface-extract.ts:16] [scripts/surface-extract.ts:194-195]
- `selfcheck` checks the senpi pin but not the bun version, so a `bun@1.4.4` repo passes on bun 1.3.14; the recorded green runs are 1.3.14 runs, and bun's `packageManager` field is advisory without an enforcing shim. Consequence: lockfile resolution and test-runner behavior may differ from the pinned 1.4.4, and any 1.4-only builtin used by source would only fail at runtime. [package.json:6] [scripts/selfcheck.ts:43] [cmd: bun --version -> 1.3.14]
- `qa:tui` is a manual gate outside `selfcheck` and outside any trigger, and its evidence is written to `.qa/run-<timestamp>` under the cwd by default, so nothing enforces that it ran before a change ships. [script/qa/web-terminal-visual-qa.mjs:31] [script/qa/web-terminal-visual-qa.mjs:77-80]
- No gate asserts that `bun.lock` is in sync with `package.json` (no `--frozen-lockfile` install check), so dependency drift can land without a red gate. [bun.lock:2] [package.json:21-26]

## Claims

- `bun test` is the only behavioral gate and currently yields 874 pass, 5 skip, 0 fail in ~5.6 s | [cmd: bun test -> "874 pass", "Ran 879 tests across 41 files. [5.55s]"] | high
- `typecheck`, `contracts:check`, `surface:check` all pass on this machine, at 2.8 s, 0.5 s, 0.6 s respectively | [cmd: bun run typecheck / contracts:check / surface:check -> exit=0 each] | high
- `selfcheck` passes in 8.2 s and bundles only typecheck + contracts:check + test | [scripts/selfcheck.ts:8-12] [cmd: bun run selfcheck -> "selfcheck: ok", ms=8173] | high
- `surface:check` verifies 99 TUI-called endpoints against the checked-in fixture | [scripts/surface-extract.ts:201] [cmd: bun run surface:check -> "surface fixture is current (99 endpoints)"] | high
- `contracts:check` verifies 80 opencode endpoints with 80 samples plus 57 senpi frames | [scripts/contracts-check.ts:157] [cmd: bun run contracts:check -> "contracts: ok (opencode 80 endpoints, 80 samples, senpi 57 frames)"] | high
- No gate runs automatically on commit, push, PR, or install today | [cmd: git config core.hooksPath -> empty; ls .github .husky Makefile -> absent; ls .git/hooks -> samples only] | high
- The repo pins `bun@1.4.4` but this machine and the QA harness run `1.3.14`; nothing enforces the pin | [package.json:6] [script/qa/web-terminal-visual-qa.mjs:44] [cmd: bun --version -> 1.3.14] | high
- The real-client E2E suite and the senpi host integration test are opt-in and skip silently by default | [test/e2e/real-client.test.ts:70] [test/senpi/integration.test.ts:7] | high
- `qa:tui` is a real-surface gate that can go red, but it is manual and unmeasured in this audit | [script/qa/scenarios/send-message.mjs:187] [cmd: not run - scope forbids servers/PTYs] | medium
- `surface:check` is bound to one absolute fork path and degrades to a hard failure without it | [scripts/surface-extract.ts:16] | high
