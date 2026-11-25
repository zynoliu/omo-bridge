# Bridge 计划偏离说明（2026-11-19）

本文件在交付前列出**实际执行与 `.omo/plans/bridge-product-plan.md` 原文之间的每一处偏离**，以及每处的性质、影响与证据位置。它不是免责声明：凡是能力面被缩小的偏离，都在这里单独标注，并经用户明确批准或如实保持未验证。

当前状态：计划 **29/36 勾选**，7 项未勾（23、30、31、F1–F4）；能力矩阵 `verified=31 / degraded=14 / unverified=15 / unsupported=45`。

## 1. 用户批准的范围偏离

| # | 计划原文 | 实际执行 | 性质 | 证据 |
|---|---|---|---|---|
| D1 | 目标工件为官方 OmO **5.1.67** | 改用最新已发布的 **5.1.75**（5.1.67 从未发布）；任务 3、29、30、31 与最终验收均以此为目标 | 用户批准（记录于计划任务 3 的「版本决定 2026-11-17」） | 计划任务 3 条目；npm 注册表指纹记录在同条目 |
| D2 | 任务 23：适配并验收 Mini 独立入口 | **移出本轮交付**：条目保留、不勾选、不删除 | 用户原话「mini看起来用处不大，可先不接」 | 计划任务 23 条目 |
| D3 | 能力矩阵 105 行逐行验证 | **45 行标为范围外**（`userScope: out of scope: user-approved 2026-11-19`）：37 行第二批之外主动拒做的表面 + 8 行先前已标 unsupported 的同类项 | 用户两次批准：「同意不做（推荐）」「和刚才的一起放到本轮交付之外，整理一个文档说明情况」 | `product/opencode/BRIDGE-SCOPE.md`；`packages/bridge-core/spec/capabilities.json` 的 `userScope` 字段 |

这三项是**唯一**经用户同意缩小交付范围的地方。除此之外没有任何功能被静默削减。

## 2. 计划点名的产物不存在，已补齐

| # | 计划原文 | 实际执行 | 影响 | 证据 |
|---|---|---|---|---|
| D4 | 任务 32 失败场景 `case package-missing-artifact` | 该用例**当时并不存在**（运行返回 `UNKNOWN_CASE` exit 66），本次新写 | 覆盖从无到有：抽出 x64 产物目录后发布门报 `missing=x64` | `tools/bridge-qa/cases/package-missing-artifact.ts`；`.omo/evidence/t32-missing-b/` |
| D5 | 任务 26 成功场景 `case config-model-change` | 该用例**从未存在**，本次按真实宿主新写 | 任务 26 因此才具备成功场景证据 | `tools/bridge-qa/cases/config-model-change.ts`；`.omo/evidence/t26-model-change-20261119/` |

## 3. 因环境事实而改变的执行方式

| # | 计划原文 | 实际执行 | 原因 | 证据 |
|---|---|---|---|---|
| D6 | 任务 28 验收：`cd product/opencode && bun test ./packages/tui/test/bridge` | 等价形式 `cd packages/tui && bun test ./test/bridge`（170 → 现 **172 pass**） | 产品根目录不加载 tui 的 bunfig solid preload，按字面运行会得到 18 个 `Cannot find module 'react/jsx-dev-runtime'`；`--preload` 亦无法从根解析 | 计划 F2 条目记录了完整实测 |
| D7 | F2：`bun run lint` 必须退出 0 | 全仓 lint 仍 **exit 1**（550 warnings / 95 errors，6934 文件），集中在 gui-plugins 等**本计划未改动**的包；本轮改动的 15 个文件单独 oxlint 为 **0/0** | 既有问题，不属本计划范围，也不做 suppress | 计划 F2 条目；ledger `f2_lint_scope_measured` |
| D8 | 计划假定所有命令在产品根执行 | 计划文件位于主工作区 `.omo/plans/`，产品代码在 wave-a 工作树；F1/F4 用例需要 `BRIDGE_PLAN_PATH` 指向主工作区计划 | 工作树不携带计划，避免复制计划副本 | `final-plan-audit.ts` 的 `findPlan`；计划 F1/F4 条目 |
| D9 | 模型凭据由用户安全提供 | 宿主**不读任何 provider 环境变量**，凭据为 `<agentDir>/auth.json` 的 `{"<provider>":{"type":"api_key","key":"…"}}`；凭据以 0600 仅存于仓库外临时目录，经 stdin 写入容器，用后删除，不入库、不入镜像、不入日志 | 计划要求凭据不得落盘到仓库；实现方式由执行者确定 | `tools/bridge-qa/cases/model-credential.ts`；ledger `provider_credential_injection_solved` |
| D10 | 任务 30：macOS 虚拟机验收 | **BLOCKED，不勾选**：主机 Virtualization.framework 齐全，但整机无任何 `.ipsw`/`.vzvm`/`.utm`，且 `VZMacGuestProvisioningOptions` 要求 macOS 27（主机 26.6.2） | 缺用户提供的客体镜像；不降级为假通过 | `.omo/evidence/t30-native-b/`；`tools/bridge-qa/macos-vm/guard.ts` |

## 4. 证据与状态口径的修正（自我更正）

| # | 先前的说法 | 更正 | 证据 |
|---|---|---|---|
| D11 | 矩阵证据引用「改写 49 处」 | 实际是 **32 行**的证据引用改为可解析路径，另 5 行把 `none yet`/散文换成真实测试文件 | 计划任务 31 条目已更正；`matrix-release-check` 新增逐路径存在性检查 |
| D12 | `matrix-release-check` 只统计状态分布 | 新增硬检查 `every-verified-row-cites-existing-evidence`：任一**路径类** token 不解析即失败（此前一个能解析的 token 会掩盖其余悬空引用） | `.omo/evidence/t31-matrix-e/` |
| D13 | `macos-native-full` 只在设了 `BRIDGE_MACOS_GUEST_IMAGE` 时通过 | 改为走 `guard` 评估，缺镜像或隔离即返回 **BLOCKED**（新增 BLOCKED 判定，exit 3，与 PASS/FAIL 区分） | `.omo/evidence/t30-native-b/` |
| D14 | F1 审计能正确判定勾选与依赖 | 修复两个解析缺陷：不认大写 `[X]`（任务 24 曾被误报）、把已移出交付的任务 23 当未完成 | 计划 F1 条目；`.omo/evidence/f1-final-e/` |

## 5. 独立审查发现并已修复的缺陷

gate reviewer（`deep-high`，报告 `.omo/evidence/session-review-20261119/REVIEW.md`）给出 **NEEDS_FIX**，其中真实缺陷均已修复：

- **终端面板吞按键**：桥接 PTY socket 缺 `readyState`，而面板每次写入都以 `readyState === WebSocket.OPEN` 为前置，导致能画输出却丢弃所有按键。已补 `readyState`（1 打开 / 3 关闭）并新增真实 shell 输入测试 `packages/cli/test/bridge-pty.test.ts`。
- **历史消息 0 个 part**：`part.list` 只从实时投影取数，已拉取的消息恒返回空；且旧用例那条检查恒为真。现改为回退到宿主消息自身内容（text/reasoning/tool），用例改为要求三类齐全。
- **矩阵释出检查被单个 token 掩盖**、**macOS 用例环境变量假通过**：见 D12、D13。

审查中**未修复但已记录**的两项（写入 `BRIDGE-SCOPE.md` 第 6 节）：`packages/tui/src/bridge/features/terminal/` 的守卫未被产品路径使用；`spawnableCwd` 使 `InvalidCwdError` 不可达（有意取舍）。

## 6. 行状态下调（不是放宽口径）

以下行由 `unverified` 下调为 `degraded`，每一条都写明窄在哪：

| 行 | 主题 | 窄在哪 |
|---|---|---|
| P-648 | ID 体系 | 会话 id 双向映射有据；消息 id 为 `host-message-N`、part id 为读取下标 |
| P-657 | 工具成功/失败 | 成功路径有真实回合证据；失败分支只有拉取路径单测 |
| P-644 | execution/idle | 每个宿主状态帧驱动会话行，界面运行指示未做端到端屏幕断言 |
| P-641 | 思考流 | 累计思考文本经实时覆盖行渲染；`start/delta/end` 未按事件区分 |
| P-656 | 工具进度 | running/completed 可见；中间进度不可见 |
| P-645 | 重试调度 | `auto_retry_start` 解码为提示行并在 `auto_retry_end` 清除；宿主的重试次数/延迟未展示 |
| P-658 | 无直接对等 | 未知事件记入 ignored、不污染已投影状态；不提供「等待中」提示行 |

另有 7 条原本已 `degraded` 的行（P-603、P-664、P-674、P-675、P-762、N-MINI、N-MCP）仍等待用户确认是否接受为降级交付。

## 7. 尚未关闭的偏离与遗留

1. **勾选顺序**：任务 32 在任务 31 关闭前被勾选，F1 审计如实报告 `32 before 31`；未回退，留待 31 关闭后自然成立。
2. **代码未提交**：工作树内产品代码全部为未跟踪文件，按计划 `Commit: N` 未做提交；交付前需要用户决定是否建立基线提交。
3. **F1–F4 未勾选**：F1 为 REJECT（缺 30/31）、F3 半绿半阻塞（Docker 段 PASS、macOS 段 BLOCKED）、F4 仅结构 PASS、F2 按字面不可满足（D6/D7）。
4. **15 行仍未验证**、**14 行降级**：均在 `capabilities.json` 中带证据与缺口说明，发布门 `matrix-release-check` 当前如实 FAIL（29 行阻塞）。
5. **任务 30 与 F3 的 macOS 半段**：卡在客体镜像，只有用户能解除。
6. **`packages/cli/test` 整套并非全绿**：2026-11-19 回归为 **341 pass / 23 fail**，2026-11-24 重建后同一个命令（产品根 `bun test --timeout 60000 ./packages/cli/test`）为 **347 pass / 9 skip / 23 fail / 4 errors，379 tests / 60 files，exit 1，303.85s**（不属于计划 F2 点名的四条命令；23 fail = 19 个具名用例 + 4 条 errors）。根因已定位，**不是端口竞争**：从产品根运行时被拉起的 CLI / service 子进程报 `Cannot find module 'react/jsx-dev-runtime' from packages/tui/src/config/v1/index.tsx`（与 D6 同一个 solid preload 限制，根 `bunfig.toml` 不加载 `@opentui/solid/preload`），服务注册等不到而 20–30 秒超时；`CLI frontend import boundaries` 与 `pair --remote` 收到的也是同一条模块错误。证据：`.omo/evidence/t32-rebuild-20261124T081338Z/07-cli-tests.log`；同目录 `11-attribution.log` 记录同一批用例从 `packages/cli` 目录重跑的结果（`service.test.ts` 1 pass、`pair-remote-consent.test.ts` 1 pass、`import-boundaries.test.ts` 5 pass，均 exit 0）。桥接相关用例即使从产品根运行也全绿（19 项 pass）。仍未在改动前的基线重跑确认，因此保持「未证实为既有问题」，但失败原因与本计划改动的代码路径无关。

## 8. 复核方式

```bash
# 计划与勾选
BRIDGE_PLAN_PATH="<主工作区>/.omo/plans/bridge-product-plan.md" \
  bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case final-plan-audit --out <新目录>

# 能力矩阵发布判定（当前应 FAIL，并列出阻塞行）
bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case matrix-release-check --out <新目录>

# 交付边界（范围外与降级清单）
product/opencode/BRIDGE-SCOPE.md
```
