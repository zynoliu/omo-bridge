# omo-bridge

A local HTTP bridge that speaks the my-tui OpenCode V2 API and runs a private senpi host behind it.
The TUI fork keeps its own client; the bridge turns HTTP requests into senpi RPC frames and projects
senpi events back into OpenCode events.

It's a local tool, not a hosted service: one bridge process, one private host, one password.

## What it does

- Serves the routes the TUI reads and writes (`src/http/routes/index.ts`) behind HTTP Basic auth.
  The username is always `opencode`; the password comes from `OMO_BRIDGE_PASSWORD`.
- Starts and owns a senpi host on `<stateDir>/senpi.sock` from `launch-spec.json`. It never talks to
  the machine-wide daemon and never touches the shared `~/.omo/agent/rpc/rpc.sock`.
- Records its url, pid, password and socket in `<stateDir>/bridge.json` (mode 0600), so `status` and
  `stop` can find it again.
- Reconnects the senpi transport in the background when the private host goes away. Session routes
  answer 503 while it is detached.

The state directory defaults to `./state` (gitignored). Set `OMO_BRIDGE_STATE_DIR` to move it.

## Requirements

- Bun 1.4.4.
- An `omo` binary on `PATH`, or `OMO_BRIDGE_OMO_BIN` / `OMO_BIN` pointing at one.
- The my-tui fork at the commit recorded in `contracts/SOURCE.md`. That checkout is read-only
  reference material; see the rule below.

## Quickstart

Three commands, two shells.

```sh
# 1. Install the bridge dependencies.
bun install

# 2. Start the bridge in the foreground. Keep this shell open.
bun run bin/omo-bridge start
```

The launcher prints its url, `http://127.0.0.1:4319` by default (override with `OMO_BRIDGE_PORT`).
It also generates a password and writes it to `state/bridge.json`. If you want a fixed one, export
`OMO_BRIDGE_PASSWORD` before starting. Either value is the `OPENCODE_PASSWORD` the TUI must send.

```sh
# 3. Launch the TUI against that bridge. One command; it reads the url and password from
#    state/bridge.json and gives the TUI its own state directory.
bun run bin/omo-bridge tui
```

`tui` forwards extra arguments to the TUI, so `bun run bin/omo-bridge tui --session <id>` opens a
session directly. It runs the fork's `bun run dev --server <url>` under a standalone Bun
(`OMO_BRIDGE_TUI_BUN`, default: the Bun running the launcher) with `OMO_BRIDGE_TUI_DIR` naming the
checkout (default: the reference fork above).

The TUI keys its persisted tabs by channel (`<XDG_STATE_HOME>/opencode/<channel>/tui/tabs.json`), so
two backends sharing a channel share one tab list - and a tab opened against the real opencode
service carries a session id the bridge does not have, which is why switching between them shows
"session not found". `tui` sets `OPENCODE_TUI_CHANNEL=bridge-<hash of the bridge state dir>`, so each
bridge gets its own tabs and sessions from different backends never mix.

Attaching by hand works too, as long as the channel stays distinct:

```sh
cd "/Users/zyno/OmO Projects/my-tui/opencode"
OPENCODE_TUI_CHANNEL=bridge OPENCODE_PASSWORD=<pw> bun run dev --server http://127.0.0.1:<port>
```

`bun run dev` in the fork runs `bun run --cwd packages/cli src/index.ts`. Run the TUI under a
standalone Bun install, not the OmO-bundled Bun: that binary is the OmO runtime and cannot load the
fork's native OpenTUI library. To read the generated password:

```sh
bun -e 'console.log((await Bun.file("state/bridge.json").json()).password)'
```

If you set `OMO_BRIDGE_PASSWORD` yourself, use that value and skip the lookup.

To check or end a bridge from another shell:

```sh
bun run bin/omo-bridge status
bun run bin/omo-bridge stop
```

`stop` ends only the pid and socket recorded in `state/bridge.json`. It refuses to signal anything
outside that state directory.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| TUI exits with "Server at ... requires a password; set OPENCODE_PASSWORD", or requests get `401 {"_tag":"UnauthorizedError"}` | The TUI sent no credential, or the bridge password is not the one you passed | Export `OPENCODE_PASSWORD` with the exact value from `state/bridge.json`. The username is fixed as `opencode`. |
| TUI exits with "Server at ... rejected the password" | `OPENCODE_PASSWORD` is set but does not match `OMO_BRIDGE_PASSWORD` | Re-read `state/bridge.json`; restart the bridge with a known `OMO_BRIDGE_PASSWORD` if the generated one was lost. |
| `bun run bin/omo-bridge start` exits with "OMO_BRIDGE_PASSWORD is required" | You ran `bun run dev` (`src/index.ts`) instead of the launcher, and the direct server has no password generation | Use `bun run bin/omo-bridge start`, or export `OMO_BRIDGE_PASSWORD` for the direct server. |
| TUI prints "Warning: Server at ... has version 2.2.5; this client is local. Continuing anyway." | A dev checkout reports its client version as `local`, so any bridge looks mismatched. A released client warns when `BRIDGE_PROTOCOL_VERSION` (`src/http/server.ts`) no longer matches | The connection continues. The warning is expected for a local dev build. For a release client, update the constant and refresh the contracts; see `docs/upgrade.md`. |
| Session reads or writes answer `503 {"_tag":"ServiceUnavailableError"}` | No transport is attached: the private host failed to start, was stopped, or the bridge is between reconnect attempts | Read the start log for "senpi transport not connected" or "could not start a private senpi host". Check that `omo` runs, that `launch-spec.json` is valid, and that `status` reports reachable. |
| Start log says "no senpi transport (OMO_BRIDGE_SENPI_SOCKET is unset); session routes answer 503" | You started `src/index.ts` directly; only the launcher creates the private socket | Use the launcher, or point `OMO_BRIDGE_SENPI_SOCKET` at a host you started yourself. |
| Error: "refusing to use the shared senpi socket ..." | `OMO_BRIDGE_SENPI_SOCKET` points into `~/.omo/agent/rpc/` | Remove the override. The launcher creates `<stateDir>/senpi.sock` and refuses the shared daemon on purpose. |
| Error: "refusing to use a socket outside the bridge state directory" | The configured socket lives somewhere other than `<stateDir>` | Keep the socket inside `OMO_BRIDGE_STATE_DIR`, or drop the custom socket path. |
| Error: "another omo-bridge is already running (pid ..., url ...)" | `state/bridge.json` names a live process | Use that bridge, or run `bun run bin/omo-bridge stop` first. A dead pid is cleaned automatically on the next start. |

## Read-only fork rule

These rules are binding, and they come from `AGENTS.md`:

- The TUI fork at `/Users/zyno/OmO Projects/my-tui` is read-only reference. Never edit, commit, or
  run git commands there.
- Never write `~/.local/state/opencode/service.json`.
- Never connect to or stop the shared `~/.omo/agent/rpc/rpc.sock`.
- Never import `@code-yeongyu/senpi/rpc-entry`.
- No npm publish.

## What it does not do

The bridge only serves what senpi can back. Missing capabilities are answered by explicit shims so
the TUI degrades visibly instead of breaking. The endpoint-by-endpoint ledger, including the status
and error tag for each path, is in `DEGRADATIONS.md`.

In short, it does not provide worktrees, persistent terminals, connect/credential flows, device pairing,
OpenCode Console usage, an MCP server registry, or a server plugin registry. It does report the provider
integrations senpi already has (a provider with models and a stored credential), but it cannot start a
connect flow or store a credential. Saved permission rules are
recorded, but their update and delete routes are not mounted. V1 migration answers `completed` because
the bridge starts from an empty state directory. For the exact gaps and the TUI behaviour behind each
one, read `DEGRADATIONS.md`.

## Verify

```sh
bun run selfcheck
```

This runs the typecheck, the contract check, and the full test suite, then prints one summary line.

`bun run check:all` is the gate to use instead when you want everything: version pin, typecheck,
contracts, surface, the full suite with the `src/` coverage floor (90% lines / 92% funcs), and the
`test/rule` data-source and capability rules. It exits non-zero on the first failing stage and prints
the number each stage measured. `--allow-version-mismatch` accepts a bun that differs from the pin,
`--allow-missing-fork` skips the two stages that need the read-only fork checkout.
Any failure exits non-zero and shows the failing step's output. Upgrading either upstream is covered
in `docs/upgrade.md`.
