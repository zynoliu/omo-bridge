# Bridge 能力状态说明（2026-11-25）

本文从能力账本 `packages/bridge-core/spec/capabilities.json` 的 105 行逐行导出，不是评审意见，也不是承诺。每一行的状态、分组归属和缺口描述都以该文件的 `status`、`implementationTask`、`userScope`、`semanticDifference` 字段为准；发布判定由 `matrix-release-check` 读同一份文件得出。同目录的 `BRIDGE-SCOPE.md` 是 2026-11-19 的人读版本，行状态已经过时，两者冲突时以本文和账本为准。

## 一句话现状

105 行里 **57 行 verified、2 行 degraded、46 行 unsupported、0 行 unverified**；这 57 行逐行的主题与证据载体见第 5 节。发布门 `matrix-release-check` 当前退出码 1，阻塞项只有两行：P-619 与 P-685，两处都是宿主边界，不是本侧实现缺口。46 行范围外全部带有用户批准记录：45 行来自 2026-11-19 的决定，1 行（N-MINI）来自 2026-11-18 的决定。

## 1. 按计划任务分组

`implementationTask` 把 105 行分到 13 个计划任务；标题取自 `.omo/plans/bridge-product-plan.md`。账本本身由 95 条协议映射行、3 条兼容 seam 行和 7 条原生表面行组成（`protocol-row` / `compatibility-seam` / `native-surface`）。任务 11、13 至 17、20、22、28 至 32 在这 105 行里没有归属，因为行来自协议审计与原生表面盘点，不是计划任务清单本身的展开。

| 计划任务 | 能力域 | verified | degraded | unsupported | 缺口说明 |
|---|---|---|---|---|---|
| 7 | 实现 JSONL 传输与认证边界 | 1 | 0 | 0 | 无。事件订阅、keepalive 与事件 id 全绿 |
| 8 | 实现会话身份和生命周期 | 23 | 2 | 16 | 两行 degraded 都在这里：移动与归档观测不到（P-619），agent 选择只能转成提示前缀（P-685）。其余 16 行范围外，多为删除、fork、会话切换、shell、压缩与快照回滚 |
| 9 | 实现流式消息与工具结果投影 | 2 | 0 | 0 | 无 |
| 10 | 实现权限与结构化对话安全状态机 | 4 | 0 | 1 | 保存型持久权限规则（P-667）范围外 |
| 12 | 实现输入队列、取消和模型状态 | 1 | 0 | 2 | 中断命令宿主接受但行为未验（P-626）；取消入站消息范围外（P-632） |
| 18 | 实现同机文件、差异与安全检查点 | 1 | 0 | 2 | 文件与差异主路径绿；worktree 与 vcs 表面范围外（P-753、P-754） |
| 19 | 实现 macOS 本地 PTY 与终端面板 | 0 | 0 | 1 | 唯一一行范围外：宿主不发布 shell 列表（P-746） |
| 21 | 实现 memory、team 与通知侧栏 | 3 | 0 | 0 | 无 |
| 23 | 适配 Mini 独立入口与 promise 客户端 | 0 | 0 | 1 | Mini seam 有代码与测试，但本轮不交付（N-MINI，2026-11-18 决定） |
| 24 | 适配并验证 TUI 插件公开契约 | 1 | 0 | 1 | 插件契约绿；`plugin.*`、`rpc.call` 与 TUI 插槽范围外（P-771） |
| 25 | 实现客户端 MCP 与独立配套扩展 | 2 | 0 | 1 | MCP 注册与工具变更绿；`mcp.list` 目录范围外（P-717） |
| 26 | 实现配置、模型、命令与 MCP 状态面 | 17 | 0 | 16 | 范围外行集中在 agent.list、模型收藏、凭据激活、内置命令面板、skill、MCP 连接、实验接口与 pair 等 |
| 27 | 覆盖其余已列原生功能与降级语义 | 2 | 0 | 5 | CodeMode 与 boulder 两行绿；终端监视、LSP、computer-use、搜索与 brand 范围外 |

合计 105 行：57 + 2 + 46。

## 2. 全部非 verified 行（48 行）

“原因”一列只有三种：宿主边界，即宿主不提供或不接受该能力；用户批准，即本轮按用户决定不做；用户决定不交付，即代码在但不承诺实机证据。

| 行 | 主题 | 状态 | 缺口 | 原因 |
|---|---|---|---|---|
| P-619 | session.created / updated / deleted / moved / archived / renamed | degraded | 创建、删除与改名有真实载体（宿主帧加拉取 diff）；宿主既不声明也不接受归档命令，`move_session` 只搬文件、`get_state.cwd` 不变，所以归档与移动观测不到 | 宿主边界 |
| P-685 | session.prompt 的 agent 字段 | degraded | `prompt` 没有 agent 字段，命令表里也没有选择 agent 的命令；桥接把 agent 名称转成一段说明性前缀并写进会话上下文，宿主仍用会话自己的 agent 执行这一轮 | 宿主边界 |
| P-609 | session.remove | unsupported | 桥接不提供删除命令，未做等价评估 | 用户批准 |
| P-610 | session.fork | unsupported | 实测拒绝：fork 拒收变更条目（`Invalid entry ID for forking`），新会话树里没有可 fork 的消息条目，造条目需要真实模型回合 | 用户批准 |
| P-611 | session.switchAgent | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-613 | session.move（更改会话目录） | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-615 | session.background | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-616 | session.active / 会话切换 | unsupported | 两个切换命令都未被调用；探测显示 `switch_session` 分别以宿主错误和 `unknown_session` 拒绝，`attach_session` 返回 `session_identity_mismatch` | 用户批准 |
| P-617 | session.environment | unsupported | 宿主没有终端或环境命令，桥接以 `UnsupportedCapability` 拒绝，终端面板因此没有可连目标 | 用户批准（宿主也没有该表面） |
| P-629 | session.command | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-630 | session.shell | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-631 | session.synthetic | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-703 | session.command 执行 | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-711 | session.skill / skill.activated | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-732 | session.compact | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-734 | session.revert.*（快照回滚） | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-747 | session.shell 的输出事件 | unsupported | 客户端事件流只有 `server.connected` 握手，shell 输出既不转发也不合成 | 用户批准（宿主没有输出事件） |
| P-755 | session.diff（按回合的快照 diff） | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-667 | permission.saved.*（持久规则 CRUD） | unsupported | 未评估：账本只记录范围，不记录等价性；桥接不提供该组命令 | 用户批准 |
| P-626 | session.interrupt | unsupported | 宿主声明并通过路由 id 接受该命令（有实测），但本行描述的行为仍未验证 | 用户批准 |
| P-632 | inbox.cancel | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-753 | worktree.* | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-754 | vcs.get / status / branch / diff（工作副本） | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-746 | shell.list / get / output / remove | unsupported | 宿主不发布 shell 列表，适配层返回空数组与 `undefined` 让布局能画；没有任何 shell 记录或输出被投影 | 用户批准（宿主也没有该表面） |
| N-MINI | Mini 独立入口与 promise 客户端 | unsupported | seam 的代码与测试存在，但本轮不交付，不声称任何实机 Mini 证据 | 用户决定不交付 |
| P-771 | plugin.* / rpc.call / @opencode/plugin/tui 插槽 | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-717 | mcp.list / mcp.resource.catalog | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-683 | agent.list | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-693 | model 默认值 / 收藏 / 近期使用 | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-695 | credential.activate / integration.oauth.* | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-704 | OC 内置命令帮助 / 完成面板 | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-710 | skill.list | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-718 | experimental.mcp.connect / disconnect | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-735 | experimental.session.export | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-736 | experimental.session.wait | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-737 | experimental.session.log | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-763 | OC integrations / 外部消息入站 | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-772 | server.pair | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-773 | websearch.providers | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-774 | experimental.migration.v1.status | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-775 | reference.list | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-776 | project.list | unsupported | 桥接不实现，未评估 | 用户批准 |
| P-777 | integration.list（OC 集成） | unsupported | 桥接不实现，未评估 | 用户批准 |
| N-U-03 | terminal monitor | unsupported | 宿主不发布终端帧，客户端 PTY 又需要桥接不运行的 server | 用户批准（宿主也没有该表面） |
| N-U-04 | LSP attached text | unsupported | 宿主不发布 LSP 帧 | 用户批准（宿主也没有该表面） |
| N-U-05 | computer-use hints | unsupported | 宿主不发布 computer-use 帧 | 用户批准（宿主也没有该表面） |
| N-U-06 | search widget | unsupported | 宿主不发布搜索组件帧 | 用户批准（宿主也没有该表面） |
| N-U-07 | brand | unsupported | brand 是客户端常量，不是宿主事实，没有可映射的宿主表面 | 用户批准（宿主也没有该表面） |

48 行 = 2 行 degraded + 46 行 unsupported。

## 3. 范围外能力按原因分组

2026-11-19 的决定原话是「同意不做（推荐）」和「和刚才的一起放到本轮交付之外，整理一个文档说明情况」。这条决定把桥接不打算对齐的 OpenCode 表面移出本轮发布阻塞，但它们在代码里是主动拒绝（抛 `UnimplementedApiGroup` / `UnsupportedCapability`），不是漏写。分组如下。

### A. 用户批准，且宿主本身没有该表面（8 行，2026-11-19 第二批）

| 行 | 主题 | 宿主侧事实 |
|---|---|---|
| P-617 | session.environment | 没有终端或环境命令 |
| P-746 | shell.list / get / output / remove | 没有 shell 列表 |
| P-747 | session.shell 的输出事件 | 没有 shell 输出事件 |
| N-U-03 | terminal monitor | 没有终端帧 |
| N-U-04 | LSP attached text | 没有 LSP 帧 |
| N-U-05 | computer-use hints | 没有 computer-use 帧 |
| N-U-06 | search widget | 没有搜索组件帧 |
| N-U-07 | brand | brand 是客户端常量，不是宿主事实 |

### B. 用户批准不做（37 行，2026-11-19 第一批）

P-609 session.remove，P-610 session.fork，P-611 session.switchAgent，P-613 session.move，P-615 session.background，P-616 session.active / 会话切换，P-626 session.interrupt，P-629 session.command，P-630 session.shell，P-631 session.synthetic，P-632 inbox.cancel，P-667 permission.saved.*，P-683 agent.list，P-693 model 默认值 / 收藏 / 近期使用，P-695 credential.activate / integration.oauth.*，P-703 session.command 执行，P-704 OC 内置命令帮助 / 完成面板，P-710 skill.list，P-711 session.skill / skill.activated，P-717 mcp.list / mcp.resource.catalog，P-718 experimental.mcp.connect / disconnect，P-732 session.compact，P-734 session.revert.*（快照回滚），P-735 experimental.session.export，P-736 experimental.session.wait，P-737 experimental.session.log，P-753 worktree.*，P-754 vcs.get / status / branch / diff，P-755 session.diff，P-763 OC integrations / 外部消息入站，P-771 plugin.* / rpc.call / TUI 插槽，P-772 server.pair，P-773 websearch.providers，P-774 experimental.migration.v1.status，P-775 reference.list，P-776 project.list，P-777 integration.list。

### C. 用户单独决定本轮不交付（1 行，2026-11-18）

N-MINI：Mini 独立入口与 promise 客户端。用户原话「mini看起来用处不大，可先不接」，计划任务 23 已标 `[~]` 移出交付。这一行是三类里唯一代码与测试都在、但没有实机证据的：seam 本身有 `packages/tui/test/bridge/mini.test.ts` 覆盖，本轮不声称它能用。

## 4. 复核方式

全部命令在 `product/opencode` 下执行，`$QA_EVIDENCE` 指向一个新目录（`run.ts` 要求输出目录事先不存在）。

```sh
cd product/opencode
bun --no-install --no-env-file tools/bridge-qa/run.ts case matrix-release-check --out "$QA_EVIDENCE/release"
bun --no-install --no-env-file tools/bridge-qa/run.ts case matrix-complete --out "$QA_EVIDENCE/complete"
bun --no-install --no-env-file tools/bridge-qa/run.ts case matrix-missing-row --out "$QA_EVIDENCE/missing"
bun --no-install --no-env-file tools/bridge-qa/run.ts case event-vocabulary-live --out "$QA_EVIDENCE/events"
```

2026-11-25 在本工作树重跑前三条的结果：`matrix-release-check` 退出码 1，读出的分布是 `verified=57, unsupported=46, degraded=2`，阻塞行是 `P-619=degraded, P-685=degraded`，59 行证据引用全部可解析；`matrix-complete` 退出码 0（95 条协议行全部映射，3 条 seam 全部映射）；`matrix-missing-row` 退出码 0（删掉一行的副本剩 104 项，校验器按预期拒绝：protocolRowCount 95 与 94 条不匹配）。`event-vocabulary-live` 需要真实宿主，本轮没有重跑，最近一次 65/65 通过记录在 `.omo/evidence/matrix-closeout-20261124T183421Z/`。

本文的证据位置：

- 计算出的分布、按任务分组、48 行非 verified 清单与范围外分组：`.omo/evidence/capability-doc-20261125T041852Z/computed-counts.json`；
- 上述三条门禁的本次输出：同目录下的 `matrix-release-check/`、`matrix-complete/`、`matrix-missing-row/`；
- 账本本身：`product/opencode/packages/bridge-core/spec/capabilities.json`；
- 计划任务标题：`.omo/plans/bridge-product-plan.md` 的 Todos 段。

## 5. 全部 verified 行（57 行）

本节给出第 2 节的反面：105 行里状态为 `verified` 的 57 行，分组与第 1 节相同。字段全部取自 `capabilities.json` 的 `key`、`sourceTopic`、`implementationTask`、`test` 与 `evidence`，没有新增行。证据载体一栏只写 `test` 字段里可被机器执行的那部分，即 case 文件加检查名，或单元测试文件；叙述性说明和 `evidence` 里的结果目录留在账本里。

按任务计数：任务 7 有 1 行，8 有 23 行，9 有 2 行，10 有 4 行，12 有 1 行，18 有 1 行，21 有 3 行，24 有 1 行，25 有 2 行，26 有 17 行，27 有 2 行；任务 19 与 23 没有 verified 行。

| 计划任务 | 行 | 主题 | 证据载体（case 检查名或测试文件） |
|---|---|---|---|
| 7 传输与认证 | P-603 | GET /event（SSE，keepalive 15s，idle 45s） | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-603-server-connected-first、P-603-projection-summary、P-603-keepalive-and-idle-watchdog、P-603-event-ids-ascend、P-603-subscriber-released）、`packages/bridge-core/test/host-projection-event-cluster.test.ts` |
| 8 会话身份与生命周期 | P-605 | session.list | `tools/bridge-qa/cases/api-surface-live.ts`（pullHostState 之后调 session.list，报出 1 个会话） |
| 8 会话身份与生命周期 | P-606 | session.create | `tools/bridge-qa/cases/matrix-session-lifecycle.ts`（连到隔离宿主的已认证连接） |
| 8 会话身份与生命周期 | P-607 | session.get | `tools/bridge-qa/cases/matrix-session-lifecycle.ts`（连到隔离宿主的已认证连接） |
| 8 会话身份与生命周期 | P-608 | session.update（title / archived 等） | `tools/bridge-qa/cases/matrix-session-lifecycle.ts` |
| 8 会话身份与生命周期 | P-612 | session.switchModel | `tools/bridge-qa/cases/api-surface-live.ts`（session.switchModel 到达宿主，宿主回以切换后的模型） |
| 8 会话身份与生命周期 | P-614 | session.view | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 8 会话身份与生命周期 | P-625 | session.prompt（SessionMessage + parts） | `tools/bridge-qa/cases/docker-host-model-turn.ts`（宿主回显 clientMessageId）、`tools/bridge-qa/cases/tui-real-host.ts`（真实 PTY 上输入得到助手回复） |
| 8 会话身份与生命周期 | P-639 | session.message.get / 历史分页 | `tools/bridge-qa/cases/messages-live.ts`（session.message.get 返回所问 id 的那条消息） |
| 8 会话身份与生命周期 | P-640 | session.text.start / delta / end | `tools/bridge-qa/cases/stream-cumulative.ts`、`tools/bridge-qa/cases/tui-stream.ts` |
| 8 会话身份与生命周期 | P-641 | session.reasoning.start / delta / end | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-641-reasoning-started-delta、P-641-reasoning-delta-host-wire）、`packages/bridge-core/test/host-projection-event-cluster.test.ts` |
| 8 会话身份与生命周期 | P-643 | session.step.start / finish | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-643-step-started、P-643-step-ended）、`packages/bridge-core/test/host-projection-event-cluster.test.ts` |
| 8 会话身份与生命周期 | P-644 | session.execution.* / session.idle / session.status | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-644-execution-started、P-644-execution-started-host-wire、P-644-text-ended、P-644-agent-idle、P-644-execution-succeeded、P-644-execution-interrupted）、`packages/bridge-core/test/host-projection-event-cluster.test.ts`（turn_end 的成功与中断两例） |
| 8 会话身份与生命周期 | P-645 | session.retry.scheduled | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-645-retry-scheduled、P-645-retry-cleared、P-645-retry-failed）、`packages/bridge-core/test/host-projection.test.ts`（auto_retry_start 排定重试，auto_retry_end 报告结果） |
| 8 会话身份与生命周期 | P-646 | session.usage.* | `tools/bridge-qa/cases/messages-live.ts`（host-reports-token-usage）、`packages/cli/test/bridge-pull.test.ts` |
| 8 会话身份与生命周期 | P-647 | session.message.content.updated | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-647-content-update-from-entry、P-647-content-updated-client-contract、P-647-reasoning-ended-from-host-message-end；65/65 PASS），红捕获 red-p647-disable 只关掉这条发射就有 38 项失败 |
| 8 会话身份与生命周期 | P-654 | session.tool.input.start / delta / end | `tools/bridge-qa/cases/stream-null-reset.ts` |
| 8 会话身份与生命周期 | P-655 | session.tool.called | `tools/bridge-qa/cases/stream-null-reset.ts` |
| 8 会话身份与生命周期 | P-656 | session.tool.progress / running 状态 | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-656-tool-running、P-656-tool-running-host-wire、P-656-tool-progress）、`packages/bridge-core/test/host-projection-event-cluster.test.ts`（tool_execution_start 与 tool_execution_update 两例） |
| 8 会话身份与生命周期 | P-657 | session.tool.success / failed / error | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-657-tool-success、P-657-tool-success-host-wire、P-657-tool-error-declared-vocabulary、P-657-tool-error）、`packages/bridge-core/test/host-projection-event-cluster.test.ts` |
| 8 会话身份与生命周期 | P-665 | session.permission.reply（once / always / reject） | `tools/bridge-qa/cases/tui-permission-once.ts`（BRIDGE_QA_PERMISSION_CHOICE） |
| 8 会话身份与生命周期 | P-668 | session.permissions 事件 / 会话级规则 | `tools/bridge-qa/cases/permission-rules-live.ts`（allow 不问、deny 不跑且模型读到规则理由、ask 只弹一次；10/10 PASS，真实回合）、`tools/bridge-qa/cases/permission-rules-event.ts`（8/8 PASS）、`tools/bridge-qa/cases/permission-rules-surface.ts`（8/8 PASS，/rules 面板显示 2 条规则） |
| 8 会话身份与生命周期 | P-694 | session 级 thinking / effort | `tools/bridge-qa/cases/thinking-level-live.ts`（BRIDGE_QA_MODEL_KEY 下四项：pull-stores-the-available-levels、explicit-provider-and-model-is-the-supported-read、a-set-level-is-what-the-next-pull-reports、the-host-does-not-validate-an-unknown-level）、`packages/bridge-core/test/host-capabilities.test.ts`、`packages/tui/test/bridge/config.test.tsx` |
| 8 会话身份与生命周期 | P-733 | session 压缩相关事件 | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-733-compaction-started、P-733-compaction-delta-ended）、`packages/bridge-core/test/host-projection-event-cluster.test.ts` |
| 9 流式消息与工具投影 | P-638 | message.list | `tools/bridge-qa/cases/messages-live.ts`（一个真实回合之后，transcript 列出它的消息） |
| 9 流式消息与工具投影 | P-642 | SessionMessage parts（text / reasoning / tool 等） | `tools/bridge-qa/cases/messages-live.ts`（part-surface-answers-for-the-selected-session） |
| 10 权限与结构化对话 | P-664 | permission.list / session.permission.list | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-664-permission-list-store、P-666-permission-asked）、`packages/tui/test/bridge/bridge-data.test.ts`（权限事件落到会话权限列表，答复后清除） |
| 10 权限与结构化对话 | P-666 | permission.asked / replied 事件 | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-666-permission-asked、P-666-permission-replied） |
| 10 权限与结构化对话 | P-674 | form.list / session.form.list | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-674-form-created-second、P-674-form-list-store）、`packages/tui/test/bridge/bridge-data.test.ts`（form 事件落到会话 form 列表，取消后清除） |
| 10 权限与结构化对话 | P-676 | form.asked / replied / cancelled | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-676-form-created、P-676-form-replied、P-676-form-cancelled）、`packages/bridge-core/test/host-projection.test.ts`（created、按字段键回复、超时取消） |
| 12 输入队列与模型状态 | P-675 | session.form.reply / cancel | `packages/tui/test/bridge/bridge-data.test.ts`（回复落到宿主 question 对话框、未列出的值以自由文本发出、取消关闭对话框）、`tools/bridge-qa/cases/event-vocabulary-live.ts`（P-675-form-replied-from-response、P-675-form-cancelled-from-response） |
| 18 文件、差异与检查点 | P-756 | file.list / find / read | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 21 memory、team 与通知 | P-627 | inbox.update（steer） | `tools/bridge-qa/cases/matrix-session-lifecycle.ts` |
| 21 memory、team 与通知 | P-628 | inbox / follow-up 队列 | `tools/bridge-qa/cases/matrix-session-lifecycle.ts` |
| 21 memory、team 与通知 | P-762 | inbox.list 与 inbox 事件 | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-762-inbox-enqueued、P-762-inbox-delivery-changed、P-762-inbox-delivered、P-762-inbox-cancelled）、`packages/tui/test/bridge/bridge-data.test.ts` |
| 24 TUI 插件契约 | N-PLUGIN | TUI 插件公开上下文（client/data/renderer/UI） | `packages/tui/test/bridge/plugin-contract.test.tsx`、`tools/bridge-qa/cases/plugin-real-renderer.ts` |
| 25 客户端 MCP 与配套扩展 | P-719 | mcp.tools.changed | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-719-mcp-catalogue-refresh、P-719-mcp-tools-changed-client-contract；65/65 PASS），红捕获 red-p719-disable 去掉这条发射后恰好这两项失败 |
| 25 客户端 MCP 与配套扩展 | N-MCP | 客户端 MCP 与 registerMcpServer 差异 | `tools/bridge-qa/cases/extension-mcp-live.ts`（13/13 PASS：启动器写入 profile、profile 保留其他设置、宿主加载配套扩展并回答 registerMcpServer、回复带路由句柄、宿主发起的 client-MCP 请求往返）、`packages/cli/test/bridge-agent-profile.test.ts`（11 pass，红捕获 red-launcher-call-removed.log 与 red-write-removed.log）、`packages/cli/test/bridge-mcp.test.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-604 | server.info | `tools/bridge-qa/cases/api-surface-live.ts`（连到隔离宿主的已认证连接） |
| 26 配置、模型、命令与 MCP 状态面 | P-618 | location.get | `tools/bridge-qa/cases/matrix-session-lifecycle.ts`（连到隔离宿主的已认证连接） |
| 26 配置、模型、命令与 MCP 状态面 | P-648 | ID 体系：msg_ / part_ / per | `tools/bridge-qa/cases/matrix-session-lifecycle.ts`（P-648-msg-id-scheme、P-648-msg-id-stable-across-pulls、P-648-msg-ids-distinct、P-648-host-entry-in-metadata、P-648-live-events-carry-client-ids、P-648-live-and-pulled-views-agree、P-648-parts-of-a-real-turn；28/28 PASS，真实回合）、`packages/bridge-core/test/id-scheme.test.ts`、`packages/bridge-core/test/host-projection.test.ts`（红捕获 red-final/result.json 与 unit-red-ids.log） |
| 26 配置、模型、命令与 MCP 状态面 | P-658 | 无直接对等（可忽略或显示等待） | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-658-unknown-frames-ignored、P-603-projection-summary）、`packages/bridge-core/test/host-projection.test.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-677 | OC form 必填约束（若有） | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-677-required-field-published、P-677-required-field-refused、P-677-required-field-settled、P-677-required-field-error-shape）、`packages/bridge-core/test/host-projection.test.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-684 | agent.custom.* 事件 | `tools/bridge-qa/cases/event-vocabulary-live.ts`（P-684-extension-event-routed、P-684-extension-event-unattached、P-684-agent-custom-client-contract；65/65 PASS），红捕获 red-p684-disable |
| 26 配置、模型、命令与 MCP 状态面 | P-691 | model.list | `tools/bridge-qa/cases/api-surface-live.ts`（拉取后宿主给回 130 个模型） |
| 26 配置、模型、命令与 MCP 状态面 | P-692 | provider.list | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-696 | experimental.usage.limits | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-702 | command.list | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-725 | 子会话 / composer subagents 标签页 | `packages/tui/test/bridge/bridge-data.test.ts`（session.create 把 parentID 带给 opener 并把乐观行挂到父节点下）、`tools/bridge-qa/cases/child-session-live.ts`、`packages/bridge-core/test/opencode-api.test.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-726 | 会话树 / 分组 | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-738 | experimental.session.stats | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-739 | 消息编辑 / 从某条继续（dialog-message 等） | `tools/bridge-qa/cases/assistant-edit-live.ts`（9/9 PASS，真实回合：通道上的成员、未接线 seam 的类型化拒绝、stale_leaf 在写入前被拒、宿主改后的结果、原条目仍在会话文件里、not_assistant、无文件还原）、`tools/bridge-qa/cases/message-branch-live.ts`（8/8 PASS，2 个真实回合）、`packages/tui/test/bridge/message-channel.test.ts`、`packages/bridge-core/test/opencode-api.test.ts`（红捕获 red-assistant-edit-live/result.json 与 message-branch-live-red/result.json） |
| 26 配置、模型、命令与 MCP 状态面 | P-745 | experimental.persistentPty.* / pty.* | `tools/bridge-qa/cases/terminal-open-resize.ts`（80x24 打开，resize 到 120x40，shell 回显 "40 120"）、`packages/bridge-core/test/pty-api.test.ts`（api 组映射） |
| 26 配置、模型、命令与 MCP 状态面 | P-769 | config.get / update | `tools/bridge-qa/cases/matrix-read-surface-live.ts` |
| 26 配置、模型、命令与 MCP 状态面 | P-770 | theme / keybinds | `packages/tui/test/bridge/tui-config-local.test.ts`（6 例：文档里的 theme 与 keybinds、缺省值、非法文档忽略、宿主预设优先、环境文档合并、实时重读）、`packages/cli/src/bridge-config.ts` |
| 27 其余原生功能 | N-U-01 | CodeMode activity | `packages/tui/test/bridge/other-features.test.tsx` |
| 27 其余原生功能 | N-U-02 | boulder / loop status | `packages/tui/test/bridge/other-features.test.tsx` |

合计 57 行。这个数字不靠人工点数：`matrix-release-check` 的 `matrix-reports-its-own-distribution` 检查项直接打印账本分布，2026-11-25 在本工作树重跑读出 `verified=57, unsupported=46, degraded=2`，与本表行数一致；命令就是第 4 节的第一条。
