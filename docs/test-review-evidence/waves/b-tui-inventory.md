# b-tui-inventory

Read-only inventory of `/Users/zyno/OmO Projects/my-tui/opencode` (fork of anomalyco/opencode). No repo file touched, no git command run, no test suite executed.

## Facts

- The repo holds 2178 `*.test.ts(x)` files in total: `find . -name '*.test.ts' -o -name '*.test.tsx' | wc -l` -> 2178 [cmd: find . -name '*.test.ts' -o -name '*.test.tsx' | wc -l -> 2178].
- `packages/tui` holds 194 of them, i.e. ~8.9% of all test files, at 49,040 lines combined [cmd: find packages/tui -name '*.test.ts' -o -name '*.test.tsx' | wc -l -> 194; cmd: find packages/tui ... | xargs wc -l | tail -1 -> 49040 total].
- The documented per-package test command is the package's own script: `"test": "bun test --timeout 30000 --only-failures"` [packages/tui/package.json:9].
- Tests must not run from the repo root; the root `bunfig.toml` enforces it by pointing the test root at a non-existent directory, so a root-level `bun test` discovers nothing [bunfig.toml:8 `root = "./do-not-run-tests-from-root"`; AGENTS.md:187 "Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package directories such as `packages/core`"].
- The guard directory really is absent today (`ls -d do-not-run-tests-from-root` -> No such file or directory), so the block is structural, not a script check [cmd: ls -d do-not-run-tests-from-root -> No such file or directory].
- `packages/tui` isolation is a two-entry `[test] preload`: the upstream renderer preload plus a local shim, and the same upstream preload is also declared at top level for non-test consumers of the package [packages/tui/bunfig.toml:1; packages/tui/bunfig.toml:4 `preload = ["@opentui/solid/preload", "./test/preload.ts"]`].
- The local preload is a monkey-patch of OpenTUI's buffer read path: it caches the last frame and, on `NativeError`/`NativeStatus.OutputBusy`, returns the cached bytes instead of throwing, because the test renderer can read while the native writer is mid-flush [packages/tui/test/preload.ts:4-14].
- Ten biggest `packages/tui` test files by line count (4706, 3669, 2888, 2569, 2510, 1036, 979, 950, 871, 831) [cmd: find packages/tui -name '*.test.ts*' | xargs wc -l | sort -rn | head -11]:
  1. `test/mini/stream-v2.transport.test.ts` 4706 [packages/tui/test/mini/stream-v2.transport.test.ts:1; wc -l -> 4706]
  2. `test/cli/tui/data.test.tsx` 3669 [packages/tui/test/cli/tui/data.test.tsx:1]
  3. `test/app-lifecycle.test.tsx` 2888 [packages/tui/test/app-lifecycle.test.tsx:1]
  4. `test/mini/footer.view.test.tsx` 2569 [packages/tui/test/mini/footer.view.test.tsx:1]
  5. `test/cli/tui/diff-viewer.test.tsx` 2510 [packages/tui/test/cli/tui/diff-viewer.test.tsx:1]
  6. `test/cli/tui/dialog-open.test.tsx` 1036 [packages/tui/test/cli/tui/dialog-open.test.tsx:1]
  7. `test/mini/scrollback.surface.test.ts` 979 [packages/tui/test/mini/scrollback.surface.test.ts:1]
  8. `test/cli/tui/form.test.tsx` 950 [packages/tui/test/cli/tui/form.test.tsx:1]
  9. `test/plugin-source.test.ts` 871 [packages/tui/test/plugin-source.test.ts:1]
  10. `test/context/session-tabs.test.tsx` 831 [packages/tui/test/context/session-tabs.test.tsx:1]
- Top 1, `stream-v2.transport.test.ts` (4706 lines, 64 tests): no renderer at all — it drives `createSessionTransport` / `runPromptQueue` from `src/mini` against a fake event feed and a mocked `@opencode/client/promise`, asserting stream commit projection and reconnect behavior [packages/tui/test/mini/stream-v2.transport.test.ts:7-16,233,254].
- Top 2, `data.test.tsx` (3669 lines, 48 tests): OpenTUI/Solid renderer test via `testRender` + a full provider tree (Config/Client/Data/Keymap/Location/Route/Storage/Theme), asserting context-sync behavior such as "does not preload session summaries into the data context" [packages/tui/test/cli/tui/data.test.tsx:1-3,85].
- Top 3, `app-lifecycle.test.tsx` (2888 lines, 31 tests): boots the app on `createTestRenderer` and `SimulationRenderer`, asserting process-level lifecycle (Ctrl-O timing at widths 100/44, SIGHUP title clearing, terminal title, epilogue) [packages/tui/test/app-lifecycle.test.tsx:3,9,18,238].
- Top 4, `footer.view.test.tsx` (2569 lines, 63 tests): `testRender` of `RunFooterView`/`RunFooter` and the mini composer, asserting paste/image-attachment, mention offsets, agent+model leads, into a themed Solid tree [packages/tui/test/mini/footer.view.test.tsx:12,234,325,550].
- Top 5, `diff-viewer.test.tsx` (2510 lines, 70 tests): `testRender` of the diff viewer route with `DiffRenderable`/`ScrollBoxRenderable` and simulated keys/mouse, asserting route round-trip, full-screen vs panel toggle at 80/160 columns, error surfaces [packages/tui/test/cli/tui/diff-viewer.test.tsx:9,46,72,106].
- There are zero Jest-style snapshots: `toMatchSnapshot` / `toMatchInlineSnapshot` appear 0 times under `packages/tui/test`; "snapshot" hits are the app's own scrollback writer snapshots [cmd: grep -rn "toMatchSnapshot\|toMatchInlineSnapshot" packages/tui/test | wc -l -> 0; packages/tui/test/mini/splash.test.ts:19].
- Shared fixtures live in `packages/tui/test/fixture/`: `app.ts` (`createAppFixture`), `tui-client.ts` (fetch/event-stream doubles), `tui-environment.tsx` (`TestTuiContexts`), `frame.ts`, plus a `tmpdir()` helper that mkdtemps under `opencode-tui-test-` and disposes via `Symbol.asyncDispose` [packages/tui/test/fixture/app.ts:10; packages/tui/test/fixture/tui-environment.tsx:19; packages/tui/test/fixture/fixture.ts:8-12].
- The in-repo `tui-tests` skill documents the same isolation model (`testRender`/`createTestRenderer`, started vs not-started renderers, frame waits, injected clocks, 30s budget) and the focused invocation `bun test --timeout 30000 test/<file>` from `packages/tui` [.opencode/skills/tui-tests/SKILL.md:3,8,70,78].

## Gaps

- I did not execute the suite, so no pass/fail number exists in this inventory; the only execution evidence here is file/line counts [cmd: none run; see above].
- `packages/tui` `bunfig.toml` declares `preload` both at the top level (line 1) and inside `[test]` (line 4); only the `[test]` value applies to bun test, so line 1 is dead config for tests and easy to misread [packages/tui/bunfig.toml:1,4].
- The root guard is enforced by a *missing* directory that bunfig points at; if someone creates `do-not-run-tests-from-root/`, root-level runs silently become possible with no test in place to catch it [bunfig.toml:8; AGENTS.md:187].
- The preload monkey-patch masks `OutputBusy` by returning the previous frame; a test that asserts on freshly written output could read a stale frame with no failure [packages/tui/test/preload.ts:11-15].
- The skill says "about 170 test files" in one `bun test` process while the tree now has 194, so the documented CI cost/parallelism numbers are stale [.opencode/skills/tui-tests/SKILL.md:8; cmd: find packages/tui -name '*.test.ts*' | wc -l -> 194].
- The ten biggest files are 21,000+ of the package's 49,040 test lines, and the top three alone exceed 11k; these are the files most likely to hide the expensive cold-import timeouts the skill warns about, and none is not renderer-free except #1 [cmd: wc -l ranking above].

## Claims

- The fork carries 2178 test files overall and 194 in `packages/tui` | [cmd: find ... | wc -l -> 2178 / 194] | high
- The package test command is `bun test --timeout 30000 --only-failures` | [packages/tui/package.json:9] | high
- Tests must be run from the package directory, not the repo root, because root bunfig redirects the test root to a nonexistent `do-not-run-tests-from-root` | [bunfig.toml:8; AGENTS.md:187] | high
- `packages/tui` test isolation is `@opentui/solid/preload` plus a local `OutputBusy`-tolerant frame cache shim | [packages/tui/bunfig.toml:4; packages/tui/test/preload.ts:4-15] | high
- The four largest runner files are OpenTUI/Solid render tests; the largest file is a renderer-free transport test | [packages/tui/test/mini/stream-v2.transport.test.ts:233; packages/tui/test/cli/tui/data.test.tsx:2] | high
- No inline or file snapshots are used in `packages/tui` tests; assertions read `captureCharFrame()` output instead | [cmd: grep toMatchSnapshot | wc -l -> 0] | medium
- The documented file count (~170) in the tui-tests skill is stale against 194 on disk | [.opencode/skills/tui-tests/SKILL.md:8] | medium
