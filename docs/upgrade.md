# Upgrading omo-bridge

The bridge sits between two upstreams, and either one can move:

| Upstream | Pinned here | What can break |
| --- | --- | --- |
| `@code-yeongyu/senpi` | exact version in `package.json` | RPC frame shapes, event payloads, transport errors |
| my-tui OpenCode fork | commit in `contracts/SOURCE.md` | HTTP request and response schemas, event names, error tags |

They upgrade separately. Do one at a time, and finish with `bun run selfcheck`.

## Upgrading senpi

1. Change the exact pin in `package.json`. No caret, no range.
2. Install and let the lockfile move:

   ```sh
   bun install
   bun run contracts:check
   bun test
   ```

3. If the check is green, update the pinned version and the host note in `contracts/SOURCE.md`.
4. If it is red, the wire changed. Record fresh frames from a host and compare:

   ```sh
   bun run scripts/contracts-record.ts
   bun run contracts:check
   ```

   The recorder spawns `omo` (or `OMO_BRIDGE_OMO_BIN`) with `--mode rpc --multi-session`, records the
   six commands in `contracts/senpi/live.jsonl`, and stops the host. It never sends a prompt, so no
   model is called. The derived event fixtures in `contracts/senpi/events.jsonl` come from the pinned
   package's `docs/rpc.md`; check the doc at the new version before changing them.

### What a red senpi check means

A line prefixed `senpi:` points at one fixture record. The usual causes:

- A response field was renamed, retyped, or made optional in the pinned package.
- The host answered an unknown command, so the recorded frame no longer matches the validator.
- A fixture is stale after a pin bump and should be re-recorded.

A `bun test` failure after a green check means the bridge's own assumptions moved: translation,
transport, or session handling. Fix the bridge, not the check.

### Version skew

The pinned package and the `omo` host that actually runs may differ by a release. `contracts/SOURCE.md`
records which host produced the live frames. If the host is older than the pin, check that every shape
still exists in the pinned `docs/rpc.md`; a shape that only exists in the pin needs a note in
`contracts/SOURCE.md`, not a silent fixture edit.

## Upgrading the TUI contracts

The fork is read-only. The extractor parses it with the TypeScript compiler and never imports or
executes fork code, so it doesn't need the fork's dependencies.

1. Point `OMO_BRIDGE_OPENCODE_FORK` at the refreshed checkout if it isn't the default path.
2. Refresh the checked-in schemas. This is the `contracts:extract` step (the script has no package
   alias in this branch):

   ```sh
   bun run scripts/contracts-extract.ts --write
   ```

3. Read the diff. Line numbers move without being drift, so the comparison ignores the top-level
   `description` only. Field names, types, optionality, tags, `required` and `$comment` are real.
4. Update the commit, date and per-schema source lines in `contracts/SOURCE.md`.
5. Check and test:

   ```sh
   bun run contracts:check
   bun test
   ```

6. If `GET /api/info` should report a new version, update `BRIDGE_PROTOCOL_VERSION` in
   `src/http/server.ts`. Until that matches the fork, the TUI prints "Warning: Server at ... has
   version X; this client is Y. Continuing anyway." and continues.

### What a red opencode check means

A line prefixed `opencode:` carries the exact JSON path. The check fails on a renamed or retyped field,
a property that became optional, or a changed error tag list. It also fails on a schema file that no
longer belongs to the endpoint registry.

Don't regenerate just to turn the check green. Read the fork diff, then decide whether the bridge or
the contract needs the change. A blind `--write` erases the evidence that something moved.

## One command

```sh
bun run selfcheck
```

It runs `bun run typecheck`, `bun run contracts:check`, and `bun test` in order. Success prints
`selfcheck: ok`; any failure prints the failing step and its captured output, then exits non-zero.
Use it as the last gate for either upgrade.
