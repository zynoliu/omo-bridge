# b-skills

Skills read (read-only): `/Users/zyno/OmO Projects/my-tui/opencode/.opencode/skills/{unit-tests,tui-tests,app-e2e-tests,component-tests}/SKILL.md`. Anchors below are `<skill>/SKILL.md:<line>`; bridge anchors are relative to `/Users/zyno/Developer/github/omo-bridge`.

## Facts

- unit-tests — Never absorb a sleep, poll or production interval with a larger timeout, `--retry` or `skipIf(win32)`; remove the wait, and skip a platform only when it lacks the capability. [unit-tests/SKILL.md:30]
- unit-tests — A per-test timeout is legitimate only when it exceeds the package default and names the work in a comment; default Bun budget is 5000ms (core/cli/ai/tui pass `--timeout 30000`). [unit-tests/SKILL.md:20] [unit-tests/SKILL.md:28]
- unit-tests — Control time instead of waiting: `it.effect`/`TestClock` for Effect code, `jest.useFakeTimers()`+`setSystemTime` restored in `afterEach` elsewhere, and advance to the next timer rather than in fixed steps. [unit-tests/SKILL.md:34] [unit-tests/SKILL.md:43] [unit-tests/SKILL.md:44]
- unit-tests — Real-time polls are bounded in milliseconds and return as soon as the condition holds (`until`, `eventually`); attempt-count loops hide a shrinking budget. [unit-tests/SKILL.md:48] [unit-tests/SKILL.md:49]
- unit-tests — Forbidden: `mock.module` (leaks across files in the shared single-process registry) and adding `--isolate`/bare `--parallel` to a test script; no wall-clock speed assertions. [unit-tests/SKILL.md:105] [unit-tests/SKILL.md:109] [unit-tests/SKILL.md:70]
- unit-tests — Fixture strategy: shared `tmpdir()`/`tmpdirScoped`/`withTempDir`, `withEnv`/`isolatedEnv(root)` for spawned CLIs, and one canonical git fixture (`initGit`) instead of per-file `git init`+`git config`. [unit-tests/SKILL.md:97] [unit-tests/SKILL.md:99] [unit-tests/SKILL.md:78] [unit-tests/SKILL.md:80]
- tui-tests — Frame budget is not time: `waitForFrame`/`waitFor` give up after `maxPasses` (default 20); a frame-budget failure is not fixed by raising the Bun timeout, and raising `maxPasses` only hides the wrong wait. [tui-tests/SKILL.md:14] [tui-tests/SKILL.md:71]
- tui-tests — Wait on the signal the frame actually depends on (focus inside the predicate, `waitForHighlightedFrame` for tree-sitter text); with no signal to await, poll with a wall-clock deadline. [tui-tests/SKILL.md:17] [tui-tests/SKILL.md:18] [tui-tests/SKILL.md:19]
- tui-tests — Renderer mode and clock: `testRender(...)`+`renderOnce()` for component logic, `ManualClock`+`renderer.pause()` for time-driven renderables, injected clock before global fake timers. [tui-tests/SKILL.md:33] [tui-tests/SKILL.md:34] [tui-tests/SKILL.md:35]
- tui-tests — Input only through `setup.mockInput` with `kittyKeyboard: true`; without it modifier keys are silently sent as something else. [tui-tests/SKILL.md:41] [tui-tests/SKILL.md:42]
- tui-tests — Always pass `width`/`height` and cover a narrow plus a wide width; clean up with `await using`/`finally` (renderer, server, timers) and remove the tmpdir last. [tui-tests/SKILL.md:55] [tui-tests/SKILL.md:56] [tui-tests/SKILL.md:62] [tui-tests/SKILL.md:63]
- tui-tests — Push gate for flake work: `--rerun-each 10` all pass, force the suspected race and it must still pass, and a negative control must fail fast instead of hanging. [tui-tests/SKILL.md:79] [tui-tests/SKILL.md:80] [tui-tests/SKILL.md:81]
- app-e2e-tests — The API is an in-memory mock per page and an unmocked route fails the test with 501, so a missing route is added once to `mock-server.ts`, never routed around inside a spec. [app-e2e-tests/SKILL.md:16] [app-e2e-tests/SKILL.md:20]
- app-e2e-tests — Isolation: fresh context/mock handler/init scripts per test, no `beforeAll`, serial mode or worker fixtures; stateful builders are called inside the test. [app-e2e-tests/SKILL.md:30] [app-e2e-tests/SKILL.md:35]
- app-e2e-tests — Navigate once (each `goto` is a cold production-bundle load) and use `page.clock` instead of real waits; timeouts are not a fix (60s/test, 10s/assertion). [app-e2e-tests/SKILL.md:40] [app-e2e-tests/SKILL.md:54] [app-e2e-tests/SKILL.md:99]
- app-e2e-tests — Route matchers must be RegExp or query-aware globs, never a bare function (a function matcher makes Playwright intercept every request). [app-e2e-tests/SKILL.md:45]
- app-e2e-tests — Push gate: a race fix must fail before and pass after, verified with `--repeat-each=10 --workers=5 --retries=0`. [app-e2e-tests/SKILL.md:117] [app-e2e-tests/SKILL.md:113]
- component-tests — `mount` is a full page navigation to the story frame and a wrong story ID renders nothing, so IDs are checked and every arg gets a typed default to arrive as boolean/number. [component-tests/SKILL.md:8] [component-tests/SKILL.md:19] [component-tests/SKILL.md:21]
- component-tests — Fixtures imported by URL must be built with `sourceURL(new URL("<literal>", import.meta.url))`, and specs import source modules with `import type` only. [component-tests/SKILL.md:40] [component-tests/SKILL.md:42]
- component-tests — The bar is zero Vite optimizer reloads; fix them in the `optimizeDeps` scan, never with retries/timeouts/import order, and delete `packages/stories/node_modules/.vite` before judging. [component-tests/SKILL.md:49] [component-tests/SKILL.md:53] [component-tests/SKILL.md:54]
- component-tests — Async order is decided by deferreds the fixture exposes, not fixed in-page `setTimeout`; emulation uses test-scoped options (`story.use`), never worker-scoped `launchOptions`. [component-tests/SKILL.md:43] [component-tests/SKILL.md:68]
- All four skills sit above repo docs: root/`packages/app` `AGENTS.md` remain authoritative for what to test, and a story/fixture/worker change must be rehearsed cold. [unit-tests/SKILL.md:12] [component-tests/SKILL.md:91] [app-e2e-tests/SKILL.md:8]

## Gaps

- No time-control layer at all in the bridge: zero occurrences of `useFakeTimers`, `setSystemTime` or `TestClock` under `test/`, so every production interval is waited out for real. [cmd: grep -rnE 'useFakeTimers|setSystemTime|TestClock' test -> no output]
- No per-test timeout discipline: one global `timeout = 30000` and a bare `bun test` script, so no test names the work that justifies more than the default and there is no budget table per package. [bunfig.toml:2] [package.json:12]
- Bounded waits are per-file copies instead of a shared helper: `setTimeout`-derived deadlines are re-declared in ~10 files, and the only named helper is `waitForLine`. [test/http/event.test.ts:13] [test/http/permission.test.ts:102] [test/senpi/integration.test.ts:34]
- No shared test fixture layer: temp dirs are created ad hoc with `mkdtempSync` in each file, and there is no `tmpdir()`/`withEnv`/`isolatedEnv` equivalent for spawned CLIs. [test/launcher.test.ts:203] [test/http/prompt.test.ts:143] [cmd: grep -rn isolatedEnv test -> no output]
- `mock.module` is unused but not banned anywhere, and nothing records the "no `--isolate`/`--parallel`" rule the fork enforces. [cmd: grep -rnE 'mock\.module' test -> no output] [AGENTS.md:1]
- tui-tests: N/A on the renderer half (the bridge renders nothing), but the waiting discipline has no equivalent — no frame/signal-budget rule, no `rerun-each 10` + forced-race + negative-control gate. [cmd: find test -name '*tui*' -> tui-launch.test.ts, tui-session.test.ts (spawn-based)]
- app-e2e-tests: the only e2e is gated off by default (`OMO_BRIDGE_E2E_TUI_DIR`), so a fresh clone never runs it; no isolation, repeat-at-concurrency or fail-before/pass-after rule exists. [test/e2e/real-client.test.ts:15] [test/e2e/real-client.test.ts:17]
- component-tests: no equivalent surface exists — no Playwright/Vite story stack, no `playwright.config.*`, no `.opencode/skills` directory in the repo. [cmd: find . -maxdepth 3 -name 'playwright.config.*' -> none] [cmd: ls .opencode -> no .opencode]
- No rule is binding at repo level: `AGENTS.md` is 9 lines of prohibitions with no testing section, and the ported rules exist only as prose in a review doc. [AGENTS.md:1] [docs/test-system-review.md:118]

## Claims

- The four fork skills are rule-sets with file:line anchors, not tutorials, and each states its own forbidden list | unit-tests/SKILL.md:105, tui-tests/SKILL.md:74, app-e2e-tests/SKILL.md:99, component-tests/SKILL.md:102 | high
- Raising timeouts, retries or frame budgets is forbidden in all four; every one demands removing the wait instead | unit-tests/SKILL.md:30, tui-tests/SKILL.md:71, app-e2e-tests/SKILL.md:99, component-tests/SKILL.md:53 | high
- A real gap list for the bridge starts with time control, a shared bounded-wait/tmpdir fixture layer, and per-test budget discipline | bunfig.toml:2, test/http/event.test.ts:13, test/launcher.test.ts:203 | high
- The bridge has no equivalent for component-tests and only a dormant equivalent for app-e2e-tests | package.json:12, test/e2e/real-client.test.ts:15 | high
- The tui-tests renderer rules do not transfer to the bridge, but its flake-gate (rerun-each, forced race, negative control) does and is missing | tui-tests/SKILL.md:79, test/senpi/integration.test.ts:34 | medium
