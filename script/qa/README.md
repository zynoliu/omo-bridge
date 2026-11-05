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
- `--help` usage

Exit code `0` means the scenario's assertions held; anything else means they did not, and the report says why.

## Prerequisites

- A standalone bun at `/opt/homebrew/bin/bun` (override with `OMO_BRIDGE_QA_BUN`). The OmO runtime bun cannot load the fork's `libopentui`.
- The my-tui checkout named by `OMO_BRIDGE_TUI_DIR` (default `/Users/zyno/OmO Projects/my-tui/opencode`). It is read-only reference and is never modified.
- No network access is required.

## What a run does

1. Starts an isolated bridge: temporary state directory, random port in 4500-4899, random password; waits for `GET /api/info` to answer 200.
2. Launches `bun run bin/omo-bridge tui` in a PTY (no `--session`, so the launcher's own session bootstrap is exercised).
3. Renders the PTY stream into a parsed screen grid (`script/qa/lib/frame.mjs`), so assertions read rendered text rather than raw ANSI.
4. Types `你好`, presses `Enter`, and classifies the outcome as exactly one of:
   - `reply` — a new assistant line appeared,
   - `error` — a failure or "session not found" line appeared,
   - `idle` — neither appeared before the timeout.
5. Stops the TUI and the bridge, then writes the evidence.

## Evidence layout

| File | Content |
| --- | --- |
| `report.json` | outcome, checks, durations, exit code, render mode, screenshot path, evidence paths |
| `frame-before.txt` | parsed screen before typing |
| `frame-after.txt` | parsed screen after the run |
| `transcript.txt` | raw PTY stream |
| `bridge.log` | bridge stdout/stderr for this run |
| `frame.png` | screenshot of the parsed frame (only when `renderMode: "webview"`) |

## Reproducing a failure

A run is only evidence that the suite can fail when the failure is injected, not borrowed from a
flaky provider. This suite has observed both outcomes on one machine:

- green (`outcome: "reply"`) when the assistant answers;
- non-zero (`outcome: "error"`) when the provider returns an upstream error — the frame showed
  `Session failed` / `the provider returned an unexpected error`, and the report carried that text.

There is no injected-fault mode yet: `--agent-dir` points the bridge at another agent directory but
the host still resolves its model catalog, so it does not by itself produce a deterministic red.

## Cleanup

The runner stops the TUI and the bridge it started and waits for the port to close. Verify by hand:

```sh
pgrep -fl omo-bridge        # no process carrying this run's state directory
lsof -nP -i :<port>         # empty for the port printed in report.json
```

The bridge state directory lives under the OS temp dir; the runner removes nothing else.

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
