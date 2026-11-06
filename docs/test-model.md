# Test model

Every user-visible claim in this repository points at the layer that proves it and the command that
runs it. A row without both is not a test, it is an intention.

## Layers

| Layer | What it proves | Command | Runs |
| --- | --- | --- | --- |
| L0 contract | every generated schema and recorded sample still matches the fork | `bun run contracts:check` | every commit |
| L1 unit | bridge internals (projection, transport, handlers) | `bun test ./test/{translate,model,senpi,bridge}` | every commit |
| L2a real client | the fork's own client decodes what the bridge serves | `bun test ./test/e2e` | every commit (fork checkout required) |
| L2b bridge integration | recorded host frames produce the right events and order | `bun test ./test/http` | every commit |
| L2c single source | one datum, every read path agrees | `bun test ./test/rule` | every commit |
| L3 end to end | a real host and a real TUI agree | `bun run qa:tui -- --scenario send-message` | before delivery |
| L4 UI/UX | what the user sees on the first screen | `bun run qa:tui -- --scenario first-minute` | before delivery |
| L6 rules/capability | an unwired family says so instead of answering empty | `bun test ./test/rule` | every commit |
| gate | all of the above in one command | `bun run check:all` | every commit |

## Defect → proof

| Gap | Claim | Layer | Case | Command |
| --- | --- | --- | --- | --- |
| GAP-1 `/models` empty | a connected provider lists the host's models | L4 | `models-dialog` (`outcome: models`) | `bun run qa:tui -- --scenario models-dialog` |
| GAP-1 (mechanism) | the picker's key and the catalog's key are the same directory | L1 | `tui-launch.test.ts` `tuiProjectDir`, `tui-session.test.ts` project-directory bootstrap | `bun test ./test/tui-launch.test.ts ./test/tui-session.test.ts` |
| GAP-2 reply above the prompt | the reply paints below the message it answers | L3 | `send-message` `checks.order` | `bun run qa:tui -- --scenario send-message` |
| GAP-2 (mechanism) | the client's pending row is cleared by `session.inbox.delivered` | L2b | `inbox.test.ts`, `prompt.test.ts`, `runtime.test.ts` | `bun test ./test/http/inbox.test.ts ./test/http/prompt.test.ts ./test/runtime.test.ts` |
| GAP-3 silent empty | a degraded family is declared, not implied by `[]` | L6 | `capability.test.ts` vs `contracts/bridge/capabilities.json` | `bun test ./test/rule/capability.test.ts` |
| GAP-3 one data source | `/api/skill` equals the command surface's `skill:` namespace | L2c | `single-source.test.ts` | `bun test ./test/rule/single-source.test.ts` |
| GAP-3 first screen | each first-screen dialog is content, an explicit refusal, or TUI-owned copy | L4 | `first-minute` (七个面 + `docs/blockers/tui-copy.md`) | `bun run qa:tui -- --scenario first-minute` |
| GAP-4 client contract skipped | the fork's client runs by default | L2a | `real-client.test.ts` (3 cases, no env needed) | `bun test ./test/e2e` |
| GAP-5 no gate | one command runs every check and reports numbers | gate | `scripts/check-all.ts` | `bun run check:all` |
| GAP-6 QA residue | a run leaves no state directory unless `--keep` | L3 | `qa:tui` cleanup (crash path writes `report.json`) | `bun run qa:tui -- --scenario does-not-exist` |
| GAP-7 fake host invents | the fake's handshake equals the recording | L1 | `fake-host-fidelity.test.ts` | `bun test ./test/senpi` |
| GAP-8 unknown fields allowed | a sample with one undeclared key is rejected | L0 | `opencode.test.ts` per-endpoint negative sample | `bun test ./test/contract` |
| GAP-9 attribution lost | a provider failure keeps `provider/model/code/resetsAt/action` | L1 | `lifecycle.test.ts` | `bun test ./test/translate/lifecycle.test.ts` |

## Rules

- A fix lands with the case that would have caught it, run red before the change.
- A pass counts only from the layer that can observe the claim: a handler test never stands in for a
  painted frame, and a green `bun test` never stands in for `check:all`.
- A surface the bridge cannot control (TUI-owned copy) is recorded in `docs/blockers/tui-copy.md`
  instead of being asserted as "wired".
- `docs/test-system-review.md` holds the reasoning behind this model; this file holds the index.
