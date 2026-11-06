# 测试体系建设意见报告

> 仓库：`/Users/zyno/Developer/github/omo-bridge`（自有） + `/Users/zyno/OmO Projects/my-tui/opencode`（只读参考）
> 取证：2026-11-06 12:00–13:10 +08，数字均为本机实测，复现命令见附录 A。
> 判定基线：2026-11-05 与你对齐的验收标准，以及 2026-11-06 的“斜杠命令/菜单必须走桥、未接线必须明确提示”约定。

## 1. 结论

这套测试体系能证明“桥回答得像 opencode”，不能证明“用户能用”。两者不是同一件事——过去 24 小时暴露的 9 个缺陷，全部落在后者。

三个数字并列看：879 条用例、91.77% 行覆盖、99 个端点全覆盖；同期你手工发现的 9 个问题里，这套用例能抓住 **0 个**。

根因不是写得少，是**四层里只建了两层**：端点契约（L0）与桥内集成（L1/L2b）建得相当扎实；单数据源一致性（L2c）与 UI 渲染（L4）基本空白。而决定“能不能用”的恰恰是后两层。

本报告保留现有资产，新增 L2c（一致性）与 L6（规则/能力）两层，把 L4 从 2 条场景扩成“首分钟清单”，并把 L2a（真客户端）从默认跳过改为默认执行。每层给出命令、通过条件与归属仓库。

## 2. 现状基线（实测）

| 维度 | 实测值 | 复现命令 |
|---|---|---|
| 用例总数 | 879（874 pass / 5 skip / 0 fail） | `bun test` |
| 文件数 / 耗时 | 41 文件 / 5.5–6.5s | 同上 |
| 行覆盖 / 函数覆盖 | 91.77% / 93.39% | `bun test --coverage` |
| HTTP 层 | 469 用例 / 21 文件 | `bun test ./test/http` |
| 契约层 | 294 用例 / 5 文件 | `bun test ./test/contract` |
| 降级用例 | 59，全绿 | `bun test ./test/http/degraded.test.ts` |
| 端点 sweep | 99 端点（状态 / 信封 / schema / 无 5xx） | `bun test ./test/http/surface.test.ts` |
| 真实客户端 e2e | 3 用例，**默认 skip** | `OMO_BRIDGE_E2E_TUI_DIR=<fork> bun test ./test/e2e` |
| 真宿主集成 | 1 用例，**默认 skip** | `OMO_BRIDGE_INTEGRATION=1 bun test ./test/senpi` |
| TUI 验收场景 | 2（send-message / models-dialog），**当前均红** | `bun run qa:tui -- --scenario <name>` |
| 静态门禁 | 4 条全绿，**均需手动跑**；`selfcheck` 只串 typecheck + contracts + test，**不含 surface:check 与 qa:tui** | `bun run selfcheck` |
| CI | 无（`.github/` 不存在） | `ls .github` |
| 覆盖率阈值 | 无 | `bunfig.toml` 仅 `timeout = 30000` |
| 运行时 | 证据跑在 bun 1.3.14；项目 pin 1.4.4 | `bun --version` / `package.json` |

参考仓库（只读）：`2178` 个 `*.test.ts(x)`（含 .tsx）；`packages/tui` 194 个、49,040 行，其中 `packages/tui/test` 100 个（用 `testRender`/`createTestRenderer` 渲染真实组件）；`packages/client` 25 个（含 `solid-data.test.ts`、`contract-identity.test.ts`）；`packages/app/e2e` 58 个 Playwright spec；CI 有 `check.yml`（typecheck）与 `check-test.yml`（`turbo test --affected` + Playwright 分片/重试/quarantine）。测试规范以 4 个 skill 固化：`unit-tests`、`tui-tests`、`app-e2e-tests`、`component-tests`。根目录 `bunfig.toml` 用 `root = "./do-not-run-tests-from-root"` 结构性禁止根目录跑测试。

## 3. 七个结构性缺陷

**D1 断言“存在”，不断言“关系”。**
`send-message` 只问“帧里有没有出现回复行”，不问“它在哪”。所以“回复显示在提示词上面”这个你第一个报的缺陷一路绿灯到今天。今天加的 `checks.order` 一测就红：`userIndex=12 > replyIndex=7`。

**D2 断言“桥的 JSON”，不断言“客户端渲染”。**
`catalogs.test.ts` 证明 `GET /api/integration` 返回 1 行连接，`real-client.test.ts` 证明客户端库能解码这行；但 `/models` 弹窗仍显示 “Free models / No items available”，因为弹窗分支读的是 `useConnected()`（默认 location 键），不是显式 ref 键。**解码成功 ≠ 界面渲染成功**。

**D3 把“静默空”钉成了契约。**
`catalogs.test.ts` 的 `describe("empty catalogs")` 对 9 条路径断言 `data === []`：`/api/skill`、`/api/reference`、`/api/mcp`、`/api/integration`、`/api/websearch/provider`、`/api/permission/saved`、`/api/plugin`、`/api/form`、`/api/command`。其中 `/api/command` 在真宿主下 32 行、`/api/integration` 1 行——这 9 条里至少 2 条测的是“没有 transport 时的兜底”，却被读成“这些家族本来就该空”。

**D4 能力声明只覆盖 1 个字段，且是常量断言。**
`server.test.ts:49` 断言 `capabilities` 恰好等于 `{ persistentPty: false }`。全仓库仅此一处能力门控；mcp/skill/plugin/usage/worktree 都没有能力标记，只能靠 `[]` 表达“不支持”，用户无法区分“你没配置”和“我没接”。

**D5 默认门禁排除了唯一的真实客户端层。**
`real-client.test.ts:17,70` 用 `describe.skipIf(!OMO_BRIDGE_E2E_TUI_DIR)`；默认 5 个 skip 里 4 个来自这里。实测设置一个环境变量后 3 条全绿（849ms）——成本极低，却不在默认门禁内。

**D6 没有 CI、没有阈值、没有红先流程。**
无 `.github/`、无 husky、无 git hook；覆盖率只打印不设限；7 个修复提交都“带测试”，但没有一条在提交前先红——它们是实现完成后补的、天然为绿的断言。缺的不是数量，是红→绿的证据链。

**D7 QA 链自身可被误导，且会残留。**
`send-message` 之前的通过条件只有 `outcome === "reply"`；`submitted` 与桥侧 `history.assistant` 只写报告不参与判定。harness 的 `stop()` 不删 state 目录，`--keep` 解析后从未被读取（README 却写“默认删除”），本机 `/var/folders/.../T/` 已累积 32 个 `qa-bridge-*` 目录。另外场景抛错时只打印 stack、不写 `report.json`，失败现场可能没有任何结构化证据。

**D8 假 host 把顺序与字段“断言成构造”。**
`test/senpi/fake-host.ts` 是唯一的 socket 级假宿主，但保真度不足：`finishTurn()` 硬编码 `agent_end` → `agent_idle`（顺序由构造保证、从未被观测）；握手数据是编的（`generation:0`、`engineVersion:"fake"`、3 个 capability），真机捕获有 51 个 capability 与 `serverVersion`/`runtimeBuildId` 等；它还宣告了真机并不存在的 `subscribe_sessions`；`get_state` 只回 `{sessionId, paused:false}`（真机约 40 个字段）；`open_session` 不回 `isStreaming`，而 transport 正是靠这个字段决定流式状态；`get_messages` 恒返回 `[]`、`get_entries` 忽略 `since`。这些盲区正是“桥内全绿、真机出错”的物理来源。

**D9 契约只锁形状，运行期几乎不校验。**
生成的 schema 里没有任何一个 `additionalProperties: false`（0 个文件），所以多字段、错字段名都能通过；运行期 `validateResponse` 只有 4 处调用，真正被门控的响应只有 `server.info` / `model.info` / `integration.list` 三个。错误可以被生产出来而无人拦截。

**D10 错误归因断链。**
“the provider returned an unexpected error” 由宿主包生成（`senpi/dist/core/provider-failure.js:50`），宿主随 `agent_end` 带上 `{category, provider, model, httpStatus, code, resetsAt, reason, action}`；桥只保留三个（`category→type`、`reason→message`、`httpStatus→status`，`src/translate/lifecycle.ts:165-174`），其余丢弃。运维侧无法从事件流区分“供应商失败”和“桥自身 bug”，只能看到同一句 toast。

## 3.1 确定性风险（实测计数）

| 项 | 数量 | 位置 |
|---|---|---|
| `Bun.sleep` / `setTimeout` | 13 | `test/**` |
| QA 链内的固定 sleep | 19 | `script/qa/**` |
| ≥15s 的宽超时 | 9 | `test/**` + `script/qa/**` |
| `skipIf` 门控 | 4 | `test/e2e`、`test/senpi` |

`bunfig.toml` 的 30s 是每测试预算，不是修复手段；fork 的 `unit-tests` skill 明确禁止“把 sleep 换成更大的超时/重试”。

## 4. 目标分层模型（L0–L6）

| 层 | 打谁 | 证明什么 | 命令 | 何时跑 | 归属 |
|---|---|---|---|---|---|
| L0 契约 | 官方 schema / 录制样本 | 字段与官方一致 | `bun run contracts:check` | 每次提交 | 桥 |
| L1 单元 | 桥内部函数 | 逻辑正确 | `bun test ./test/{translate,model,senpi,bridge}` | 每次提交 | 桥 |
| L2a 上游集成 | 真 TUI promise client → 桥 | 客户端能解析、状态码匹配、字段没丢 | `OMO_BRIDGE_E2E_TUI_DIR=$TUI bun test ./test/e2e` | **默认** | 桥 |
| L2b 下游集成 | 录制真帧 → 桥 | 真帧产出正确事件与顺序 | `bun test ./test/http` | 每次提交 | 桥 |
| **L2c 单数据源一致性** | 同一份数据的所有读法 | 命令面 vs 目录接口、显式 ref vs 默认 ref | `bun test ./test/rule` | 每次提交 | 桥 |
| L3 端到端 | 真主机 + 真客户端 | 两端真数据通 | `bun run qa:tui -- --scenario send-message` | 交付前 | 桥 |
| L4 UI/UX | 真 TUI（PTY→xterm） | 用户路径上看到的东西对 | `bun run qa:tui -- --scenario first-minute` | 交付前必跑 | 桥 |
| L5 验收 | 用户一句话标准 | 选模型 → 发「你好」→ 有回应 | L4 首条断言 | 每次交付 | 桥 |
| **L6 规则/能力** | 未接线家族 | `capabilities` 或明确 `_tag`，禁止静默空 | `bun test ./test/rule` | 每次提交 | 桥 |

新增两层的骨架（今天都应为红）：

```ts
// test/rule/capability.test.ts
// 遍历 DEGRADATIONS.md 家族：未接线 ⇒ capabilities[family] === false；已接线 ⇒ 非空数据

// test/rule/single-source.test.ts
// 1) /api/command 里 skill:* 的条数 == /api/skill 的行数
// 2) integration.list(显式 location) == integration.list(默认 location)
// 3) 实时事件 id == 历史消息 id（把 mount.test.ts 的个案提升为全局不变量）
```

## 5. 六维断言矩阵

| 维度 | 断言 | 现有覆盖 | 目标 |
|---|---|---|---|
| 功能 | 发「你好」→ 出现助手回复 | QA `send-message` | 保留 |
| 顺序 | 回复在用户消息**之后** | 今天新增 `checks.order`（红） | 修到绿 |
| 身份 | 实时 id == 历史 id | `mount.test.ts`（集成层） | L4 再断言一次 |
| 状态 | 切模型后用新模型；运行中/空闲可辨 | `session-read` 部分 | 补 UI 层 |
| 隔离 | 两会话并行不串 | 无 | 新增场景 |
| 错误面 | 失败必须明确报错，不允许空转 | `degraded` 59 条 | 补 provider 错误场景 |

“首分钟清单”（L4 场景 `first-minute`）：首页 → `/models` → `/connect` → 发消息 → `/mcp` → `/plugins` → `/usage`。每个弹窗只允许两种结果：**有内容**，或**明确的“未接入”提示**；“已连接 provider 却提示去连接”直接判失败。

## 6. 门禁与度量

**一条命令跑全部：**

```json
"check:all": "bun run typecheck && bun run contracts:check && bun run surface:check && bun run selfcheck && bun test && bun test ./test/rule"
```

（`selfcheck` 已含 typecheck/contracts/test，实际可裁，但必须包含 `surface:check`——它现在不在 selfcheck 里。）

**CI（新增 `.github/workflows/check.yml`）**：push/PR 跑 `check:all` + L2a（带 fork 路径）+ 覆盖率阈值。没有 CI，一切“全绿”只在你手动跑的那一刻成立。

**覆盖率阈值**：行 ≥ 90%、函数 ≥ 92%（当前 91.77 / 93.39，留 2 个点余量）。覆盖率不是目标，是防回退的堤坝。

**运行时对齐**：证据必须跑在 pin 的 bun 上。二选一：把 1.4.4 装到固定路径并在脚本里引用，或把 `packageManager` 改为实际使用的版本并注明原因。两者都不做，“通过”只对某个未记录的运行时成立。

**红先流程（可校验）**：先在用户路径写一条会失败的用例 → 记录红 run 与 commit → 修到绿 → 记录绿 run → 提交信息带 `red: <sha>` / `green: <sha>`。

**测试编写规则（从 fork 的 4 个 skill 移植，已被验证）：**
- 控制时间不用 `sleep`：注入时钟 / 事件订阅 + 有界超时（`unit-tests`、`tui-tests`）。
- TUI 渲染用 `testRender` / `createTestRenderer` / `waitForFrame` / `waitForVisualIdle`，30s 预算，显式 cleanup。
- 浏览器 e2e 用 Playwright：per-test 隔离、CI `retries=2`、`workers=5`、quarantine 名单。
- 组件测试挂真实 story，不复制视觉。

## 7. 落地路线

**P0（本周，先让体系能红）**
1. `test/rule/capability.test.ts` —— 未接线家族必须在 `capabilities` 里为 false；今天红。
2. `test/rule/single-source.test.ts` —— skill 命令面 vs `/api/skill`、integration 两种 ref；今天红。
3. `check:all` 脚本 + `.github/workflows/check.yml`；L2a 默认执行。
4. `qa:tui` 修残留：`stop()` 删 `stateDir`，`--keep` 真正生效。

验收：`bun run check:all` 一条命令全跑；两组新用例初跑为红、修复后转绿，附两次输出。

**P1（下一迭代，让用户路径有断言）**
5. `first-minute` 场景（L4）：/models 与 /connect 起手，每个弹窗“有内容或明确未接入”。
6. `order` / `identity` / `isolation` 三维从 L2b 提升到 L4 各一条。
7. provider 错误面场景（`--fault provider-error`）：断言界面出现明确错误而非空转。
8. 覆盖率阈值进 CI。

**P2（体检与长期）**
9. 把 `test/http` 的假 transport 用例逐条标注“它不能证明什么”，各补一个 L2a/L3 对照。
10. 移植 fork 的 `unit-tests` 规则（时间控制、跨文件泄漏、temp dir 清理）。
11. 把 fork 的 `packages/client/test`（25 个，含 `solid-data.test.ts` / `contract-identity.test.ts`）挂到桥，作为 L2a 扩容——这是唯一能抓住 store 键不一致的一层。
12. `skill:*` 命令与 `/api/skill` 合并：以命令面为唯一数据源，弹窗读同一数据。

## 8. 风险与反模式

| 反模式 | 后果 | 对策 |
|---|---|---|
| 自证式 fixture（从桥自己的响应生成样本） | 错误信封也能通过契约检查 | 样本必须来自声明 schema / 官方样本 + 负样本 |
| 变异方向错误（删字段让断言变弱） | 误判“测试无法变红” | 变异要给 `required` 加一个不存在的字段 |
| 假 host 全绿当交付 | 三次交付全坏的历史 | 每次交付必须有 L3/L4 证据 |
| 以“空数组符合契约”结案 | 静默降级变成用户困惑 | L6 规则用例 |
| 用总数掩盖分层缺口 | 879 条盖住 0 条渲染断言 | 报告逐层列证据 |
| 注入故障证明“会红” | 只证明能红，不证明红在正确断言上 | 红必须来自用户路径 |
| 覆盖率当目标 | 补无意义断言凑数 | 覆盖率只做阈值，不设目标 |

## 9. 附录 A：证据索引

- 观测台账：`docs/test-review-evidence/observation-manifest.md`（O1–O21）
- claim 图：`docs/test-review-evidence/claim-graph.md`（C1–C13）
- intent 差异：`docs/test-review-evidence/intent-diff.md`（I1–I8）
- 审计 lane handoff：`docs/test-review-evidence/waves/`（a-bridge 6 份 + b-fork 2 份 + coverage 原始表）
- 关键代码锚点：`test/http/catalogs.test.ts:349`、`test/http/server.test.ts:49`、`test/e2e/real-client.test.ts:17`、`script/qa/scenarios/send-message.mjs:187`、`script/qa/lib/bridge.mjs`（stop 无删目录）
