# Direct external dependencies

Read from the installed packages under `node_modules` on 2026-11-18. Only **direct** dependencies of
`packages/cli` and `packages/tui` are listed; the workspace packages (`@opencode/*`) are this repository.
Transitive licences are not enumerated here — that is a separate, larger audit and is not claimed.

| package | version | licence |
|---|---|---|
| @agentclientprotocol/sdk | 1.6.0 | Apache-2.0 |
| @clack/core | 1.0.0-alpha.1 | MIT |
| @clack/prompts | 1.0.0-alpha.1 | MIT |
| @effect/platform-node | 4.1.0 | MIT |
| @opentui/core | 0.8.1 | MIT |
| @opentui/keymap | 0.8.1 | MIT |
| @opentui/solid | 0.8.1 | MIT |
| @opentunnel/client | 0.6.1 | MIT |
| @parcel/watcher | 2.5.1 | MIT |
| @silvia-odwyer/photon-node | 0.3.4 | Apache-2.0 |
| @solid-primitives/event-bus | 1.1.2 | MIT |
| diff | 8.0.4 | BSD-3-Clause |
| effect | 4.1.0 | MIT |
| fuzzysort | 3.1.0 | MIT |
| get-east-asian-width | 1.6.0 | MIT |
| immer | 11.1.4 | MIT |
| jsonc-parser | 3.3.1 | MIT |
| picocolors | 1.1.1 | ISC |
| remeda | 2.26.0 | MIT |
| solid-js | 1.9.17 | MIT |
| string-width | 7.2.0 | MIT |
| strip-ansi | 7.1.2 | MIT |
| web-tree-sitter | 0.25.10 | MIT |
| ws | 8.21.0 | MIT |

Notes:

- `@lydell/node-pty-*` and `@ff-labs/fff-bin-*` appear as **dev** dependencies of `packages/cli`; they are
  per-platform native helpers and are not shipped as product runtime dependencies.
- `@xterm/xterm` is a test-only dependency and must never become a product runtime dependency; it does not
  appear in the tables above.
