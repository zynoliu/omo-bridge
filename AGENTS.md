# AGENTS.md

Binding rules for this repository. They are not suggestions.

- The TUI fork at /Users/zyno/OmO Projects/my-tui/opencode may be edited when a bridge change needs a client-side capability (user decision, 2026-11-06). Client-side edits follow that fork's own AGENTS.md; regenerate its client types with `bun run generate` after a schema change.
- Never write ~/.local/state/opencode/service.json.
- Never connect to or stop the shared ~/.omo/agent/rpc/rpc.sock.
- Never import `@code-yeongyu/senpi/rpc-entry`.
- No npm publish.
