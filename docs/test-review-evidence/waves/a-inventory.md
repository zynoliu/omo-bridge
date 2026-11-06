# a-inventory

## Facts

- Test tree under `test/` has seven subdirectories plus six root-level test files: http, contract, translate, model, senpi, bridge, e2e. [cmd: ls test -> bridge contract e2e http launcher.test.ts model runtime-usage.test.ts runtime.test.ts scaffold.test.ts senpi translate tui-launch.test.ts tui-session.test.ts]
- File/case counts by directory: http 21 files / 469 cases, contract 5 / 294, translate 3 / 34, model 2 / 24, senpi 2 / 14 pass + 1 skip, bridge 1 / 11, e2e 1 / 0 pass + 4 skip. [cmd: for d in test/http ... test/e2e; do bun test ./$d | grep -E '^ [0-9]+ (pass|fail|skip)|^Ran '; done]
- Measured total of that loop: 851 tests run, 846 pass, 0 fail, 5 skip. [cmd: bun test ./test/http ./test/contract ... -> 469+294+34+24+15+11+4 = 851]
- `test/http/` exercises handler-level request/response envelopes plus mounted routes over real HTTP; its biggest and strongest case is the session-read family (30 cases: list/active/get/messages/wait/view/log/transport wiring). [test/http/session-read.test.ts:217]
- `test/contract/` validates the checked-in JSON contracts and fixtures with the real checker; its strongest file is the opencode contract suite (14 cases), which mutates samples and asserts the checker names the endpoint. [contracts/opencode/session.get.json:1]
- `test/translate/` exercises senpi event -> opencode frame projection; lifecycle.test.ts is the largest (14 cases) covering started/succeeded/failed/abort/usage-once. [test/translate/lifecycle.test.ts:64]
- `test/model/` exercises durable session keys, state file corruption, flush and message projection; session-map.test.ts is strongest (17 cases). [test/model/session-map.test.ts:64]
- `test/senpi/` exercises the SenpiTransport against a fake host: error mapping, client declaration, run boundary, queue/idle facade; transport.test.ts is the only executable file (14 cases). [test/senpi/transport.test.ts:55]
- `test/bridge/` exercises UI-request classification (permission vs question vs form vs status) against recorded contract frames; ui-requests.test.ts is the only file (11 cases). [test/bridge/ui-requests.test.ts:41]
- `test/e2e/` exercises the bridge through the real my-tui client library instead of hand-written fetch calls; real-client.test.ts is the only file (4 tests, all skipped). [test/e2e/real-client.test.ts:13]
- Root-level files (6 files, 28 `test(` calls) cover the CLI/launcher/runtime surface; launcher.test.ts is strongest (13 cases, 606 lines: launch spec, private agent dir, model probe, start, stop). [test/launcher.test.ts:219]
- `package.json` defines eight scripts, not five: dev, test, typecheck, contracts:check, surface:extract, surface:check, selfcheck, qa:tui. [package.json:10]
- `.github/` does not exist, so there is no CI workflow, no scheduled contract check and no automated test gate. [cmd: ls -d .github -> no such file or directory]

## Gaps

- The e2e layer is dormant by default: all 4 tests skip unless `OMO_BRIDGE_E2E_TUI_DIR` points at the TUI fork, so the real-client contract has no default coverage. [test/e2e/real-client.test.ts:13]
- The one senpi live-host test skips unless `OMO_BRIDGE_INTEGRATION=1`, leaving the real socket/transport path unexercised by the default run. [test/senpi/integration.test.ts:7]
- The requested measurement command omits the six root-level test files (28 cases), so its 851 total is not the whole suite. [cmd: wc -l test/*.test.ts -> 6 files, 1004 lines]
- No CI: without `.github/`, `contracts:check`, `surface:check` and `bun test` only run when a human invokes them. [cmd: ls -d .github -> absent]
- The bridge directory is thin: one file and 11 cases cover only title/request classification, not the bridge's turn or event routing. [test/bridge/ui-requests.test.ts:41]
- Contract tests assert the checker's own output over copies; they do not prove the runtime emits the same shapes (translate/stream uses fixtures, not a live host). [test/translate/stream.test.ts:50]
- Root launcher tests are unit-level with fakes; nothing verifies the installed `bin/omo-bridge` binary end to end. [test/launcher.test.ts:346]

## Claims

- The suite is large at the HTTP layer (469 of 851 measured cases) and thin at the client-facing layers (e2e 4, bridge 11). | [cmd: per-directory bun test totals] | high
- The default test run never exercises the real TUI client. | [test/e2e/real-client.test.ts:13] | high
- The repo has no CI workflow. | [cmd: ls -d .github -> absent] | high
- package.json declares 8 scripts, so the task's premise of five is wrong. | [package.json:10] | high
- The strongest http case is session-read.test.ts (30 cases). | [test/http/session-read.test.ts:217] | medium
- The strongest contract case is opencode.test.ts (14 cases). | [test/contract/opencode.test.ts:77] | medium
