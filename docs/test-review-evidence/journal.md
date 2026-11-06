# Ultrawork Notepad — 测试体系建设完善意见报告
Started: 2026-11-06T12:52+08:00
RUN_TMP: /tmp/ulw-20261106-125201.5veHxl
NOTE: this file

## Plan (exhaustively detailed)
1. Bootstrap: goal 已注册；RUN_TMP/NOTE 已建；tier=HEAVY。
2. Phase 1（并行三簇 DAG，mass-ulw cluster runs）：
   - A 桥审计（8 节点）：资产清单 / 确定性 / 保真度（假 vs 真）/ 契约抽取 / 覆盖率真相 / 门禁与 CI / QA 链质量 / 错误归因。
   - B fork 审计（5 节点）：packages/tui 资产 / .opencode 测试 skill / Playwright e2e / storybook / CI。
   - C 复用审计（3 节点）：可适配用例 / protocol 测试 / 客户端契约测试。
   每节点写 /tmp/ulw-.../waves/<run-key>/<id>.md，带 CLAIMS 行（claim | evidence path:line | confidence）。
3. 本地并行：自己复核 879 用例 / 91.77% 覆盖 / 5 门禁 / 2 场景 / 0 CI；读 ulw-research delivery 参考。
4. Phase 2（独立 run）：3 个设计节点（分层模型/规则层/度量与门禁）+ 1 个 architect 归约 → 设计稿。
5. 汇总 claim 图 + 观察台账（写进本 notepad 的 Findings）。
6. 落盘 docs/test-system-review.md（omo-bridge）。
7. HTML 报告：desktop_html_preview 双宽度（728/390）自检 → desktop_html_render 内联。
8. 提交（git-master 前缀 + trailer）；清理 RUN_TMP/进程/端口/tmux 并回读回执。

## Success criteria + QA scenarios
S1 每条结论带 file:line 或命令输出；交付前重跑关键数字。
S2 六轴线全覆盖，每轴至少一条 lane 产出被吸收。
S3 分层模型每层有可执行命令，映射到已有/待建用例。
S4 双形态交付（repo md + 内联 HTML），HTML 桌面与 390px 自检。
S5 清理回执齐全。
STOP: 报告内联 + 落盘提交 + 数字复核 + 回执齐全。

## Now
Phase 1 DAG 定义与启动。

## Todo
- [ ] Phase1 DAG 启动并 settle
- [ ] 本地证据复核
- [ ] Phase2 设计 DAG
- [ ] claim 图与台账
- [ ] 报告落盘
- [ ] HTML 自检与内联
- [ ] 提交与清理回执

## Findings
（工作中追加，append-only）

## Learnings
- 该仓库测试体系已确认的三处结构性缺陷：断言存在而非关系；断言桥 JSON 而非客户端渲染；UI 层仅 1 条场景。


## Session journal (append)
- 12:52 bootstrap：goal 注册、RUN_TMP/NOTE 建立、tier=HEAVY。
- 12:53 三簇 DAG 启动（a-bridge 8 / b-fork 5 / c-reuse 3）。
- 13:0x a-determinism 因上游 429 失败；其余 lane 正常产出。
- 13:1x 本地自查：fork 2178 个测试文件、packages/tui 194、client 25、e2e 58。
- 13:2x 取消 c-reuse 与 a-coverage/b-e2e/b-storybook/b-ci（证据已由 lead 自查覆盖），避免继续占用并发槽与供应商配额。
- 13:3x 报告落盘 docs/test-system-review.md + 证据目录；HTML 页 draft-guard 通过，dark/light × 728/390 四视图自检并修正两处溢出。
- 13:4x 交付前复核：879/874/5/0、91.77%/93.39%、4 门禁全绿、无 .github。
- 13:4x 提交 8366abc、7a2f6bd；清理 RUN_TMP 与 32 个 qa-bridge-* 残留目录。
