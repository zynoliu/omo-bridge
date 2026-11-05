# Derived senpi frames

`contracts/senpi/events.jsonl` is not recorded from a live host. Each line is a documentation example
carrying `"source": "derived"` and `"derived": true`, and the doc line it came from in
`node_modules/@code-yeongyu/senpi/docs/rpc.md` (the normative wire reference of the pinned
`@code-yeongyu/senpi` `2026.11.4-2`).

These events cannot be produced without a model turn, and the contract job forbids calling a model, so a real
capture is off the table. They are still checked: `validateEvent` rejects an unknown `type`, a missing
`usage`, a malformed delta union, a `tool_execution_*` frame without its correlation fields, and an
`extension_ui_request` without a valid dialog method.

| # | event | doc line | shape note |
| --- | --- | --- | --- |
| 1 | `message_update` `text_start` | `rpc.md:6141` | block start, `contentIndex: 0` |
| 2 | `message_update` `text_delta` | `rpc.md:6142` | `delta` chunk |
| 3 | `message_update` `text_end` | `rpc.md:6144` | final `content` for the block |
| 4 | `message_update` `thinking_start` | `rpc.md:6125` (table) | thinking block start |
| 5 | `message_update` `thinking_delta` | `rpc.md:6125` (table) | thinking chunk |
| 6 | `message_update` `thinking_end` | `rpc.md:6125` (table) | final thinking `content` |
| 7 | `message_update` `toolcall_start` | `rpc.md:6152` | `id` + `toolName`, plus top-level `resolvedToolName` |
| 8 | `message_update` `toolcall_delta` | `rpc.md:6135` (table) | argument chunk |
| 9 | `message_update` `toolcall_end` | `rpc.md:6137` (table) | full `toolCall` object |
| 10 | `tool_execution_start` | `rpc.md:6186` | `toolCallId`, `toolName`, `args` |
| 11 | `tool_execution_update` | `rpc.md:6197` | accumulated `partialResult` |
| 12 | `tool_execution_end` | `rpc.md:6213` | final `result` and `isError` |
| 13 | `agent_start` | `rpc.md:5971` | optional `runId` (older engines omit it) |
| 14 | `agent_end` | `rpc.md:5983` | `messages` array and `willRetry` |
| 15 | `queue_update` | `rpc.md:6231` | `steering` and `followUp` string arrays |
| 16 | `extension_ui_request` `select` | `rpc.md:6782` | permission prompt: `title`, `options`, `toolCallId` |
| 17 | `extension_ui_request` `question` | `rpc.md:6952` | `questions[].options`, `multiSelect`, `raisedBy`, deadline fields |

Deliberate completions of the doc's placeholders:

- Every `message_update` carries a full `usage` object (`input`, `output`, `cacheRead`, `cacheWrite`,
  `totalTokens`, `cost`) where the docs show `{...}`, so the frame validates as a whole.
- `agent_end.messages` holds one minimal assistant message (`role`, `content`, `stopReason`, `usage`) instead
  of the doc's `[...]` placeholder.
- `tool_execution_*` frames use one consistent `toolCallId`/`toolName` pair so they can be correlated as a
  single call, which is what the docs describe.

The plan asked for "all 8 delta kinds"; the docs table lists nine block-level kinds and the pinned package's
`@earendil-works/pi-ai` types confirm nine, so all nine are shipped.
