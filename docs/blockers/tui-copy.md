# TUI 文案自有的首屏面（tui-copy-owned）

`first-minute` 场景把每个首屏弹窗判成四种 `uiResult` 之一（定义见 `script/qa/scenarios/first-minute.mjs` 头部注释）：

| uiResult | 含义 |
| --- | --- |
| `content` | 弹窗列出了至少一行该面本该列出的内容 |
| `tui-copy-owned` | 弹窗零行，并渲染了一句**该面自己的**、由 TUI 撰写的状态文案；这句文案宣称了一个桥侧并不支持的状态 |
| `not-wired` | 弹窗零行，只有 DialogSelect 的通用兜底文案 `No items available`（`packages/tui/src/ui/dialog-select.tsx:750-753`），屏幕上没有任何解释 |
| `failed` | 错误文案出现在帧里 |

本文件只列 `tui-copy-owned` 的面。数据来自一次完整运行：`bun run qa:tui -- --scenario first-minute`，证据在
`.omo/evidence/test-system-hardening/task-13/`（`report.json` + 七个 `frame-<surface>.txt` + `frame.png`）。

面的名字沿用计划里的写法；MCP 一面在 TUI 里的真实斜杠命令是 `/mcps`（`packages/tui/src/app.tsx:969-976`），`/mcp` 只会让自动补全出现该建议、不打开弹窗，所以下表的 `not-wired` 行写的是 `/mcps`。

桥侧口径一律以 `GET /api/bridge/capabilities`（`contracts/bridge/capabilities.json`）为准；实际答案由同一次运行对
`/api/worktree`、`/api/experimental/usage/limits` 的探测给出。

## 台账

| 面 | TUI 文案 | 出处 | 文案宣称什么 | 桥侧实际答案 | 台账 | 为什么是 blocker |
| --- | --- | --- | --- | --- | --- | --- |
| `/usage` | `Sign in to OpenCode Console with /connect to see your workspace's usage limits.` | `packages/tui/src/component/usage.tsx:125` | 这个 location 没登录 OpenCode Console，用 `/connect` 登录后就能看到额度 | `GET /api/experimental/usage/limits` → `200 {"data": null}`（`src/http/handlers/degraded.ts:249-253`） | `usage`，`capability: false` | 桥根本没有 OpenCode Console workspace，`null` 是端点声明的“未登录”；`/connect` 永远不会把这个状态变成有数据。于是**已经连上 provider 的用户**（本次帧里 `opencode-go` 是已连接）被文案要求去连接——正是 `docs/test-system-review.md:118` 判失败的那句“已连接 provider 却提示去连接”。 |
| worktree（`/worktrees`，命令名 `session.move`） | `No worktrees available`（`...:357`）/ `No worktrees found`（`...:363`）；`new` 失败时 toast `Creating workspace failed`（`packages/tui/src/component/prompt/move.tsx:59`） | `packages/tui/src/component/dialog-workspaces.tsx:357,363` | 这里存在一个 worktree 集合，当前是空的，用户可以在其中新建/移动/删除 | `GET /api/worktree` → `200 []`；`POST /api/worktree` → `400 {"_tag":"WorktreeError","message":"worktrees are not supported by the omo-native engine"}`（`src/http/handlers/degraded.ts:77-94`）；`DELETE` 同样 400 | `worktree`，`capability: false` | 桥没有 checkout manager：一个 senpi 会话绑定一个 cwd，不存在 worktree 集合。文案把“不支持的功能”画成“支持但为空”，用户按下 `new` 才看到失败。 |

## 未列入（不是 tui-copy-owned）

| 面 | uiResult | 判据 |
| --- | --- | --- |
| `/models` | `content` | 已连接分支列出 33 个宿主模型中的 9 个（`frame-models.txt`），桥 `GET /api/model` 200。 |
| `/connect` | `content` | 列出 `opencode-go`（`frame-connect.txt`），桥 `GET /api/integration` 200。 |
| `/skills` | `content` | 列出 5 个 skill：`bun`、`context7-mcp`、`design-taste-frontend`、`find-skills`、`gpt-image-gen`（`frame-skills.txt`），桥 `GET /api/skill` 200/5 行。 |
| `/plugins` | `content` | 列出 TUI 自带/已安装插件行（本次一行为 `oh-my-openagent@latest failed`，`frame-plugins.txt`）；这些行由 TUI 自己给出，桥 `GET /api/plugin` 声明为空。它是有内容，不是“文案自有”。 |
| `/mcps` | `not-wired` | 弹窗只有通用兜底 `No items available`（`frame-mcp.txt`）；`dialog-mcp.tsx` 没有自己的空态文案，桥 `GET /api/mcp` 声明为空。补一句“MCP 未接入”属于“给通用兜底加文案”，不是本文件所指的界面自有文案。 |

## 处理边界

两处文案都在只读参考仓库 `/Users/zyno/OmO Projects/my-tui/opencode` 里，本仓库不改它。可选的收口方向：

1. 桥侧：为 worktree 提供真实的 checkout 管理（成本高）；或让 usage 端点返回一个声明的“不支持”错误而不是 `null`，让 TUI 走错误分支而不是未登录文案。
2. TUI 侧：把两句空态改成“该功能未接入”（需要动 fork，另行裁决）。

在任一侧收口前，`first-minute` 场景会持续把这两面判为 `tui-copy-owned`；task 16 只引用本文件并同步文档，不重复判定。
