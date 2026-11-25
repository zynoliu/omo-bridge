# Bridge 交付边界说明（2026-11-19）

本文件说明本轮交付实际覆盖了什么、明确不做什么、以及为什么。它对应能力账本 `packages/bridge-core/spec/capabilities.json`（共 105 行），以及 QA 用例 `matrix-release-check` 的判定规则：只有经用户明确批准的范围外行不计入发布阻塞，其余非 `verified` 行一律计入。

## 一句话结论

已实现的 31 行有真实回执；13 行已实现但语义窄于 OpenCode（待确认）；46 行经用户明确同意划出本轮交付（含 N-MINI）；15 行尚未实现或没有证据。合计 28 行（13 行 degraded + 15 行 unverified）仍然阻塞发布。

## 1. 已划出本轮交付（46 行，用户已批准）

用户 2026-11-19 的决定原话：「同意不做（推荐）」「和刚才的一起放到本轮交付之外」。这些行在代码里是主动拒绝（`packages/bridge-core/src/opencode-api.ts` 抛 `UnimplementedApiGroup`/`UnsupportedCapability`），不是没写。

| 行 | 主题 | 用户可见后果 |
|---|---|---|
| P-609 | session.remove | not yet observed at runtime |
| P-610 | session.fork | not yet observed at runtime |
| P-611 | session.switchAgent | not yet observed at runtime |
| P-613 | session.move（更改会话目录） | not yet observed at runtime |
| P-615 | session.background | not yet observed at runtime |
| P-616 | session.active / 会话切换 | not yet observed at runtime |
| P-617 | session.environment | in bridge mode the terminal panel cannot start, so the right column shows no terminal surface and the transcript/terminal/DAG switch has no terminal target |
| P-626 | session.interrupt | not yet observed at runtime |
| P-629 | session.command | not yet observed at runtime |
| P-630 | session.shell | not yet observed at runtime |
| P-631 | session.synthetic | not yet observed at runtime |
| P-632 | inbox.cancel | not yet observed at runtime |
| P-667 | permission.saved.*（持久规则 CRUD） | not yet observed at runtime |
| P-683 | agent.list | not yet observed at runtime |
| P-693 | model 默认值 / 收藏 / 近期使用 | not yet observed at runtime |
| P-695 | credential.activate / integration.oauth.* | not yet observed at runtime |
| P-703 | session.command 执行 | not yet observed at runtime |
| P-704 | OC 内置命令帮助/完成面板 | not yet observed at runtime |
| P-710 | skill.list | not yet observed at runtime |
| P-711 | session.skill / skill.activated | not yet observed at runtime |
| P-717 | mcp.list / mcp.resource.catalog | not yet observed at runtime |
| P-718 | experimental.mcp.connect / disconnect | not yet observed at runtime |
| P-732 | session.compact | not yet observed at runtime |
| P-734 | session.revert.*（快照回滚） | not yet observed at runtime |
| P-735 | experimental.session.export | not yet observed at runtime |
| P-736 | experimental.session.wait | not yet observed at runtime |
| P-737 | experimental.session.log | not yet observed at runtime |
| P-746 | shell.list / get / output / remove | shell and persistent-terminal surfaces show no shells in bridge mode; a shell cannot be listed, followed or removed, and the empty answer reads as 'no shells' r |
| P-747 | session.shell 的输出事件 | a shell's output never appears in bridge mode; the surfaces that would stream it stay empty instead of reporting an error |
| P-753 | worktree.* | not yet observed at runtime |
| P-754 | vcs.get / status / branch / diff（工作副本） | not yet observed at runtime |
| P-755 | session.diff（按回合的快照 diff） | not yet observed at runtime |
| P-763 | OC integrations / 外部消息入站 | not yet observed at runtime |
| P-771 | plugin.* / rpc.call / @opencode/plugin/tui 插槽 | not yet observed at runtime |
| P-772 | server.pair | not yet observed at runtime |
| P-773 | websearch.providers | not yet observed at runtime |
| P-774 | experimental.migration.v1.status | not yet observed at runtime |
| P-775 | reference.list | not yet observed at runtime |
| P-776 | project.list | not yet observed at runtime |
| P-777 | integration.list（OC 集成） | not yet observed at runtime |
| N-U-03 | terminal monitor | the surface shows the documented unavailable reason instead of an empty box |
| N-U-04 | LSP attached text | the surface shows the unavailable reason |
| N-U-05 | computer-use hints | the surface shows the unavailable reason |
| N-U-06 | search widget | the surface shows the unavailable reason |
| N-U-07 | brand | the surface shows the unavailable reason |
| N-MINI | Mini 独立入口与 promise 客户端 | the Mini entry point is not delivered this round; use the main TUI（用户 2026-11-18：「mini看起来用处不大，可先不接」；计划任务 23 已标 [~] 移出交付） |

本表中 N-MINI 是唯一例外：Mini seam 的代码与测试（`packages/tui/test/bridge/mini.test.ts`）存在，它不是代码层面的主动拒绝，而是本轮不交付，因此不声称任何实机 Mini 证据。

## 2. 已实现但语义窄于 OpenCode（本表 6 行；账本共 13 行 degraded，待确认）

这些行有真实回执，但覆盖面小于 OpenCode 原表面。在用户确认前它们不计为已验收。

| 行 | 主题 | 窄在哪 |
|---|---|---|
| P-603 | GET /event（SSE，keepalive 15s，idle 45s） | the bridge client event stream carries only the server.connected attachment handshake and stays open afterwards; no host frame is projected as an OpenCode event |
| P-664 | permission.list / session.permission.list | degraded: a permission.asked frame taken through decodeHostEvent reaches the store and reads back for its session; the transport leg is not exercised because th |
| P-674 | form.list / session.form.list | degraded: a form.created frame taken through decodeHostEvent reaches the store and reads back for its session (forms-decode case, 3/3); the transport leg is not |
| P-675 | session.form.reply / cancel | degraded: form.replied removes the form from the store and form.cancelled is decoded and applied, both through decodeHostEvent; the transport leg and any UI tha |
| P-762 | inbox.list 与 inbox 事件 | inbox.list is answered from the host's get_pending_inputs report in the client inbox shape, but no inbox event (session.inbox.enqueued/delivered/cancelled/deliv |
| N-MCP | 客户端 MCP 与 registerMcpServer 差异 | degraded: the client MCP path is exercised (client-mcp-allow / client-mcp-deny / client-unsupported pass), but registerMcpServer and the companion extension pat |

## 3. 尚未实现或没有证据（本表 24 行；账本 15 行 unverified，阻塞发布）

表格第三列保留审计原文（英文），以便与 `.omo/evidence/t31-row-audit-20261119/proposal.json` 逐行对照。

| 行 | 主题 | 缺口 |
|---|---|---|
| P-619 | session.created / updated / deleted / moved / archived / renamed | No case asserts a created/parked/closed status frame reaching the TUI session roster; only the initial snapshot pull is observed. |
| P-641 | session.reasoning.start / delta / end | No case asserts thinking text reaching the transcript or its rendering; stream.ts stores event.thinking and nothing observes it. |
| P-642 | SessionMessage parts（text / reasoning / tool 等） |  |
| P-643 | session.step.start / finish | No case or source path maps turn_start/turn_end to a step; no step model exists in the bridge. |
| P-644 | session.execution.* / session.idle / session.status | No case asserts a running-to-idle transition from host execution or status frames; bridge-data derives idle/running from the local registry. |
| P-645 | session.retry.scheduled | No case decodes or renders a retry-scheduled frame; the only retry handling in the fork is on the ACP transport, not the bridge. |
| P-646 | session.usage.* | Session usage is not projected: the launcher writes zero tokens into every session info and no case reads a host usage figure. |
| P-647 | session.message.content.updated | No case produces a content.updated snapshot; the bridge has partial text replacement only and no entry-snapshot synthesis. |
| P-648 | ID 体系：msg_ / part_ / per |  |
| P-656 | session.tool.progress / running 状态 | No case asserts incremental tool progress or a running state in the UI; only the final folded tool state is observed. |
| P-657 | session.tool.success / failed / error |  |
| P-658 | 无直接对等（可忽略或显示等待） |  |
| P-666 | permission.asked / replied 事件 |  |
| P-668 | session.permissions 事件 / 会话级规则 | Nothing projects session-level permission rules: the preset is logged to stderr and there is no rule engine to show. |
| P-676 | form.asked / replied / cancelled |  |
| P-677 | OC form 必填约束（若有） | No case asserts required-field enforcement; the question dialog sends its answers without a required check. |
| P-684 | agent.custom.* 事件 | No case decodes send_custom_message or an agent.custom event; no bridge code handles either. |
| P-685 | session.prompt 的 agent 字段 |  |
| P-694 | session 级 thinking / effort | The bridge never calls either thinking-level command, and the one attempt recorded a null read-back, so no selection or display path exists. |
| P-719 | mcp.tools.changed | No case decodes loaded_surfaces_changed and no MCP catalogue is delivered to refresh. |
| P-725 | 子会话 / composer subagents 标签页 | No case asserts child-session listing (include_workers/childrenOf) or subagent tabs; only the native task region is covered. |
| P-733 | session 压缩相关事件 | No case decodes a compaction frame; the transcript's compaction rows have no producer in the bridge. |
| P-739 | 消息编辑 / 从某条继续（dialog-message 等） | No bridge method or case edits a message or continues from a leaf, and the revert group refuses. |
| P-770 | theme / keybinds | No case asserts theme or keybind loading in bridge mode; both stay in the TUI's local configuration. |

## 4. 环境层面的已知阻塞

- 模型凭据：隔离宿主容器里没有任何 provider 凭据，`provider list` 为空、模型目录 0 个，因此所有需要模型真实回话的验证（模型列表、切换模型、真实消息回合、任务 26 的 `config-model-change`）都无法通过。官方 5.1.75 宿主没有可用的非交互注入方式：无 login 命令、不读 provider 环境变量、旧 `auth.json` 已迁移进数据库，试过的 `settings.json` 三种写法都返回 `credentials_not_configured`。
- macOS 客体镜像：任务 30 的原生验收需要 macOS 客体镜像；本机没有任何 `.ipsw`/`.vzvm`/`.utm`，且 `VZMacGuestProvisioningOptions` 需要 macOS 27（本机 26.6.2），只能走手工首次设置路径。该任务因此如实 BLOCKED。

## 5. 复核方式

- 账本：`packages/bridge-core/spec/capabilities.json`
- 结案判定：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case matrix-release-check --out <新目录>`
- 行级审计：`.omo/evidence/t31-row-audit-20261119/proposal.json`

## 6. 已知限制与未处理项（来自独立审查）

- **终端输入通路**：审查发现桥接 PTY 的 socket 缺少 `readyState`，导致面板能画输出却丢弃按键；已修复并新增真实测试（`packages/cli/test/bridge-pty.test.ts`，输入能在真实 shell 输出里看到，关闭后状态为 3）。注意 `tui-integrated` 的终端检查只数字节，抓不到这类缺陷。
- **桥接自有终端 store 未被产品路径使用**：`packages/tui/src/bridge/features/terminal/` 里的 cwd/env/跨会话守卫只被测试引用；实际面板走 fork 的 `PersistentPty`，即以启动器自身身份运行本地 shell。这是本地终端的预期行为，但那套守卫目前是未被接线的代码，不应被当作已生效的保护。
- **cwd 回退**：宿主公布的目录若在本机不存在，终端会落到启动器的位置（`spawnableCwd`），这使 `InvalidCwdError` 不可达；属于有意的产品取舍，已在此声明。
- **模型凭据与 macOS 客体镜像**：见第 4 节，均为环境阻塞而非实现缺口。
