# script/qa — automated TUI acceptance

Drives the real TUI against a real bridge with no human input, and leaves evidence you can inspect.

## One command

```sh
bun run qa:tui -- --scenario send-message
```

Options:

- `--scenario <name>` scenario module under `script/qa/scenarios/<name>.mjs` (default `send-message`)
- `--evidence-dir <dir>` where the run writes its evidence (default `<repo>/.qa/run-<timestamp>`)
- `--agent-dir <dir>` run the bridge against this agent directory (see “Reproducing a failure”)
- `--keep` keep the bridge state directory
- `--fault <name>` inject a failure the TUI survives (`host-down`, `bridge-down`, `provider-error`, `bogus-session`)
- `QA_REPLY_WAIT_MS` how long to wait for a painted reply (default 90000); raise it when the provider is slow

Scenarios: `send-message` (L3: submit, reply, order), `models-dialog` (L4: the picker lists the host's
models), `first-minute` (L4: seven first-screen surfaces, each content / explicit refusal / TUI-owned copy).
- `--help` usage

Exit code `0` means the scenario's assertions held; anything else means they did not, and the report says why.

## Prerequisites

- A standalone bun at `/opt/homebrew/bin/bun` (override with `OMO_BRIDGE_QA_BUN`). The OmO runtime bun cannot load the fork's `libopentui`.
- The my-tui checkout named by `OMO_BRIDGE_TUI_DIR` (default `/Users/zyno/OmO Projects/my-tui/opencode`). It is read-only reference and is never modified.
- No network access is required.

## What a run does

1. Starts an isolated bridge: temporary state directory, random port in 4500-4899, random password; waits for `GET /api/info` to answer 200.
2. Launches `bun run bin/omo-bridge tui` in a PTY (no `--session`, so the launcher's own session bootstrap is exercised).
3. Renders the PTY stream through **xterm.js** in a page (`script/qa/lib/xterm.mjs`), so assertions read xterm's rendered buffer rather than raw ANSI; `QA_RENDERER=tmux` falls back to a tmux pane and `script/qa/lib/frame.mjs` parses its output.
4. Types `你好`, presses `Enter`, and classifies the outcome as exactly one of:
   - `reply` — a new assistant line appeared,
   - `error` — a failure or "session not found" line appeared,
   - `idle` — neither appeared before the timeout.
5. Stops the TUI and the bridge, then writes the evidence.

## Evidence layout

| File | Content |
| --- | --- |
| `report.json` | outcome, checks, durations, exit code, render mode, screenshot path, evidence paths, and a `history` cross-check read from the bridge (`total`, `assistant`, `lastText`). When the scenario module fails to load or the scenario throws, this file is still written and carries `error` plus the `stack` |
| `frame-before.txt` | parsed screen before typing |
| `frame-after.txt` | parsed screen after the run |
| `transcript.txt` | raw PTY stream |
| `bridge.log` | bridge stdout/stderr for this run |
| `frame.png` | screenshot of the rendered terminal (only when `renderMode: "webview"`) |

## Reproducing a failure

A green run proves the path works; it does not prove the suite can fail. `--fault` injects a real
failure the TUI survives, so the evidence still has a frame to read:

```sh
bun run qa:tui -- --scenario send-message --fault host-down
```

`host-down` kills the bridge's private senpi host after the TUI is ready. The TUI stays up, the
prompt cannot run, and `report.json` says `outcome: "error"` with a frame showing e.g.
`Failed to prepare session` / `Failed to switch model: UnexpectedStatus: 503`. A second mode,
`--fault bridge-down`, stops the whole bridge; that run also exits non-zero but its frame is empty
because the app exits with the bridge, so it is the weaker evidence.

Observed on this machine: the bare command is green (the assistant answers), `--fault host-down` is
red with a readable frame.

## Cleanup

The runner stops the TUI and the bridge it started and waits for the port to close. Verify by hand:

```sh
pgrep -fl omo-bridge        # no process carrying this run's state directory
lsof -nP -i :<port>         # empty for the port printed in report.json
```

The bridge state directory lives under the OS temp dir and is removed when the run stops, together with the private host it started. `--keep` leaves it in place for inspection. Nothing outside that directory is removed.

## Adding a scenario

Create `script/qa/scenarios/<name>.mjs` default-exporting:

```js
export default {
  name: "<name>",
  async run(ctx) {
    const bridge = await ctx.startBridge({});
    const tui = await ctx.startTui({ stateDir: bridge.stateDir, cols: 120, rows: 36 });
    // tui.write(text), tui.press("Enter"), tui.waitFor(fn, ms), tui.text(), tui.transcript(), tui.screenshot(path)
    await tui.stop();
    await bridge.stop();
    return { exitCode: 0, report: { scenario: "<name>", outcome: "reply" } };
  },
};
```

`ctx` also exposes `createSession`, `writeFile(name, content)` (writes into the evidence directory), `repo` and `bunExe`.
