# BRIDGE — running the OpenCode TUI on an unmodified official OmO runtime

This fork speaks the official OmO agent's JSONL RPC protocol in process. The official installation and its files are
never modified: the bridge launches the official `omo` host, authenticates, and drives the TUI from the frames that
host already sends.

**Scope: personal or internal use only. Do not publish, redistribute or publish packages built from this tree.**

Capability status as measured on 2026-11-25, row by row and per plan task: [`BRIDGE-CAPABILITIES.md`](./BRIDGE-CAPABILITIES.md) (Chinese). It is derived from `packages/bridge-core/spec/capabilities.json` and replaces the stale counts in `BRIDGE-SCOPE.md`.

## Install and run

```sh
cd product/opencode
bun --no-env-file install --ignore-scripts          # workspace install
bun --no-inline-install --watch packages/cli/src/index.ts   # dev run
bun run --cwd packages/cli dev                      # launcher without a build
bun run --cwd packages/cli build:bridge             # builds dist-bridge/ (bundle + arm64/x64 binaries)
```

`build:bridge` exits 0 and writes three things under `packages/cli/dist-bridge/`:

- `bridge-run.js` — 11,647,824 bytes. The bundle. **Not a standalone binary**: the per-platform native addons stay
  external by design, so it runs only where `@opencode/pty-*` resolves beside it.
- `bridge-darwin-arm64/bridge-run` — 104,362,914 bytes (99.5 MiB), mode 0755. Compiled arm64 binary with its own
  `node_modules` (`@opencode/pty` 0.4.0, `@opentui/core` 0.8.1).
- `bridge-darwin-x64/bridge-run` — 115,043,808 bytes (109.7 MiB), mode 0755. The same for x64; on Apple Silicon it
  runs only under Rosetta (`arch -x86_64 <binary>`).

Both binaries refuse a launch without `--socket`: they print `BRIDGE_STATE_DETAIL=usage: --socket requires a path`
and exit 2. That refusal is the release gate `script/distribution.ts` (artifact exists, is executable, refuses a
missing `--socket`), which `build:bridge` itself calls — a build that produced an unstartable binary exits 1 instead
of succeeding.

Measured 2026-11-24T08:13Z on this tree; the build log, both launch attempts with exit codes, the sizes and the gate
output are in `.omo/evidence/t32-rebuild-20261124T081338Z/`.

## Isolation

- The host runs from the official image `bridge-host-official:5.1.75` in a throwaway container
  (`docker run --name bridge-qa-* …`), never from a user's installation and never against a user's home directory.
- QA cases stage their own HOME/XDG roots under a temporary directory and remove the container when they finish;
  the cleanup receipt for each run is written next to its result.
- Nothing in this tree reads `~/.omo`, credentials or session files belonging to the person running it.

## Version reprobe

The target is the **published** official version, currently `5.1.75`. 5.1.67 never existed on npm, which is why the
plan's version decision moved to the latest published release. To reprobe:

```sh
npm view omo-ai@latest version            # channel and version
bun --no-env-file tools/bridge-qa/run.ts case official-5167-reprobe --out "$QA_EVIDENCE/t03-reprobe"
```

A version that cannot be resolved is **BLOCKED**, never substituted by a Git tag or a nearby release.

## Upgrade drill

1. reprobe the version as above and record channel, version and digest;
2. rebuild or re-pull the official image and note the digest;
3. run the full QA sweep (`tools/bridge-qa`) and diff the results against the previous run;
4. re-run `get_protocol_info` and diff the declared method and capability lists
   (`.omo/evidence/protocol-command-list/` holds the last capture);
5. update `packages/bridge-core/spec/capabilities.json` only where a case backs the change.

## Capability boundaries (measured, 2026-11-18)

- **No terminal pane.** The host declares no PTY/terminal method or capability, so the terminal pane cannot load;
  the bridge's `pty-surface` mints tokens but has nothing to connect to.
- **No session switching.** `switch_session`/`attach_session` are declared but unused by the bridge, and their
  payloads are not what a session listing reports.
- **No session-lifecycle events.** `stream.ts` handles only prompt/partial/message/tool/idle/reset.
- **No thinking-level control.** Neither command is called anywhere in the bridge.
- **Approval prompts depend on the host.** With the launch path this bridge uses, tools ran without a prompt even
  under `permission-preset ask`.
- The row-by-row state is `packages/bridge-core/spec/capabilities.json`; `.omo/evidence/STATUS-2026-11-18.md` is
  the readable summary of what is verified and what is not.

## Rollback

The worktree's git index is **empty** (`git ls-files` returns 0) and nothing from this work was committed, so there is
no commit to roll back to. Before relying on this tree, capture it: commit it, or copy it somewhere versioned. That
is the first thing to fix if this becomes more than a personal experiment.

## User data protection

- Host sessions land in the container's `/home/bridge`, not in the person's home.
- QA cases must pass their own HOME/XDG roots; a case that would touch the real home is a defect, not a shortcut.
- Never copy a real `~/.omo` into a test container, and never point a QA run at a real session directory.
