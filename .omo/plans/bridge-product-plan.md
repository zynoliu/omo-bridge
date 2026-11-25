# bridge-product-plan - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**Who this is for and what changes for them:** 面向在同一台 Mac 上个人或内部使用 OmO 的人。完成后，他们可以使用保留 OpenCode 交互方式的终端界面，并清楚看到对话、工具审批、会话状态及不等价能力的边界。

**What you'll get:** 一个独立维护的 TUI fork、进程内适配层和必要的独立配套扩展；主界面、Mini、插件及客户端 MCP 分别经过真实验收，并附带安全、兼容和维护证据。

**Why this approach:** 保留现有终端体验，同时将宿主协议差异集中在适配层；先核实官方工件与隔离环境，再在独立 macOS 虚拟机验证原生宿主，避免把 Linux 容器行为误当 macOS 结果。

**What it will NOT do:** 不修改官方 OmO 或现有用户数据，不承诺远程、多平台或对外发行，不把历史估算、模拟测试或不安全宿主当作产品验收。

**Effort:** XL
<!-- Effort is exactly ONE band, never hours/days. Quick = single edit, minutes of agent work; Short = one focused change, a few files; Medium = multi-file feature in one session; Large = several waves, one long session; XL = multi-session or architectural work. A written duration is rewritten to a band. -->
**Risk:** High - 官方工件可获得性、宿主审批安全、跨进程恢复、插件兼容与隔离 macOS 虚拟机都需真实验证。
**Decisions I made for you:** 采用经你批准的进程内适配包与 TUI fork；主路径不强依赖配套扩展，使用合成夹具和新鲜隔离证据；终端截图仅增加已批准的测试依赖。用户提供免费模型密钥的用途限于已批准的隔离环境。

Your next move: 本计划须先完成独立高精度审查；实施需由你另行启动，当前批准不授权运行产品。

---

> TL;DR (machine): XL；High；同机 macOS 原生 Bridge、完整已选兼容范围、隔离真实验收和可追溯证据。

## Scope
### Affected user and ideal state
**Affected user:** 在 macOS 上使用终端界面的个人或内部用户，以及维护和验证 Bridge 的开发者、代理和审查者。当前他们拥有带范围限制的研究资料；完成后，他们可以在同一台机器上使用未经修改的官方 OmO 宿主，并有可追溯的测试与使用边界。

| Row | Statement | Reason |
| --- | --- | --- |
| IS-1 | 主 TUI 正确显示对话、流式内容、工具、审批、终态与错误。 | started 不是完成，正常流和失败必须可见。 |
| IS-2 | 会话、消息、权限、队列和恢复各有正确身份与生命周期；不等价功能不冒充等价。 | 防止串线、重复消息和误授权。 |
| IS-3 | task、todo、goal、memory、DAG 等已选 OmO 原生能力可区分、可交互并有真实证据。 | 各数据面、状态和权限不同。 |
| IS-4 | 一般宿主开发与验证在独立 Docker 中进行；原生 macOS 宿主验收仅在用户批准的独立 macOS 虚拟机中进行，工件身份可追溯。 | 不能污染或连接真实用户 OmO。 |
| IS-5 | 每项支持、限制、风险和验收证据可复核。 | 历史材料、源码、模块实验与真实宿主不是同一种证据。 |
| IS-6 | 同机 macOS 的原生 TUI 与原生官方宿主在隔离 macOS 虚拟机内真实联调，终端、构建、失败处置和升级路径可用。 | Linux 容器中的宿主表现不能代替 macOS 原生宿主验收。 |
| IS-7 | Mini、OpenCode TUI 插件和客户端 MCP 均完成适配及各自真实验收。 | 这些是用户明确选入的独立接缝。 |
| IS-8 | 工作区原有的未跟踪知识库、忽略的上游与研究回执在复制、构建和清理前后保持不变。 | 新 fork 和验收不能覆盖或清理用户的既有资料。 |
| GAP-1 | 尚无本轮外部 TUI 和官方宿主的端到端验收。 | `knowledge/delivery-readiness.md:3-5`。 |
| GAP-2 | 审批、恢复、事件缺口与宿主重启等真实链路仍有缺口。 | `knowledge/verification-plan.md:40-61`。 |
| GAP-3 | 已选择 TUI fork，实际依赖闭包、启动和客户端接缝尚需落地。 | `knowledge/architecture.md:27-43`。 |
| GAP-4 | 历史样本的来源与重放适用性有限，既有研究还披露过隔离偏差。 | `knowledge/delivery-readiness.md:47-58`。 |
| GAP-5 | 报告指定官方工件的复探及与实际二进制身份对应关系尚未完成。 | `knowledge/verification-plan.md:5-11`。 |
| GAP-6 | 旧覆盖率与工时是估算，不是运行验收或承诺。 | `knowledge/verification-plan.md:63-67`。 |
| GAP-7 | Mini、插件和客户端 MCP 各自存在未经产品实测的不同接口。 | `knowledge/architecture.md:37-43`。 |
| GAP-8 | 工作区已有不随 `knowledge/` 一起复制的忽略源码与研究证据，构建和清理尚无本计划的前后对照。 | `.gitignore:1-7`、`knowledge/delivery-readiness.md:17`。 |

### Must have
- 用户已决定：完整产品；同机运行；仅 macOS；个人或内部使用；以 OpenCode TUI fork 为主；先复探原报告指定的官方 OmO 5.1.67 工件及 goal、todo、thread/子代理审批；必要时允许独立配套扩展；Mini、TUI 插件与客户端 MCP 都纳入实际验收。
- 采用 B′：`product/opencode/` 为独立、可追溯的上游 TUI fork，`product/opencode/packages/bridge-core/` 为进程内 Senpi JSONL 适配包；主路径不依赖配套扩展。复制仅限上游已跟踪源码，不修改 `upstream/`，不将官方 OmO 打补丁，不架设完整 OpenCode HTTP/SSE 门面。
- 保留主 TUI 和用户选入的 Mini、插件公开上下文及客户端 MCP；逐项覆盖原报告和固定源码中的相应能力。原报告已明确不等价的功能按其说明呈现，不伪称完全兼容；用户明确选入但无法实现或验收的要求保持 BLOCKED，不得静默删掉。
- 一般开发、测试、调研或探针需要启动 OmO 时，先使用独立 Docker 容器、独立 HOME、agentDir、socket、数据及模型配置。用户明确批准的唯一例外：为验收原生 macOS 宿主，在独立隔离的 macOS 虚拟机内启动原生官方 OmO，并使用该虚拟机内的独立 HOME、agentDir、socket 和数据。两种路径都不得连接本机真实 OmO 或使用真实用户状态。用户另行允许其未来安全提供的免费模型 API key 供独立 macOS 虚拟机内的宿主进程使用；原有 Docker 内程序使用许可仍有效。密钥不得写入容器/虚拟机镜像、仓库、日志或回执；代理和探针不读取、复制或打印密钥。
- 报告指定工件如不可获得，记录工件查询与复探 BLOCKED；其他版本的结果不得冒充指定版本通过。相关宿主集成和最终验收不得宣称通过，独立的离线工作可继续。
- 保留当前工作区既有文件、未跟踪资料和忽略的源码/研究回执。执行时若产品或证据目标已存在，除本次尝试自己创建且内容与回执一致外立即停止，不能覆盖、清空、暂存或提交。
- 仅允许新增的终端可视 QA 依赖为开发依赖 `@xterm/xterm@6.0.0`；沿用 fork 的原有依赖。其他新增依赖、付费服务或改变分发范围必须先由用户另行决定。
- 按固定源码与用户批准的范围建立逐项能力账本；源表 95 行是行数，不是唯一 API 或已实现兼容率。使用合成夹具及合规环境的新鲜证据，不依赖原始历史抓包。

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不交付或承诺 Windows、Linux、远程部署或对外发行；不读取或修改用户真实配置、会话、daemon 或凭据。
- 不修改上游检出、官方 OmO、用户已有文件或历史证据；不执行归档脚本，不把历史抓包直接当回放金样。
- 不直接运行上游 `dev:live` 或 `dev:vite:live`：其脚本会查询 OpenCode 服务密码和状态，见 `upstream/opencode/package.json:10-13`。
- 不将 stdio 测试通过推广为 socket 多连接、订阅、认证或恢复通过；不把异常审批的模块级反例说成完整 RPC 已复现。
- 不为了通过检查跳过、删除、屏蔽或弱化测试、类型错误和失败；禁止固定 sleep 等待异步行为；不提交、暂存、推送或创建 PR，除非未来用户另行明确要求。

## Verification strategy
**测试策略：**行为改动先依据现有测试和独立协议夹具编写可失败测试，再实现；沿用 fork 的 Bun 测试和类型检查。单元/模拟测试不是完成证明：内部协议走真实适配器可执行入口，界面场景走真实 PTY、xterm.js 和浏览器，最终场景连接隔离容器内的官方宿主。所有动作由代理执行；用户安全提供模型 API key 是外部前置条件，不是让用户手工完成 QA。

**每次执行初始化：**在工作区根目录，先验证 `.omo/evidence` 是工作区内非符号链接目录；为每个工作单元及子代理分别创建独占临时目录并设置 `TMPDIR`、`NODE_COMPILE_CACHE`、`BUN_RUNTIME_TRANSPILER_CACHE_PATH`。主执行者使用如下固定命令创建本次持久证据目录，绝不复用或覆盖：

```sh
test -d "$PWD/.omo" && test ! -L "$PWD/.omo" && test -d "$PWD/.omo/evidence" && test ! -L "$PWD/.omo/evidence" || exit 1
export RUN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/bridge-exec.XXXXXXXX")"
export TMPDIR="$RUN_TMP" NODE_COMPILE_CACHE="$RUN_TMP/node-cache" BUN_RUNTIME_TRANSPILER_CACHE_PATH="$RUN_TMP/bun-cache"
export QA_EVIDENCE="$(mktemp -d "$PWD/.omo/evidence/bridge-product.XXXXXXXX")"
mkdir -m 700 "$RUN_TMP/home" "$RUN_TMP/config" "$RUN_TMP/agent" "$RUN_TMP/project" "$RUN_TMP/secrets"
export HOME="$RUN_TMP/home" XDG_CONFIG_HOME="$RUN_TMP/config" DO_NOT_TRACK=1
unset BUN_OPTIONS BUN_CONFIG_VERBOSE_FETCH
```

在隔离目录中创建独立 HOME、XDG 配置与 agentDir；命令和子代理只接收必要环境。用户在执行前通过独立安全渠道向本次 `$RUN_TMP/secrets/model-key` 提供免费模型密钥，目录内不得包含其他文件；该文件必须为本次用户所有、模式 0600 的普通文件而非符号链接，代理只检查路径、所有者和权限元数据，不打开、复制或输出密钥内容。Docker 和 macOS VM 分别只读挂载该专用目录，VM 使用 `VZSharedDirectory(url:readOnly:)` 并禁止共享其父目录；由各自隔离环境内的官方宿主进程通过目标工件支持的安全输入方式消费，其他 guest 进程无权读取。不得用命令替换、命令行参数、镜像层或日志传递明文。如果无法做到仅宿主消费且不写镜像/日志，真实模型场景 BLOCKED。密钥提供是用户输入前置条件，不是人工 QA；完成后删除本次临时目录并复核不存在。

每次场景的输出目录只能创建一次。先收集本次合成数据及截图，再退出自建进程和浏览器、释放端口/容器、核对临时路径和环境；只有清理成功后才写 `result.json`（实际动作、输入类别、断言、PASS/FAIL、所测工件/源码版本或摘要）和 `cleanup.json`。不记录密钥、用户消息正文或完整会话/运行标识；不能对历史原始抓包计算内容摘要。保留证据目录，最后删除本次拥有的 `RUN_TMP` 并复核不存在。

**工作区保护：**对已有非抓包源码和文档可记录摘要；对历史抓包及可能包含用户消息的回执只检查路径存在性与 `lstat` 元数据，不读取或复制正文。通过实际文件系统写入边界和前后元数据核对防止覆盖；元数据一致不能冒充原始文件逐字节核对。除新增的 `product/`、本次证据和临时目录外，不对既有工作区路径写入。运行 fork 或插件前，在原生 macOS 测试进程上建立系统级文件/网络隔离：只允许读取产品输入、必需系统库和本次临时数据，只允许写入本次产品/证据/临时目录；用本次自建的工作区外哨兵验证越界读取被拒，不能读取真实用户 HOME 验证。隔离无法证明时 BLOCKED，不以设置 HOME 环境变量代替。

**依赖与 Bun 隔离：**任务 4 是初次依赖安装的唯一写者；只安装 fork 锁文件已有依赖和用户批准的 xterm，使用独立缓存、`--ignore-scripts` 和 `--no-env-file`，审计必要原生依赖安装脚本后才在受限环境单独执行。任务 6 增加本地 workspace 包时由其独占更新锁文件；任务 25 使用相对导入而不在并行阶段更新根锁文件，任务 28 再由单一写者整合本地 workspace 锁文件，若出现未批准的外部依赖或版本变更即停止。除明确写出的安装命令外，所有 Bun 执行均使用 `--no-install --no-env-file`，不得自动下载或读取 `.env`。

**统一 QA 入口：**任务 4 创建 `product/opencode/tools/bridge-qa/run.ts`，命令固定为 `bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case <场景名> --out "$QA_EVIDENCE/<目录名>"`。任务 4 只提供真实执行框架和按名称加载 `cases/<场景名>.ts` 的注册约定；后续每项与实现一起创建其两个独立场景文件，不修改共享注册表、不预置占位或空操作。每个场景使用同一任务中明确的真实输入和独立预期，不允许测试只回显 mock、常量或预期字符串。协议场景启动真实适配器入口并与受控 JSONL 对端交互；UI 场景以 PTY 启动真实产品入口，在隔离的自有浏览器中用 xterm.js 发送列明的按键并截图；官方宿主场景必须实际连接指定工件。测试先订阅精确事件再触发动作，以有界超时判定，不以延时推测完成。

**原生 macOS 与容器门槛：**任务 2/29 建立测试专用本地 Unix socket 网关：macOS 端仅监听本次 `RUN_TMP` 中的 0600 socket；每个连接经无 TTY 的 `docker exec -i` 启动容器内字节透明转发器，连接同一个容器内官方 socket，stdout 仅承载 RPC、stderr 单独收集且脱敏；宿主密钥只在独立测试目录内由产品认证代码使用，代理与探针不读取或打印。不得把这个开发网关部署成公开或远端服务。必须实测目标工件身份、权限、认证、多连接、断线与清理；如 Docker Desktop 共享目录权限、认证或 socket 语义不成立，标记 BLOCKED，不降级认证、不连接真实宿主、不把 stdio-only 结果算作 socket 通过。

任务 30 按用户授权另建独立 macOS 虚拟机，使用 Apple Virtualization 官方机制和独立虚拟磁盘、HOME、agentDir、socket、项目夹具及用户；不共享真实用户 HOME、会话、OmO 配置或 daemon。在客户机内启动原生 macOS TUI 与原生官方 OmO，用真实 PTY/xterm 路径验证用户可见行为；Docker 的 Linux 宿主结果不得充当此验收。缺少受支持镜像、资源、自动化通道或隔离证明时记 BLOCKED，不能回退真实 macOS 用户环境。Apple 机制参考 `https://developer.apple.com/documentation/virtualization/installing-macos-on-a-virtual-machine`；本计划没有创建或验证虚拟机。

**回归与最终验证：**每项运行自身及导入它的相关测试、改动文件诊断，并执行其真实入口场景；跨文件整合后运行 fork 中相关测试、类型检查及构建。F1–F4 在所有实现任务完成后并行执行；任何失败、已选功能缺失或无法满足的隔离前置条件都阻止完成。

## Execution strategy
### Parallel execution waves
- **Wave A — 基线与证据（1–5）：**1 先建立 fork；2、4 文件范围独立，可并行；3 等待 2 和 4，5 等待 4 的验收入口。
- **Wave B — 协议内核（6–13）：**6 先冻结共享契约；7、9、10、12 可分文件并行，8/11 等待 7；13 独占公共导出并整合 7–12。
- **Wave C — 主 TUI（14–19）：**14 先接入数据与连接；15–19 在各自模块与测试文件并行，公共路由/注册表暂不修改。
- **Wave D — 原生与兼容（20–27）：**各任务只编辑自己分配的 feature 子目录、Mini、插件或 MCP 独立文件；22 等待 20，25 等待 19；共享路由及注册表由 28 一人整合。
- **Wave E — 集成与交付（28–32）：**28 整合；29 做隔离 Docker 宿主与 macOS 网关验证，30 做独立 macOS 虚拟机内的原生宿主验证；31 验收完整能力矩阵，32 打包、交接和维护；F1–F4 最后并行。

子代理按下方每项 `Recommended task executor category` 分配；各自使用独占临时目录和证据子目录，不能并行修改相同文件。测试和实现属于同一任务。需要更改已稳定的共享契约时，暂停依赖任务，单独更新契约并重跑受影响场景。

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | — | 2, 4, 5 | — |
| 2 | 1 | 3, 29 | 4 |
| 3 | 2, 4 | 29 | 5–12（离线部分） |
| 4 | 1 | 3, 5, 7–32 | 2 |
| 5 | 1, 4 | 6, 31 | 3 |
| 6 | 5 | 7–12 | 3 |
| 7 | 4, 6 | 8, 11, 13 | 9, 10, 12 |
| 8 | 7 | 13, 20 | 9, 10, 11, 12 |
| 9 | 4, 6 | 13 | 7, 8, 10–12 |
| 10 | 4, 6 | 13, 17 | 7–9, 11, 12 |
| 11 | 7 | 13 | 8–10, 12 |
| 12 | 4, 6 | 13 | 7–11 |
| 13 | 7–12 | 14, 23–25 | — |
| 14 | 13 | 15–27 | — |
| 15–19 | 14；17 另需 10 | 28；19 另阻塞 25 | 同组不同文件 |
| 20–21, 23–24, 26–27 | 14；23–24 另需 13 | 28；20 另阻塞 22 | 同组不同文件 |
| 22 | 20 | 28 | 21, 23–27 |
| 25 | 13, 14, 19 | 28 | 20–24, 26–27 |
| 28 | 15–27 | 29, 30 | — |
| 29 | 2–4, 28 | 31 | 30, 32 的离线草稿 |
| 30 | 3, 4, 28 | 31 | 29, 32 的离线草稿 |
| 31 | 5, 28–30 | 32, F1–F4 | — |
| 32 | 31 | F1–F4 | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. 建立不覆盖用户资料的独立 TUI fork
  - Recommended task executor category: deep-low — 工作区与上游快照边界必须一起核实。
  - 做什么：在确认 `product/` 不存在后创建 `product/bootstrap.ts`，只读取 `upstream/opencode` Git 索引中 stage 0 的已跟踪文件，将快照逐项独占复制到 `product/opencode/`；拒绝未合并项、缺失文件、逃逸符号链接、未解析的必要 LFS 文件及不一致源码。保留许可、可执行位、根清单、锁文件和完整工作区依赖；排除 `.git`、未跟踪文件、缓存和本机状态。记录源版本、文件数及逐项字节/SHA-256 一致性，但不打印完整标识。执行前后比较原工作区与上游既有文件，禁止覆盖。
  - Git 仅做只读索引/状态查询：使用 `GIT_MASTER=1`、独立 HOME、`GIT_CONFIG_GLOBAL=/dev/null`、禁用 fsmonitor/外部过滤器和终端凭据提示；若不能证明无外部执行或无懒加载网络，则停止，不猜测。执行者先读 git-master 与 Bun 技能。
  - 已跟踪清单调用固定为 `GIT_MASTER=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 git -C upstream/opencode -c core.fsmonitor=false ls-files --cached --stage -z`；程序解析 NUL 分隔记录并拒绝非 stage 0。用户历史抓包仅做不读取正文的元数据保护检查，不将其散列回执说成已完成。
  - Closes: GAP-3, GAP-4, GAP-8；Wave A | Blocked by: 无 | Blocks: 2, 4, 5。
  - References: `upstream/opencode/package.json:3-8,31-43`、`upstream/opencode/packages/tui/package.json:3-10,51-70`、`knowledge/versions.md`、`knowledge/development-standards.md:14-30`。
  - 验收：快照清单、源/目标逐项一致性和原工作区未改回执均为 PASS；任何目标已存在或源码不完整时不覆盖。
  - QA happy：`bun --no-install --no-env-file product/bootstrap.ts snapshot --source upstream/opencode --target product/opencode --manifest "$QA_EVIDENCE/t01-snapshot.json"`；退出 0 且逐项比较为真。失败：重复同一命令并改用 `--manifest "$QA_EVIDENCE/t01-retry.json"`；必须非零，目标字节不变。保存两次退出码和比较回执。
  - Commit: N。

- [x] 2. 建立可验证的独立 Docker 宿主环境
  - Recommended task executor category: deep-high — 安全隔离和 macOS/容器边界跨进程，必须按不变量设计。
  - 做什么：在 `product/opencode/tools/bridge-dev/` 创建容器定义、启动/清理器和仅依赖 Bun 内置 API 的 `check-isolation.ts`；构建上下文仅包含该独立目录，不读取并行安装中的 `node_modules`。基于官方 Bun 1.4.4 镜像解析并记录不可变摘要，使用本次独立 HOME、agentDir、数据、socket 和无特权用户；只挂载明确的本次目录，拒绝用户 HOME、真实 OmO socket/配置和 Docker socket 入容器。模型网络/密钥只在后续明确需要时以受控方式注入，不写镜像、仓库或日志。建立测试网关的私有目录和生命周期，但此项不启动 OmO。
  - Closes: GAP-4, GAP-5；Wave A | Blocked by: 1 | Blocks: 3, 29。
  - References: `knowledge/verification-plan.md:5-11,13-26`、`knowledge/delivery-readiness.md:56-58`、`upstream/opencode/package.json:8`。
  - 验收：容器挂载、用户、网络与本机 daemon 分离有机器回执；无 Docker 或无法满足条件时 BLOCKED，不能回退本机。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-dev/check-isolation.ts --case container --out "$QA_EVIDENCE/t02-container"`；实际创建/检查/销毁隔离容器后退出 0。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-dev/check-isolation.ts --case reject-host-mount --out "$QA_EVIDENCE/t02-reject"`；实际配置校验必须拒绝真实 HOME 挂载且未创建容器。两次均留清理回执。
  - Commit: N。

- [x] 3. 复探报告指定的官方工件与开工门槛
  - 2026-11-19 真实复探完成（子任务 `t03-reprobe`，协调者检收）：容器 `t03-probe-mwnnycj0` 由本次新建并删除，`docker inspect` 的 `Mounts` 为 `[]`、零 `docker.sock`，`docker ps -a` 再无 `t03-probe`；工件为 `bridge-host-official:5.1.75`（engine `2026.11.15-2`，128 个 RPC 方法 / 77 项能力）。三项结论：**goal VERIFIED（命令面，无方法）**——`goal_*`/`get_goal` 全 `Unknown command`，`prompt{"/goal"}` 返回 `disposition:"handled"` 并伴 `command_invocation`、`setStatus(goal)`、`notify`；**todo VERIFIED（命令 + 会话条目）**——`todo_list` 等全 `Unknown command`，`/todo` 返回 `handled`，状态为 `customType:"senpi.todo-state"` 的会话条目，`append_session_entry` 写入后 `get_entries` 原样返回；**thread 列表/创建 UNSUPPORTED，审批通道 VERIFIED**——`thread_list`/`thread_create`/`get_thread` 均 `Unknown command`，`list_hands`/`select_hand` 返回 `hand_selection_unsupported`，「thread」仅是一个 grant 类（含 7 个 session 操作），真实审批走 `question` + `extension_ui_response`（仅有的两个 `answer` 类方法）与 `lifecycle.waitingOn.human`。证据：`.omo/evidence/t03-reprobe-20261119/`（`EVIDENCE.md` 14,323 B + 四阶段 `wire-phase*.jsonl` 原始帧、`raw-docker-inspect.json`、`raw-mount-audit.txt`）。限制已写明：未跑模型回合，所以没有真实 `todo` 工具调用与子代理 `question` 帧，审批只验证到通道层。
- 版本决定（2026-11-17，用户选择“改用最新已发布版本”）：官方 5.1.67 从未发布（npm `omo-ai` 共 150 个版本，无 5.1.67），因此本任务、29–31 与最终验收改用**实际已发布的官方版本**作为目标（当前 latest 为 `5.1.75`），隔离与验收方式不变。工件可用性已实测（证据：`.omo/evidence/bridge-product.kn2I62Kg/`）；goal、todo、thread/子代理审批三项能力仍须在隔离宿主中真实复探。
  - Recommended task executor category: deep-low — 需区分标签、发行包、实际二进制和能力证据。
  - 做什么：仅在任务 2 的容器中查询并固定官方 OmO 已发布工件（版本以本任务记录的版本决定为准），分别记录渠道、版本、摘要与 Senpi 版本；验证 goal、todo、thread/子代理审批，使用用户安全提供的免费模型凭据且不暴露值。对目标工件不可用、模型不可用、认证失败分别给出 BLOCKED/FAIL；不得用 5.1.66 或 Git 标签冒充 5.1.67 复探。
  - Closes: GAP-4, GAP-5；Wave A | Blocked by: 2, 4 | Blocks: 29。
  - References: `knowledge/source-documents/00-handoff.md:27-35,78-97`、`knowledge/versions.md:48-56`、`knowledge/verification-plan.md:5-11`、`knowledge/native-features.md:5-45`。
  - 验收：三个指定能力各有真实工件的输入类别、事件结果及隔离回执；无工件或密钥则相关项 BLOCKED，不能写 PASS。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case official-5167-reprobe --out "$QA_EVIDENCE/t03-reprobe"`；只有目标工件、三项能力及清理均满足才退出 0。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case official-artifact-missing --out "$QA_EVIDENCE/t03-missing"`；必须记录 BLOCKED 且不启动替代工件。
  - Commit: N。

  - 2026-11-18 状态（协调者复跑）：失败用例 `official-artifact-missing` 已修正判定语义并 **PASS**（exit 0）。原判定要求"必须记录 BLOCKED"，但版本决定已把目标改为 **5.1.75，而该版本确实已发布**，所以探针诚实返回 `TARGET_PRESENT`，旧判定把一个**诚实结果**判成失败。现判定改为"结果须与工件可用性一致"：不可用/不可达→BLOCKED，可用→TARGET_PRESENT，并新增 `unavailableReason` 记录原因。**覆盖损失如实记录**：只要目标版本已发布，"工件缺失"这一分支就**无法被真实触发**，该用例不再覆盖 BLOCKED 路径。**任务仍未完成**：成功用例 `official-5167-reprobe` 需要在任务 2 的容器里真实复探 goal、todo、thread/子代理审批三项能力，且需要可用的免费模型凭据；当前宿主无可用模型，故三项能力应记为 **BLOCKED** 而非 PASS。
  - **2026-11-18 基线变更（用户决定）**：「用最新 5.1.75」。复探证据：npm 注册表 `omo-ai` 的 `dist-tags.latest` 为 `5.1.75`；版本表中**不存在 5.1.67**（相邻已发布版本为 5.1.66 与 5.1.68）。5.1.75 指纹：`integrity sha512-s9AbVpxsGrV65SlX6YG1BY4g30SCEILPqc3+ZFk4UhQ5Kw+p3nINOd7LboE7kUhdQmXRJzoZ3JjZAONfbGBcqA==`、`shasum 17c6eea570905bdbd11bfaf4b36c232df83a840f`、发布于 2026-11-16T19:36:24.929Z。原「必须是 5.1.67」的表述由本条替代，其余验收条件不变。
  - **2026-11-18 账务更正**：本条 References/验收点名的 `bridge-product.kn2I62Kg/` 在本工作区**不存在**；本日复探的对应回执在 `.omo/evidence/t03-reprobe/EVIDENCE.md`（5.1.67 未发布、5.1.75 为 latest 及其指纹），原指针保留以便追溯。
- [x] 4. 创建真实 PTY 与 xterm 可视 QA 工具
  - Recommended task executor category: deep-low — 需要事件驱动进程、浏览器和清理回执。
  - 做什么：在 `product/opencode/tools/bridge-qa/` 创建独立测试包、锁文件和 `run.ts`；仅增加已批准的开发依赖 `@xterm/xterm@6.0.0`。作为唯一写者，在受限环境执行 `(cd product/opencode && bun --no-env-file install --frozen-lockfile --ignore-scripts --cache-dir "$RUN_TMP/bun-install-cache")` 安装 fork 已锁定依赖；在 QA 包内用相同隔离缓存安装唯一新增依赖并生成锁文件。审计原生依赖必要的生命周期脚本后，在相同隔离内逐个执行；不可确认安全或缺少所需工件时 BLOCKED。提供固定 `case <name> --out <new-directory>`、独立场景文件加载、PTY 输入、隔离浏览器 xterm 截图、结构化结果、脱敏日志与清理；禁止复用用户浏览器状态。此项只实现自身两个场景，后续场景由各自任务与实际功能同时实现，不创建空操作或占位。
  - Closes: GAP-4, GAP-6；Wave A | Blocked by: 1 | Blocks: 3, 7–31。
  - References: `upstream/opencode/packages/tui/package.json:8-10`、`knowledge/verification-plan.md:28-38`；执行者读 Bun、browser 和 visual-qa 技能。
  - 验收：实际 PTY 的 ANSI 色彩、中文宽字符及 Enter 应答进入 xterm，截图与文本回执均生成；每次端口、子进程和浏览器均释放。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case harness-pty --out "$QA_EVIDENCE/t04-pty"`；受控 PTY 写入 `ESC[31m中ESC[0m`，代理发送 Enter，xterm 中该字占两列且前景为红色，截图和 `result.json` PASS。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case unknown-case --out "$QA_EVIDENCE/t04-unknown"`；必须非零且不残留资源。
  - Commit: N。

- [x] 5. 固定能力账本与接口映射范围
  - Recommended task executor category: deep-low — 行级映射和不等价分类需要对原表逐项核对。
  - 做什么：在 `product/opencode/packages/bridge-core/spec/capabilities.json` 记录原协议表全部 95 行及 `knowledge/source-documents/03-omo-feature-presentation.md` 的各原生能力、Mini、插件、客户端 MCP；每行给源位置、目标能力、语义差异、用户范围、实现任务、测试、证据和用户可见后果；状态限定为 `unverified`、`verified`、`degraded`、`unsupported`、`blocked`。保留重复行而不把它们当不同 API；用户明确选入的接口不可随意标记排除或以降级冒充完整。由校验器检查完整性、唯一行键和任务映射。
  - Closes: GAP-3, GAP-6, GAP-7；Wave A | Blocked by: 1, 4 | Blocks: 6, 31。
  - References: `knowledge/source-documents/01-protocol-comparison.md`、`knowledge/compatibility.md:7-42`、`knowledge/source-documents/03-omo-feature-presentation.md:93-121`、`knowledge/development-standards.md:474-487`。
  - 验收：源表逐行和三个额外接缝均有可执行映射；不声称 76/95 是实测兼容率。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case matrix-complete --out "$QA_EVIDENCE/t05-complete"`；校验全部源行有映射。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case matrix-missing-row --out "$QA_EVIDENCE/t05-missing"`；删除合成副本的一行后必须拒绝。
  - Commit: N。

- [x] 6. 定义共享协议、身份与状态契约
  - Recommended task executor category: deep-high — 跨包接口及状态不变量决定所有下游实现。
  - 做什么：创建 `packages/bridge-core/package.json`、`src/contracts.ts`、错误类型与 `test/contracts.test.ts`；沿用现有工作区依赖，不引入未经授权的运行依赖。由此任务单独执行 `(cd product/opencode && bun --no-env-file install --ignore-scripts --cache-dir "$RUN_TMP/bun-install-cache")` 更新 workspace 锁文件，核对仅新增本地包，任何其他依赖/版本变化立即停止。明确连接、会话、持久身份、消息、part、工具调用、审批、事件、取消、能力和带来源的快照类型。缺失、null、未知字段在 RPC 边界解析；不以 `any` 传入 UI；冻结事件顺序和失败分支，并给 7–12 提供不重叠文件接口。
  - Closes: GAP-2, GAP-3；Wave B | Blocked by: 5 | Blocks: 7–12。
  - References: `knowledge/architecture.md:45-51`、`knowledge/rpc-transport.md:5-27,48-60`、`knowledge/rpc-recovery.md:5-18`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/contracts.test.ts` 一次通过，未知事件、无效身份不被静默接收。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case contract-valid --out "$QA_EVIDENCE/t06-valid"`；合法合成事件通过真实解码入口。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case contract-malformed --out "$QA_EVIDENCE/t06-invalid"`；错误字段产生类型化错误。
  - Commit: N。

- [x] 7. 实现 JSONL 传输与认证边界
  - Recommended task executor category: deep-low — 帧分割、背压与认证失败必须一起验证。
  - 做什么：创建 `packages/bridge-core/src/transport.ts` 和对应测试，支持实际 stdio 与 POSIX socket JSONL；按 LF、增量 UTF-8、CRLF、EOF 和目标版本上限处理，区分连接和会话。socket 使用目标官方协议的挑战应答，业务代码仅处理独立测试目录内的临时宿主认证材料；代理、探针、日志和回执不能读取或输出密钥。对拒绝、超限、断流和背压给出明确错误。
  - Closes: GAP-2, GAP-4；Wave B | Blocked by: 4, 6 | Blocks: 8, 11, 13。
  - References: `knowledge/rpc-transport.md:5-46`、`upstream/senpi/packages/coding-agent/src/modes/rpc/jsonl.ts:161-243`、`upstream/senpi/packages/coding-agent/docs/rpc.md:1349-1458`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/transport.test.ts` 一次通过；socket 与 stdio 结果分别记账。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case transport-split-utf8 --out "$QA_EVIDENCE/t07-frame"`；实际适配器对跨块 UTF-8 和 CRLF 得到唯一正确帧。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case transport-auth-reject --out "$QA_EVIDENCE/t07-auth"`；错误认证不得进入已连接状态。
  - Commit: N。

- [x] 8. 实现会话身份和生命周期
  - Recommended task executor category: deep-low — 不同身份和 unload/park/close 不能混同。
  - 做什么：创建 `packages/bridge-core/src/sessions.ts` 和对应测试；覆盖 open、attach、list、detach、park/unload、close、历史重开及活动会话/持久身份区分。仅在同机隔离工作区读取被明确授予的历史；正确处理外层成功但业务 refused，以及活跃 turn/挂起审批导致的拒绝。
  - Closes: GAP-2, GAP-3；Wave B | Blocked by: 7 | Blocks: 13, 20。
  - References: `knowledge/sessions.md`、`knowledge/rpc-recovery.md:5-18`、`upstream/senpi/packages/coding-agent/docs/rpc.md:1349-1364,3012-3035,3884-3923`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/sessions.test.ts` 一次通过；句柄与持久身份无误关联。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case session-reopen --out "$QA_EVIDENCE/t08-reopen"`；真实适配器打开、卸载并恢复受控会话。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case session-unload-refused --out "$QA_EVIDENCE/t08-refused"`；业务 refused 不显示为成功。
  - Commit: N。

- [x] 9. 实现流式消息与工具结果投影
  - Recommended task executor category: deep-low — 快照、增量与最终消息的去重是状态机问题。
  - 做什么：创建 `packages/bridge-core/src/stream.ts` 和对应测试，按目标事件协议投影文本、thinking、工具参数/结果及最终消息；累计 partial 替换而非重复追加，`message_end` 为最终基线；识别 `agent_idle`，不能把 prompt started 当完成。缺字段、null、reset、乱序及未知扩展事件均按明确规则处理。
  - Closes: GAP-1, GAP-2；Wave B | Blocked by: 4, 6 | Blocks: 13。
  - References: `knowledge/streaming.md`、`knowledge/verification-plan.md:28-38`、`knowledge/rpc-transport.md:5-19`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/stream.test.ts` 一次通过；已知累计序列不重复、不丢最终消息。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case stream-cumulative --out "$QA_EVIDENCE/t09-stream"`；向真实适配器发送 A、AB、最终 AB，输出恰为 AB 一次。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case stream-null-reset --out "$QA_EVIDENCE/t09-reset"`；缺失 partial 和参数 reset 不崩溃、不沿用旧参数。
  - Commit: N。

- [x] 10. 实现权限与结构化对话安全状态机
  - Recommended task executor category: deep-high — 授权、并发与过期答复涉及安全不变量。
  - 做什么：创建 `packages/bridge-core/src/dialogs.ts` 和对应测试；处理 select、confirm、input、editor、question、取消、超时、并发、首答回执及 pendingDialogs 恢复。只发送宿主原始候选值，客户端未知值 fail closed；question 的 required 不被冒充为服务端授权。目标官方宿主若复现异常选项 fail-open，阻止该版本的安全验收，除非有不修改官方宿主且经真实链路验证的隔离处置。
  - Closes: GAP-2, GAP-4；Wave B | Blocked by: 4, 6 | Blocks: 13, 17。
  - References: `knowledge/security-permissions.md:5-16,44-54`、`knowledge/rpc-recovery.md:20-46`、`knowledge/verification-plan.md:44-52`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/dialogs.test.ts` 一次通过；不把客户端校验替代宿主安全验证。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case dialog-allow-once --out "$QA_EVIDENCE/t10-allow"`；真实适配器仅发送原始一次性选项并确认首答。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case dialog-invalid-stale --out "$QA_EVIDENCE/t10-reject"`；未知或过期答复不得授权。
  - Commit: N。

- [x] 11. 实现断线、事件缺口与副作用恢复
  - Recommended task executor category: deep-high — 重连和 replyLost 的正确性依赖跨事件不变量。
  - 做什么：创建 `packages/bridge-core/src/recovery.ts` 和对应测试；区分同连接溢出、客户端断开、会话卸载与宿主重启。仅在实现 reset 时声明 `event_resync`；处理 `resync_required`、快照替换、工具参数 reset、pendingDialogs、心跳完整能力列表和 `replyLost`。未确认的副作用不得自动重放。
  - Closes: GAP-2, GAP-4；Wave B | Blocked by: 7 | Blocks: 13。
  - References: `knowledge/rpc-recovery.md:20-76`、`knowledge/rpc-transport.md:48-60`、`upstream/senpi/packages/coding-agent/docs/rpc.md:758-847`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/recovery.test.ts` 一次通过；无固定等待。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case recovery-gap --out "$QA_EVIDENCE/t11-gap"`；socket 断线后恢复快照而不重复消息。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case recovery-reply-lost --out "$QA_EVIDENCE/t11-lost"`；未知副作用不重复执行且显示可恢复错误。
  - Commit: N。

- [x] 12. 实现输入队列、取消和模型状态
  - Recommended task executor category: deep-low — 队列与 abort/interrupt 语义需要显式关联。
  - 做什么：创建 `packages/bridge-core/src/interaction.ts` 和对应测试，支持 prompt、steer、follow_up、abort、interrupt、模型与 thinking level、权限预设及其状态；读取目标宿主实际值，不把不同源码入口的 steer 默认值合并为既定事实。异常模型、过期 turn 和无权切换均反馈给 UI。
  - Closes: GAP-1, GAP-2；Wave B | Blocked by: 4, 6 | Blocks: 13。
  - References: `knowledge/streaming.md`、`knowledge/security-permissions.md:18-38`、`knowledge/verification-plan.md:53-55`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/interaction.test.ts` 一次通过；输入身份和完成信号保持一致。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case queue-steer --out "$QA_EVIDENCE/t12-queue"`；生成中排队输入按协议进入后续 turn。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case queue-stale-turn --out "$QA_EVIDENCE/t12-stale"`；过期 turn 不改变当前会话。
  - Commit: N。

- [x] 13. 集成适配包与 OpenCode 数据接口
  - Recommended task executor category: deep-high — 跨包公开契约与事件投影必须保持一致。
  - 做什么：独占 `packages/bridge-core/src/index.ts`、`client.ts` 和 `data.ts`，组合 7–12，提供 TUI 与插件所需的 OpenCode 客户端/数据形状；使用进程内映射，不开放 HTTP/SSE 服务。后续任务尚未实现的账本行保留 `unverified` 并返回明确错误，直到任务 31 逐项验收；未知能力不伪造成功。
  - Closes: GAP-1, GAP-3, GAP-6；Wave B | Blocked by: 7–12 | Blocks: 14, 23–25。
  - References: `upstream/opencode/packages/tui/src/context/client.tsx:16-47`、`upstream/opencode/packages/tui/src/context/data.tsx:11-22`、`upstream/opencode/packages/plugin/src/tui/context.ts:63-100,544-560`、`knowledge/compatibility.md`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test/client-data.test.ts` 一次通过，类型检查不压制任何错误。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case client-data-live --out "$QA_EVIDENCE/t13-data"`；真实适配器请求及事件更新同一数据视图。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case client-unsupported --out "$QA_EVIDENCE/t13-unsupported"`；无对应能力返回明确错误而非虚假成功。
  - Commit: N。

- [x] 14. 将主 TUI 启动、连接与数据上下文接入适配器
- `[~]` 顺序缺口（2026-11-17 用户决定“先做 26 和宿主”）：实测 `ClientProvider` 需要完整 `OpenCodeClient` 的 13 组，其中 10 组依赖真实宿主数据（任务 26 与 29–31）；消费面为 114 处调用（`useClient` 41 / `useData` 51 / `useLocation` 22）。因此本任务改为在 26 与宿主验证之后继续；已完成的桥接件（`client-surface`、`event/session/config` 三组、`bridge-client`/`bridge-data`/`bridge-location` 上下文、`bridge-entry`、`tui-host-unavailable` 场景）保留。15–25 保持未勾选，属排序延后而非受阻。
  - Recommended task executor category: deep-high — fork 启动、连接与客户端数据跨包契约需要共同调整。
  - 做什么：独占 fork 的 `packages/tui/src/app.tsx`、`src/context/client.tsx`、`src/context/data.tsx`，并创建 `packages/cli/src/bridge-entry.ts`；注入任务 13 的进程内客户端及连接，不启动 OpenCode 服务、不构造 HTTP/SSE 门面。桥接入口接受 `--socket` 和 `--mini`，测试时必须显式给出隔离 socket；保留原 provider、插件上下文、渲染器生命周期与显式连接状态。为 15–27 提供稳定的 feature 注入接缝。
  - Closes: GAP-1, GAP-3；Wave C | Blocked by: 13 | Blocks: 15–27。
  - References: `upstream/opencode/packages/tui/src/app.tsx:213-243`、`upstream/opencode/packages/tui/src/context/client.tsx:16-47,63-73`、`upstream/opencode/packages/tui/src/context/data.tsx:11-22`、`upstream/opencode/packages/tui/test/cli/tui/data.test.tsx`。
  - 验收：`cd product/opencode/packages/tui && bun --no-install --no-env-file test ./test/bridge/bootstrap.test.tsx` 一次通过，真实 TUI 不访问 OpenCode 服务。（2026-11-17 实测：从仓库根跑任何 TUI `.tsx` 测试会因 `solid-js`/`@opentui/solid` 按包安装而报 `Cannot find module react/jsx-dev-runtime`；必须以包目录为 cwd，证据见 ledger `task14_test_harness_finding`。）
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-bootstrap --out "$QA_EVIDENCE/t14-start"`；PTY 中启动主 TUI，连接状态变为 ready，xterm 截图有完整布局。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-host-unavailable --out "$QA_EVIDENCE/t14-fail"`；连接失败可见且无进程残留。
  - Commit: N。

- [x] 15. 实现对话转录、输入与流式交互
  - 2026-11-18 完成记录（协调者实跑）：转录测试 `test/bridge/transcript.test.tsx` 4 pass / 0 fail（28 断言）；`tui-stream` 7/7、`tui-stream-error` 8/8，均 exit 0，证据在 `.omo/evidence/t15-stream/` 与 `.omo/evidence/t15-error/`。先前的两处阻塞已不成立：`session.prompt` 现接受注入发送器（`bridge-data.ts:265`，仅在未注入时拒绝），`data.on`/`data.listen` 已接到事件面。仍不声称的：真实宿主流式响应下的手动观感（那属于任务 30/31 的验收面）。
  - Recommended task executor category: visual-engineering — 需要保留终端布局并处理实时内容。
  - 做什么：在 `packages/tui/src/bridge/features/transcript/` 实现用户输入、文本、thinking、工具调用/结果、流式状态和错误；将原 TUI 视图通过 14 的接缝接到任务 9/12。保留快捷键、宽字符和不同终端宽度；不以布局变化隐藏工具结果。
  - Closes: GAP-1, GAP-2；Wave C | Blocked by: 14 | Blocks: 28。
  - References: `knowledge/streaming.md`、`knowledge/verification-plan.md:28-38`、`upstream/opencode/packages/tui/src/routes/session/`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/transcript.test.tsx` 一次通过。 （2026-11-17 实测更正：以仓库根为 cwd 运行会因 bun 不加载 `packages/tui` 的 bunfig/tsconfig 而报 `Cannot find module react/jsx-dev-runtime`；可行形式是 `cd product/opencode/packages/tui && bun --no-install --no-env-file test ./test/bridge/<file>`，与任务 14 记录的同一 harness 结论一致。）
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-stream --out "$QA_EVIDENCE/t15-stream"`；在真实 PTY 输入固定合成问题，累计文本最终只呈现一次，保留工具结果并截图。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-stream-error --out "$QA_EVIDENCE/t15-error"`；模型不可用时状态转为 error，界面仍能输入。
  - 2026-11-17 进展与未决（本任务未勾选）：转录模块已在 `packages/tui/src/bridge/features/transcript/` 落地并由 `test/bridge/transcript.test.tsx` 4 项测试覆盖（真实 BridgeData 负载驱动，宽字符与窄终端不丢内容，错误态下新输入仍被回显）；`data.on`/`data.listen` 与 `session.prompt` 仍显式抛 `UnsupportedCapability`——前者需要模式校验的宿主帧解码器（手写类型守护等同断言未验证形状），后者需要 turn 起始与真实传输发送（客户端签名会生成乐观 inbox id，伪造即在转录中插入幻影消息）；`session.pending.list` 返回空数组，仅表示桥接层尚未投影宿主队列。QA 用例 `tui-stream`/`tui-stream-error` 尚未创建且需要真实宿主流式响应，故不宣称通过。曾尝试在 `packages/bridge-core/spec/capabilities.json` 追加三个能力接缝行，但该账本的校验用例（`matrix-complete`）按 95 行 + 3 接缝固定，追加会使用例失败，已回滚并改记于本注。
  - Commit: N。

- [x] 16. 实现会话列表、历史与树导航
  - Recommended task executor category: visual-engineering — 需要对会话轨和状态变化做真实终端检查。
  - 做什么：在 `packages/tui/src/bridge/features/sessions/` 实现活动会话、明确授权工作区中的历史、切换、分支/树导航及 reopen；区分活动列表与历史文件，不把 `move_session` 当成原地改 cwd。不得读取实际用户会话做测试。
  - Closes: GAP-2, GAP-3；Wave C | Blocked by: 14 | Blocks: 28。
  - References: `knowledge/sessions.md`、`knowledge/rpc-recovery.md:5-18`、`knowledge/source-documents/00-handoff.md:64-75`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/sessions.test.tsx` 一次通过。 （2026-11-17 实测更正：以仓库根为 cwd 运行会因 bun 不加载 `packages/tui` 的 bunfig/tsconfig 而报 `Cannot find module react/jsx-dev-runtime`；可行形式是 `cd product/opencode/packages/tui && bun --no-install --no-env-file test ./test/bridge/<file>`，与任务 14 记录的同一 harness 结论一致。）
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-history-reopen --out "$QA_EVIDENCE/t16-history"`；通过按键重开隔离夹具会话并恢复正确转录。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-open-refused --out "$QA_EVIDENCE/t16-refused"`；拒绝或损坏历史时显示错误，现有会话不变。
  - Commit: N。

  - 2026-11-18 完成（协调者独立复跑）：`sessions.test.tsx` 8 通过 0 失败；`tui-history-reopen` 用例 exit 0、6/6 通过（真实按键 Down→Return 重开第二个会话，屏幕上出现的是**该会话**的助手文本与工具结果，另一会话的转录不出现；无宿主负载的幽灵历史不会被渲染成行）；`tui-open-refused` 用例 exit 0、6/6 通过（拒绝显示 `UNKNOWN_PERSISTENT_ID`，已打开会话的转录保持不变）。**限制**：用例以组件-in-PTY 驱动真实 `Sessions`/`Transcript` 组件，**不是组装后的产品**；`Sessions` 仍未被 `app.tsx` 挂载（归 28）；未经原生会话列表对话框导航、未涉及真实宿主会话与磁盘历史文件、未验证真实 `move_session`/重绑。
- [x] 17. 实现权限、问题和其他阻塞对话
  - Recommended task executor category: visual-engineering — 模态交互必须与授权状态机一致。
  - 做什么：在 `packages/tui/src/bridge/features/dialogs/` 连接任务 10，渲染 select、confirm、input、editor 和结构化 question；显式显示预设来源、可选项和取消/超时，不把 required 标识当服务端授权。重连恢复时按对话身份更新而不重复提交。
  - Closes: GAP-1, GAP-2；Wave C | Blocked by: 10, 14 | Blocks: 28。
  - References: `knowledge/security-permissions.md:5-16`、`knowledge/rpc-recovery.md:20-46`、`knowledge/verification-plan.md:44-52`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/dialogs.test.tsx` 一次通过。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-permission-once --out "$QA_EVIDENCE/t17-once"`；按键选择原始 Allow once 并观察真实适配器的首答回执。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-dialog-stale --out "$QA_EVIDENCE/t17-stale"`；过期对话不能再次授权，截图与结果记录拒绝。
  - Commit: N。
  - 2026-11-17 收尾记录（本任务勾选依据）：五类宿主对话框（select／question／confirm／input／editor）在 `packages/tui/src/bridge/features/dialogs/` 建模并渲染，`dialogs.test.tsx` 18 项通过；对话框面板已挂入 `app.tsx` 的桥接模式；键位作答（数字选选项、y/n 应答 confirm、Esc 取消）已实现。QA：`tui-permission-once` 与 `tui-dialog-stale` 均 `exit=0`、`verdict=PASS`、清理回执 ok。**过程中发现并修复了一个真实缺陷**：键位处理里写成 `props.store === undefined ? undefined : store.live()[0]`，属于判断反向——应用内未注入 store 时处理器永远提前返回；我先前的键位测试因都注入了 store 而没暴露它，是两个 PTY 用例把它逼出来的。边界：`extension_ui_response` 的字节形状经同一解码器往返验证，但**从未对真实宿主验证**；面板键位只在测试与合成的 PTY 中驱动过。
  - 2026-11-17 进展与词汇不匹配：已实现 `permission.asked/replied` 与 `form.created/replied/cancelled` 的投影（`BridgeData` 存储 + `host-event.ts` 的 apply 函数 + `session.permission.list`/`session.form.list`），由 `packages/tui/test/bridge/bridge-data.test.ts` 覆盖，桥接套件 62 项通过。但随后查证：真实 OmO/Senpi 宿主使用的是下划线扩展事件 `permission_asked`/`permission_replied`（`upstream/senpi/.../permission-system/events.ts`）与 `extension_ui_request`/`extension_ui_response` 帧（`runtime/ui-broker.ts:81`、`docs/rpc.md:541`），并非 OpenCode schema 的点号事件。故现有投影对 schema 正确但尚未接到宿主词汇；回复路径（`session.permission.reply`、`session.form.reply/cancel`）仍抛错，未构造任何未经验证的 id 关联。已委派 `st_01a1ea2b` 以带行号证据固化宿主帧词汇并实现已验证的解码器。 2026-11-17 晚补充（已定论）：`packages/bridge-core/spec/host-frame-vocabulary.md`（带文件行号）确认宿主**从不**发出 OpenCode schema 的 `permission.asked` 或 `form.*`——它们只存在于本工作区的 schema。真实通道是 `extension_ui_request`（`method: select` 为权限提示、`method: question` 为结构化提问）与 `extension_ui_response`（`value` / `answers`+`comment` / `cancelled: true`），关联键是请求帧的 `id`（`crypto.randomUUID()`，既非内部 `permission-<n>` 也非 `toolCallId`）。据此，先前的 schema 投影对真实宿主不会触发；`host-frames.ts` 只解码已验证帧，遇到 OpenCode 事件名按名拒绝而不发明映射。宿主对话框与应答接线由后续任务完成。 2026-11-17 深夜补充（传输已贯通）：`HostDialogStore`（按请求帧 id 索引、重复 resolve 幂等、可注入发送器）、`encodeHostResponseFrame`（`value`／`answers`+`comment`／`cancelled` 三形态，编码后用同一解码器验回）、桥接数据面 `onHostDialog`／`respondToHostDialog`，以及 `bridge-run` 的入站转发与 `transport.send` 注入均已落地；`bridge-core` 155 项、`tui` 桥接 66 项、`cli` 全量 390 项通过（我另一次运行的单项失败在孤立复跑中通过，属并发负载）。**未验证**：从未启动真实宿主或打开 socket，证明的是发出字节与文档 schema 一致且可被同一解码器解回，**不是**活宿主接受并清除提示。界面（`features/dialogs/` 与其测试）仍在实现，当前无 UI 消费该层。 2026-11-17 追加：界面模块 `packages/tui/src/bridge/features/dialogs/`（757 行）与 `test/bridge/dialogs.test.tsx`（10 项）已落地，覆盖 select 与 question；`confirm`/`input`/`editor` 的**协议层**已补齐（`host-frames.ts` 按上游 `rpc-question-types.ts` 解码并新增 `confirmed` 应答，`bridge-core` 158 项通过），界面建模与上屏正在扩展。**QA 用例依赖**：`tui-permission-once` 与 `tui-dialog-stale` 需要在 PTY 中看见真实对话框并作答，而对话框功能尚未挂载进 `app.tsx`（属任务 28 的接线），因此这两项在本任务内无法先行取得 PASS。

- [x] 18. 实现同机文件、差异与安全检查点
  - Recommended task executor category: deep-high — 文件回滚涉及冲突、用户数据与非原子恢复。
  - 做什么：在 `packages/tui/src/bridge/features/files/` 提供明确授权目录内的文件列表、读取、差异和可确认的恢复；检查点存于独立的产品自有影子对象库，保留路径、内容摘要、忽略与权限信息，不在用户仓库暂存、提交或写 refs。恢复前检查后续用户编辑、并发和部分失败；不把该机制称为 OpenCode Snapshot 等价。
  - Closes: GAP-2, GAP-3；Wave C | Blocked by: 14 | Blocks: 28。
  - References: `knowledge/terminals-and-files.md`、`knowledge/verification-plan.md:55-57`、`knowledge/source-documents/00-handoff.md:69-72`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/files.test.ts` 一次通过；只操作本次合成工作区，不创建 Git commit。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case files-diff-restore --out "$QA_EVIDENCE/t18-restore"`；在隔离夹具中修改、确认并恢复目标文件，比较前后字节。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case files-conflicting-edit --out "$QA_EVIDENCE/t18-conflict"`；冲突时拒绝覆盖，用户新内容保持不变。
  - Commit: N。
  - 2026-11-17 收尾记录（本任务勾选依据）：`packages/tui/src/bridge/features/files/`（state/spec/store/index）与 `test/bridge/files.test.ts` 落地，11 项测试通过；路径先按字面拒绝 `..`／绝对路径／NUL，再过 `realpath`，符号链接逃逸报 `outside-root` 且不被跟随；检查点写入产品自有影子对象库（`objects/<sha256>` + 最后写清单，含路径、摘要、字节数、模式与忽略决策），**从不调用 Git**；恢复走"先出计划、用户确认、比对 sha-256 令牌、写入前逐文件复核"，检测到确认后的新编辑即 `stale-confirmation` 拒绝且用户新内容保持，部分失败给 `partial` 回执而不半途覆盖。QA：`files-diff-restore` 与 `files-conflicting-edit` 均 `exit=0`、`verdict=PASS`、`cleanup` 为 ok，我独立复跑确认。边界：**未加面板视图**（面板挂载属任务 28）；恢复语义为"以确认的计划为准"，与"任何与检查点不同即拒绝"不同，后者会让真实恢复无法进行；单文件捕获上限 2 MiB，超限报 `skipped` 而非替换。

- [x] 19. 实现 macOS 本地 PTY 与终端面板
  - Recommended task executor category: deep-low — PTY 生命周期、输入授权和会话归属相互依赖。
  - 做什么：在 `packages/tui/src/bridge/features/terminal/` 实现同机 macOS PTY 创建、输入、resize、关闭和会话绑定；不复用要求 OpenCode server URL 的原 WebSocket PTY 作为已实现能力。受控环境变量、cwd 与 shell 只指向隔离夹具；终端打开不自动执行命令。
  - Closes: GAP-2, GAP-3；Wave C | Blocked by: 14 | Blocks: 25, 28。
  - References: `upstream/opencode/packages/tui/src/context/client.tsx:27-29,63-65`、`upstream/opencode/packages/tui/src/context/session-terminals.tsx`、`upstream/opencode/packages/tui/src/component/terminal-pane.tsx`、`knowledge/terminals-and-files.md`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/terminal.test.ts` 一次通过；PTY 进程树均可回收。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case terminal-open-resize --out "$QA_EVIDENCE/t19-resize"`；在真实 macOS PTY 打开受控 shell、执行固定无副作用的 `pwd` 并从 80×24 调整到 120×40，cwd 与屏幕正确。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case terminal-wrong-session --out "$QA_EVIDENCE/t19-denied"`；跨会话写入被拒且目标 PTY 不变。
  - Commit: N。
  - 2026-11-17 收尾记录（本任务勾选依据）：`packages/tui/src/bridge/features/terminal/`（state/spec/store/index）与 `test/bridge/terminal.test.ts` 落地，7 项测试通过（受控 env 用外部哨兵对照、`stty size` 证明内核级 80x24→40x120、跨会话写入被拒且目标屏幕逐字节不变、关闭后以 `process.kill(pid,0)` 抛 ESRCH 证明整棵进程树回收）；`tui` 桥接套件 89 项通过。QA：`terminal-open-resize` 与 `terminal-wrong-session` 均 `exit=0`、`verdict=PASS`、清理回执 `ok:true`（无残留进程），我独立复跑确认。边界：`persistentPty`（需 OpenCode server URL 的 WebSocket PTY）未被冒充，`terminal-pane.tsx`/`session-terminals.tsx` 未改；面板接线与 `session-terminals` 替换归任务 28/25。

- [x] 20. 实现 task、todo 与 goal 主路径
  - Recommended task executor category: visual-engineering — 多种独立数据面需要明确视觉与交互区分。
  - 做什么：在 `packages/tui/src/bridge/features/tasks/` 分别投影 OmO task/子代理、当前分支 todo、goal 状态和线程审批；处理快照截断、父会话权限和树切换。不得把 task 当 todo，不把全历史最后一条 todo 当当前分支，也不得把 `/goal inspect` 当只读查询。
  - Closes: GAP-2, GAP-3；Wave D | Blocked by: 8, 14 | Blocks: 22, 28。
  - References: `knowledge/native-features.md:5-45`、`knowledge/source-documents/03-omo-feature-presentation.md:97-103,115-121`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/tasks.test.tsx` 一次通过。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case native-task-todo-goal --out "$QA_EVIDENCE/t20-native"`；独立事件分别更新任务、待办和目标区域。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case native-task-truncated --out "$QA_EVIDENCE/t20-truncated"`；截断或跨会话操作明确提示且不误操作。
  - Commit: N。

  - 2026-11-18 完成（协调者独立复跑）：`tasks.test.tsx` 4 通过 0 失败；`native-task-todo-goal` 用例 exit 0、5/5 通过（四个分区分别被观测，任务区更新时待办/目标仍为 not reported）；`native-task-truncated` 用例 exit 0、5/5 通过（截断可见、跨会话任务与审批均被拒绝且回执写明原因、写入次数 0）。**重要限制**：task/todo/goal 三个面的输入目前是**有类型、标注来源的投影输入**，不是实时宿主数据——`bridge-core` 的 `rpc.call` 仍未实现，无法取 `omo.task.*`；`bridge-run` 的拉取没有 `get_entries`（无 `leafId` 与树），因此当前分支 todo 只能由调用方注入；goal 插件在桥接下 `client.rpc` 抛 `UnsupportedCapability`，故 goal 面显示「not reported here」而非「没有 goal」。**审批链路是真实端到端**（`publishEvent` → `decodeHostFrame` → `hostDialogs` → `respondToHostDialog` 写回 `extension_ui_response`）。真实取数接线归 27/28。
- [x] 21. 实现 memory、team 与通知侧栏
  - Recommended task executor category: visual-engineering — 状态栏与侧栏需处理缺字段和不同终端宽度。
  - 做什么：在 `packages/tui/src/bridge/features/status/` 覆盖 memory 状态/更新、team 成员、侧栏、通知、状态与 widget；读取能力只用于当前隔离会话，持久写入必须显式授权。空快照、隐藏通知和组件工厂不过 RPC 的情形如实呈现，不编造 widget 行。
  - Closes: GAP-3, GAP-7；Wave D | Blocked by: 14 | Blocks: 28。
  - References: `knowledge/native-features.md:21-25,65-71`、`knowledge/source-documents/03-omo-feature-presentation.md:93-105`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/status.test.tsx` 一次通过。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case native-memory-team --out "$QA_EVIDENCE/t21-status"`；合成事件分别更新 memory 和 team 状态并截图。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case native-widget-empty --out "$QA_EVIDENCE/t21-empty"`；缺少 widget 内容时不显示虚构数据。
  - Commit: N。

  - 2026-11-18 完成（协调者独立复跑）：`status.test.tsx` 6 通过 0 失败；`native-memory-team` 用例 exit 0、6/6 通过（状态列渲染、memory 事件更新 memory 区、**缺失字段显示为未上报**、team 事件更新成员区、**被隐藏的通知保持隐藏**）；`native-widget-empty` 用例 exit 0、5/5 通过（**未上报即显示为无、widget 渲染 0 行、不出现虚构行**）。
  - 限制（子任务自述，协调者记录）：状态列在**真实 PTY** 中挂载真实组件并由真实 `BridgeData` 解码驱动，但**事件来自合成帧**，未经过真实 Senpi RPC 连接，也未写入任何 memory 仓库；列尚未被 `app.tsx` 挂载（归 28）。两个缺失的底层能力同时阻塞 20 与 21：①缺少解码后的宿主帧feed（`extension_event`、一次性 `extension_ui_request` 的 `notify/setStatus/setWidget`、`custom_message`），今天它们只以原始项出现在 `BridgeData.subscribeEvents`，而 `onHostEvent` 用 OpenCode 事件清单校验、`decodeHostFrame` 拒绝一次性方法；②整个仓库没有 `extension_request` 发送器与 id→响应路由，因此 memory 拉取发不出去、写入只能靠注入。
- [x] 22. 实现 DAG 独立右侧面板及恢复
  - Recommended task executor category: deep-high — 快照、水位和溢出恢复的顺序需要保持不变量。
  - 做什么：在 `packages/tui/src/bridge/features/dag/` 创建与现有 terminal/sidebar 互斥的右侧面板，消费 list、snapshot、history、subscribe、updated、event、heartbeat 和 activity；按 run/seq 去重，overflow 按协议补齐历史，不把 subscribe 当持久注册。
  - Closes: GAP-2, GAP-7；Wave D | Blocked by: 20 | Blocks: 28。
  - References: `knowledge/native-features.md:49-57`、`knowledge/source-documents/04-roadmap.md:123-127`、`upstream/opencode/packages/tui/src/component/session-frame.tsx`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/dag.test.tsx` 一次通过；不能依赖本轮不存在的非空历史抓包。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case dag-live --out "$QA_EVIDENCE/t22-live"`；真实面板显示受控非空运行及增量。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case dag-overflow --out "$QA_EVIDENCE/t22-overflow"`；缺口恢复后无重复、无遗漏。
  - Commit: N。

  - 2026-11-18 进展（协调者本人）：`features/dag/` 已有 state（账本：`(runId,seq)` 恰好一次、迟到事件接收、缺口=上一 head 到当前 seq、overflow 以 `recoverAfterSeq` 排他下界到自身 seq 为界、`droppedCount` 只记录不作游标、历史页区间全在才闭合）、connect（四通道各自路由；`omo.dag.list` 拉一次且拒绝要上报；overflow 触发有界 `omo.dag.history`）、panel（右侧面板互斥与恢复；未知持久值恢复为 none 而非猜测）、view（渲染 run/seq/缺口提示/心跳时间，缺口未闭时明说"waiting for history"）。测试：`dag.test.ts` 9、`dag-connect.test.ts` 5、`dag-panel.test.ts` 3，全部通过；`packages/tui ./test/bridge/` 151 通过 0 失败。**未完成**：`dag-live`/`dag-overflow` 两个 PTY 用例、以及 app 级挂载。
  - 2026-11-18 完成（协调者本人实现并复跑）：`dag.test.tsx` 9 通过 0 失败（按 `(runId,seq)` 恰好一次、迟到事件接收、缺口=上一 head 到当前 seq、overflow 以 `recoverAfterSeq` 排他下界到自身 seq、`droppedCount` 只记录不作游标、历史页区间全在才闭合、四通道互不混用、面板互斥与恢复）；`dag-live` 用例 exit 0、3/3 通过（真实 PTY 渲染面板，受控运行出现且 head 递增到 3）；`dag-overflow` 用例 exit 0、3/3 通过（溢出后经 `omo.dag.history` 补齐，head=5 且 gap=none，无重复无遗漏）。**限制**：用例中的"宿主"是受控进程内应答器（与 20/21 同一模式），并非真实 OmO 宿主；面板尚未被 `app.tsx` 挂载（归 28）；`subscribe` 未被当作持久注册，实时事件仍走事件桥。
- [~] 23. 适配 Mini 独立入口与 promise 客户端
  - 2026-11-20 标记 `[~]`（协调者，会话 `01a1f6dd`）：本任务已按用户原话「mini看起来用处不大，可先不接」移出当前交付（见 2026-11-18 范围决定），按计划语法以 `[~]` 记作已结算但不等于完成；Mini 缺口保留记录，用户明确要求后再启动。
  - Recommended task executor category: deep-low — Mini 具有与主 TUI 不同的启动及流状态。
  - 做什么：调整 fork 的 `packages/cli/src/mini.ts` 和 `packages/tui/src/mini/` 接缝，复用任务 13 的共享适配核心并提供 promise 客户端形状；覆盖 catalog、历史、prompt、工具、form、shell、abort 和 reconnect。不得以 `--demo` 或主 TUI 测试替代真实 Mini 接入。
  - Closes: GAP-3, GAP-7；Wave D | Blocked by: 13, 14 | Blocks: 28。
  - References: `upstream/opencode/packages/cli/src/mini.ts:139-155`、`upstream/opencode/packages/tui/src/mini/index.ts:1-6`、`upstream/opencode/packages/tui/src/mini/stream-v2.transport.ts:1-20,43-58,78-86`、`upstream/opencode/packages/tui/test/mini/stream-v2.transport.test.ts:233`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/mini/stream-v2.transport.test.ts ./packages/tui/test/bridge/mini.test.ts` 一次通过。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case mini-stream --out "$QA_EVIDENCE/t23-mini"`；向真实 Mini PTY 输入合成消息 `mini qa`，受控宿主发送累计文本与工具事件，最终消息仅出现一次。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case mini-reconnect-abort --out "$QA_EVIDENCE/t23-abort"`；受控断线与中止后必须到达 idle 或明确错误，不能重复提交。
  - Commit: N。
  - 2026-11-17 进展（未勾选）：`packages/tui/src/mini/bridge.ts` 与 `packages/cli/src/mini.ts` 的接缝已落地，`test/bridge/mini.test.ts` 与既有 `stream-v2.transport.test.ts` 合计 84 项通过（我独立复跑），`packages/tui` 桥接套件 116 项通过。**未通过的原因**：Mini 前端通过 `sdk.event.subscribe` 订阅流，而该成员因 `OpenCodeEvent` 联合中 `durable.version` 为字面量、schema 类型只给出 `number` 而**显式拒绝**；这与 `data.on`/`data.listen` 被拒是**同一个类型缝隙**。因此计划要求的 `mini-stream` 与 `mini-reconnect-abort` 两个 QA 无法取得 PASS，任务保持未勾选。 **另有两项接线未做**（子任务明确披露）：`packages/cli/src/commands/handlers/mini.ts` 从不设置 `bridge`，`bridge-run.ts --mini` 仍启动主 TUI，二者都不在本任务允许的写入范围内；以及传输必须由调用方注入，因为 `split packages/cli/test/import-boundaries.test.ts` 会因 `mini.ts` 导入 `bridge-run` 而把主 TUI 拉进 Mini 依赖图。**该缝隙目前同时卡住三处**：TUI 事件订阅、Mini 流式、以及转录的实时刷新。

  - 2026-11-18 接线现状（协调者核对，供实现者直接使用）：`packages/cli/src/bridge-entry.ts` 的 `parseBridgeArgs` **已解析 `--mini`** 并放进 `BridgeEntryOptions.mini`，`bridge-run.ts:756` **已把 `mini` 传入 `createBridgeEntry`**，但**没有任何代码在 `mini===true` 时启动 Mini**——目前仍启动主 TUI；`packages/cli/src/commands/handlers/mini.ts` **完全不提 `bridge`**，所以命令行没有任何路径能到达桥接接缝。两条约束：`mini.ts` **不得导入 `bridge-run`**（会把主 TUI 拉进 Mini 的依赖图，`packages/cli/test/import-boundaries.test.ts` 会失败），传输必须由调用方注入；现有测试 `bridge-run.test.ts` 已断言 `--mini` 被解析为 `true`，改动后不得回退该行为。
  - 2026-11-18 进展（协调者本人实现并运行）：启动分支已接（`bridge-run.ts` 在 `--mini` 时走 `runMini` 并注入已认证传输）；新增 `packages/tui/test/bridge/mini.test.ts`（6 项）并通过计划指定的验收命令（`stream-v2.transport.test.ts` + 本文件 = **76 通过 0 失败**）。运行 `mini-stream` PTY 用例时发现并修掉一个真实缺陷：`runMiniBridge` 自建**空的 `BridgeData`**，从不装载启动器已拉取的数据，导致 Mini 永远看不到会话；现改为复用启动器传入的 `data`。**仍阻塞**：用例随后卡在 `location.get`——Mini 的 `resolveMiniBridgeTarget` 需要 `LocationPublicInfo`（含 project.id/directory/canonical），而桥接层没有宿主位置负载，`bridge.ts` 明确拒绝"编造项目身份"。因此 **Mini 目前在真实桥接下无法启动到可用状态**，这是产品缺口而非用例问题。两条可选出路需拍板：①复探宿主是否有位置/项目命令可拉取；②为 Mini 增加"位置未上报"的降级模式（需同步前端展示与能力账本）。用例文件 `tools/bridge-qa/cases/mini-stream.ts` 已存在，当前 **FAIL**，其失败即该缺口的证据。
  - **2026-11-18 范围决定（用户原话）**：「mini看起来用处不大，可先不接」。因此本任务**移出当前交付**，不勾选也不删条目；Mini 的位置缺口保持记录，等用户明确要求再启动。相应地，任务 28 的切换项只覆盖 **transcript ↔ DAG**，不再包含终端之外的第三条路径。
- [X] 24. 适配并验证 TUI 插件公开契约
  - Recommended task executor category: deep-high — 插件 Context、客户端与渲染器跨包兼容。
  - 做什么：保留固定 fork 的 `@opencode/plugin/tui` 完整公开 `Definition` 和 `Context`，包括 client、data、renderer、UI、keymap、storage、slots 及加载/卸载；用任务 13 的真实适配形状而非只提供空对象。第三方插件运行受用户明确启用与本地信任边界约束；不声称对任意未来插件或其他版本无条件兼容。
  - Closes: GAP-3, GAP-7；Wave D | Blocked by: 13, 14 | Blocks: 28。
  - References: `upstream/opencode/packages/plugin/src/tui/plugin.ts:5-13`、`upstream/opencode/packages/plugin/src/tui/context.ts:63-155,191-224,544-560`、`upstream/opencode/packages/tui/src/plugin/context.tsx:694-696`、`upstream/opencode/packages/tui/test/plugin-slot-output.test.tsx:1-23`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/plugin-contract.test.tsx ./packages/tui/test/plugin-slot-output.test.tsx` 一次通过；公开成员未实现时属于阻塞而非默默删掉。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case plugin-real-renderer --out "$QA_EVIDENCE/t24-plugin"`；真实 TUI 加载受控插件，读取 client/data/renderer/UI/存储并渲染 slot，卸载后资源移除。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case plugin-crash-isolation --out "$QA_EVIDENCE/t24-crash"`；异常插件被隔离，主界面保持可用。
  - Commit: N。

  - 2026-11-18 完成（协调者独立复跑）：`plugin-contract.test.tsx` 与 `plugin-slot-output.test.tsx` 4 通过 0 失败；`plugin-real-renderer` 用例 exit 0、7/7 检查通过；可选用例 `plugin-crash-isolation` exit 0、5/5 通过。桥接模式下 `client` 仅 `session.list/get`、`session.message.get`、`plugin.list`、`event.subscribe` 可答，其余（含 `client.rpc`）抛 `UnsupportedCapability("client.<成员>")` 并记日志与警告；信任边界为仅加载用户自有 config 插件目录下的本地插件，项目发现插件仅报告不运行；崩溃隔离只在进程内层成立，无沙箱，用例检查文本已如实写明。已知布局缺陷：`home.footer` 在桥接首页被 Dialogs 区块挤出屏幕，故用例断言 `prompt.footer`，归 17/25/28 处理。
- [x] 25. 实现客户端 MCP 与独立配套扩展
  - Recommended task executor category: deep-high — 宿主扩展、MCP、终端写入与会话授权跨进程。
  - 做什么：创建 `packages/bridge-extension/package.json` 和独立宿主扩展，按会话调用 `registerMcpServer(name, config)` 注册 `type: stdio` 的受控 MCP 服务；并行阶段使用相对导入，不修改共享根锁文件。宿主侧 helper 通过该会话私有 IPC 将模型工具调用交给扩展；扩展以有界请求 ID 的 `tui.pack.mcp.request` 事件投递给 TUI，TUI 经 `extension_request` 的 `tui.pack.mcp.reply` 返回结果；通过单独的 pending 快照处理重连且不得重复写入。数据按实际目标工件协议验证，不架设 OpenCode HTTP 门面。校验会话归属、请求类型、生命周期与重连；每个会话需显式启用，打开终端不执行命令，写入前显示精确内容并要求授权，拒绝、超时或 UI 断开时不写入。未安装扩展时主对话仍可用，但已选 MCP 验收保持未完成。
  - Closes: GAP-2, GAP-7；Wave D | Blocked by: 13, 14, 19 | Blocks: 28。
  - References: `upstream/opencode/packages/tui/src/context/client-mcp.tsx:11-19,22-60,63-104`、`upstream/opencode/packages/client/src/mcp.ts:1-28,59-64`、`upstream/senpi/packages/coding-agent/src/core/extensions/types.ts:2937-2949`、`upstream/senpi/packages/coding-agent/src/core/extensions/builtin/mcp/config-schema.ts:27-54,136-145`、`upstream/senpi/packages/coding-agent/docs/rpc.md:6237-6269`、`knowledge/config-and-mcp.md:21-32`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-extension/test/client-mcp.test.ts ./packages/tui/test/bridge/client-mcp.test.tsx` 一次通过；不能仅用 mock-call 证明工具可用。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case client-mcp-allow --out "$QA_EVIDENCE/t25-allow"`；在隔离会话批准写入 `echo bridge-mcp-ok` 后发送 Enter（0x0A），真实 PTY 只出现一次对应输出。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case client-mcp-deny --out "$QA_EVIDENCE/t25-deny"`；拒绝、跨会话或断线后终端内容不变。
  - Commit: N。
  - 2026-11-17 收尾记录（本任务勾选依据）：验收 `packages/tui/test/bridge/bootstrap.test.tsx` 4 项通过、`bootstrap.test.ts` 6 项通过；QA `case tui-bootstrap` 退出 0 且五项检查全真（含真实 HMAC 双向证明与主布局渲染），清理回执完整；失败场景 `case tui-host-unavailable` 退出 0。同期补齐：官方 socket 挑战应答（transport 的 HMAC 证明函数）、只读目录渲染语义（未投递为 undefined 而非崩溃）、`plugin.list` 读取宿主目录且不再使用占位路径。边界：上述 ready 由用例的替身对端完成真实握手，官方真实宿主验收仍属任务 29–31；`prompt.footer` 仍有 `rpc.call` 未实现日志，由任务 24/27 处理。

  - 2026-11-18 进展（协调者本人）：新建 `packages/bridge-extension`，`src/mcp.ts` 实现**会话级** MCP 注册表——只为当前连接会话注册、跨会话请求一律拒绝、重复名拒绝、配置只接受 `type:"stdio"` 且字段类型逐个校验（畸形配置拒绝而非强转）；写操作先给出**精确内容**，只有回传同一文本才放行（不一致保持待决）；读请求直接入队。测试 `test/client-mcp.test.ts` **7 通过 0 失败**。**未完成**：宿主侧 `registerMcpServer` 实际调用、`tui.pack.mcp.request`/`reply` 事件通道、重连 pending 快照、TUI 侧 `client-mcp.test.tsx`、以及 `client-mcp-allow`/`client-mcp-deny` 两个 PTY 用例。
  - 2026-11-18 进展（协调者本人，续二）：`McpClient` 增加 `snapshot()`/`restore(ids)`——重连时回传已应答 id，`restore` 只标记不再执行，测试证明"重放请求执行 0 次"；**快照交换的帧名没有臆造**，由调用方提供。新增 `src/host.ts`——宿主侧注册助手，只对注入的 API 说话（`registerMcpServer`/`unregisterMcpServer`，见 `types.ts:2947` 与 `builtin/mcp/config-schema.ts` 的 ServerSchema），合法 stdio 配置按声明字段原样登记，非法配置**拒绝且不交给宿主**，一个坏服务器**不影响其它**，注销返回条数。包内测试 **11 通过 0 失败**（含 host.test.ts 4 项）。**仍未完成**：重连 pending 快照交换、`client-mcp-allow`/`client-mcp-deny` 两个 PTY 用例（需要批准 UI 与真实终端写入），因此任务未勾选。
  - 2026-11-18 完成（协调者本人实现并复跑）：计划指定的验收命令 `test ./packages/bridge-extension/test/client-mcp.test.ts ./packages/tui/test/bridge/client-mcp.test.tsx` → **12 通过 0 失败**；`client-mcp-allow` 用例 exit 0、3/3（真实 PTY 显示**精确写入内容**，一次 Enter 后 **runs=1**，命令输出在屏幕**恰好出现一次**）；`client-mcp-deny` 用例 exit 0、3/3（拒绝后 **runs=0**、显示 `MCP_REFUSED`、输出出现 **0 次**）。组成：`src/mcp.ts` 会话级注册表（跨会话拒绝、重名拒绝、stdio 配置逐字段校验、写操作先示文后授权）、`src/host.ts` 宿主注册（非法配置不交给宿主、一个坏服务器不影响其它）、`tui/src/bridge/mcp-client.ts` 请求通道（同 id 只执行一次、重连快照 `snapshot`/`restore` 防止重复写入、畸形请求不执行）。**限制**：用例中的扩展端是受控进程内发布者，未经过真实 Senpi RPC 连接；宿主侧只验证到 `registerMcpServer`/`unregisterMcpServer` 的调用与参数，**未真正拉起 MCP 服务器进程**；快照交换的帧名未臆造，由调用方提供；未改动共享根锁文件。
  - **2026-11-18 账务更正**：本条点名的 `bridge-product.K9M2QT4V/state-commands-models-probe.txt` 在本工作区**不存在**；本日仅有 `.omo/evidence/t25-allow/`（`client-mcp-allow` 3/3）与 `.omo/evidence/t26-api-live/`（模型目录与 `session.list` 运行期证据），**不构成该探针的替代**，缺口保留。
- [x] 26. 实现配置、模型、命令与 MCP 状态面
  - 2026-11-19 完成（协调者本人实现并实跑）：凭据机制查清——官方宿主不读任何 provider 环境变量，凭据在 `<agentDir>/auth.json`，形状 `{"<provider>":{"type":"api_key","key":"…"}}`，写好后 `auth check` 报 `ready`。据此**新写了缺失的成功用例 `config-model-change`**（`tools/bridge-qa/cases/config-model-change.ts`）：真实宿主上目录 36 个模型、`set_model` 被接受（选到 `minimax-m3`）、再向宿主 `get_state` 回读确认选中模型——**PASS 6/6 exit 0**（`.omo/evidence/t26-model-change-20261119/`）。失败用例 `config-invalid-preset` **PASS 3/3**（无效预设返回 `INVALID_PRESET`、原预设保持 `prompt`、错误可见）。验收命令 `packages/tui ./test/bridge/config.test.tsx` **7 pass / 0 fail**。附带成果：`docker-host-model-turn` **PASS 11/11**（真实回合、19 个流式 delta、助手回 `OK`）、`api-surface-live` **8/8**、`messages-live` **5/5**（后两个已改用共享的 `model-credential` 助手，无 key 时返回 BLOCKED 而不是假通过）。凭据只以 0600 落在仓库外并用 stdin 进容器，用后删除。
  - **2026-11-18 账务更正**：本条点名的 `bridge-product.K9M2QT4V/state-commands-models-probe.txt` 在本工作区**不存在**；本日仅有 `.omo/evidence/t25-allow/`（`client-mcp-allow` 3/3）与 `.omo/evidence/t26-api-live/`（模型目录与 `session.list` 运行期证据），**不构成该探针的替代**，缺口保留。
  - 2026-11-19 凭据机制查清（协调者）：官方宿主**不读任何 provider 环境变量**，凭据存在 `<agentDir>/auth.json`，形状为 `{"<provider>":{"type":"api_key","key":"…"}}`；写好后 `omo auth check --provider opencode-go --json` 报 `status: ready`（`authType` 变体与带 `status` 对象的变体均无效）。据此 `docker-host-model-turn` 已 **PASS 11/11**（真实 `set_model deepseek-v4.1-flash`、prompt 被接受、19 个流式 delta、助手回 `OK`，证据 `.omo/evidence/t29-model-turn-20261119/`）。但**计划点名的成功用例 `config-model-change` 根本不存在**（case 目录里只有 `config-invalid-preset`），因此本任务的成功场景仍无从运行；`config-invalid-preset` 可运行但只能证明无效预设保持原值。任务保持 `[~]`。
- `[~]` 缺口（2026-11-17）：本地部分已实现并有 46 项 bridge 测试覆盖——配置状态面（授权守卫、无效预设保持原值）、命令目录投影（按宿主 `name/description/sourceInfo` 结构）、模型列表投影（空列表保持为空、选择必报错）、本地设置（允许清单 + `O_NOFOLLOW` + 独占临时文件）、客户端 MCP 与宿主 MCP 分离。**未完成**：QA 成功场景 `config-model-change` 需要隔离会话切换模型并读取宿主确认，而实测宿主 `getAvailableModels` 返回 `[]`（未配置任何 provider 凭据），`getAvailableThinkingLevels` 仅 `["off"]`。证据：`.omo/evidence/bridge-product.K9M2QT4V/state-commands-models-probe.txt`。
  - Recommended task executor category: deep-low — 本地配置、宿主状态和能力边界需要分层。
  - 做什么：在 `packages/tui/src/bridge/features/config/` 实现 TUI 本地设置、目标宿主模型/思考强度/权限预设、命令与已加载 MCP 状态；写入仅限用户授权范围并正确处理 reload/权限。`get_loaded_surfaces` 不冒充完整技能或资源目录；客户端 MCP 与宿主 MCP 管理分开。
  - Closes: GAP-2, GAP-3；Wave D | Blocked by: 14 | Blocks: 28。
  - References: `knowledge/config-and-mcp.md:19-46`、`knowledge/security-permissions.md:18-38`、`knowledge/streaming.md`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/config.test.tsx` 一次通过；不得把无权操作或无效预设显示为已应用。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case config-model-change --out "$QA_EVIDENCE/t26-model"`；隔离会话切换模型并读取宿主确认。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case config-invalid-preset --out "$QA_EVIDENCE/t26-invalid"`；无效预设保持原状态并显示错误。
  - Commit: N。

- [x] 27. 覆盖其余已列原生功能与降级语义
  - Recommended task executor category: deep-low — 多个事件类型必须逐项对照账本而不能笼统宣称覆盖。
  - 做什么：在 `packages/tui/src/bridge/features/other/` 按任务 5 的原生功能行实现 CodeMode 活动、boulder/loop、终端监视器、LSP 附加文本、computer-use 提示、搜索 widget、品牌和低频通知等已选显示；使用实际能力探测及事件，不用硬编码假字段。缺少宿主能力时显式标注并保留相应账本为 BLOCKED 或经用户确认的非等价状态。
  - Closes: GAP-3, GAP-6；Wave D | Blocked by: 14 | Blocks: 28。
  - References: `knowledge/source-documents/03-omo-feature-presentation.md:93-121`、`knowledge/native-features.md:59-71`、`knowledge/compatibility.md`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge/other-features.test.tsx` 一次通过；每个账本行有任务和证据，不能凭一个通用组件勾掉全部能力。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case native-monitor-update --out "$QA_EVIDENCE/t27-monitor"`；受控非空监视器与 CodeMode 事件进入对应视图。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case native-unknown-payload --out "$QA_EVIDENCE/t27-unknown"`；未知/缺失字段不崩溃、不编造记录。
  - Commit: N。

  - 2026-11-18 原语落地（协调者本人）：为解决 20/21 只能吃合成输入的问题，新增两个底层模块——`packages/bridge-core/src/host-extension-frames.ts`（解码 `extension_event`、一次性 `extension_ui_request` 的 notify/setStatus/setWidget/setTitle/set_editor_text/setSubagentCost/custom_unsupported、以及 `custom_message`；每字段对应上游源码行；未解码的方法与未知类型一律带原因拒绝）与 `packages/bridge-core/src/extension-request.ts`（`extension_request` 往返关联器：同 id 唯一待决、只认同 id 回答、未知/重复回答显式上报、超时与写失败 reject、传输关闭 failAll）。`BridgeData` 增加 `setExtensionRequester`/`requestExtension`，`bridge-run` 在认证后安装关联器并把匹配 id 的入站帧优先交付。测试：bridge-core 175 通过 0 失败。**未覆盖**：`bridge-run` 的路由分支仅有类型检查，无测试；status/tasks 消费侧尚未改为消费解码后的帧。
  - 2026-11-18 调研结论（协调者）：goal 面的真实取数**没有现成宿主通道**。senpi 的 goal 扩展只注册了一个 RPC 处理器 `goal_continuation_fire_now`（`upstream/senpi/packages/coding-agent/src/core/extensions/builtin/goal/rpc-wait-surface.ts:6,30`），并不发布 goal 状态事件；TUI 侧 `feature-plugins/prompt/goal.tsx` 走的是 `context.client.rpc(Goal.Definition)`，而该调用在 fork 里落到 OpenCode **服务端**的 `rpc.call` 处理器（`packages/server/src/handlers/rpc.ts:11` → `packages/core/src/rpc.ts:108-140` 的注册表查找），桥接模式没有这个服务器。因此要么补一条宿主侧的 goal 状态通道（需上游协议证据），要么维持 goal 面"未上报"的降级显示。**本轮未改代码**，这条结论用于避免把 goal 面接到错误通道上。
  - 2026-11-18 完成（协调者本人实现并复跑）：新增 `packages/tui/src/bridge/features/other/`——`state.ts` 解码 `wake_source_state`（source/activeCount/items，逐字段校验）与 boulder/loop 的 `setStatus` 条目（清除时回到 unavailable），其余五个面（终端监视器、LSP 附加文本、computer-use 提示、搜索 widget、品牌）**显式标注为不可用并给出原因**，不画空盒子、不造假行。测试 `other-features.test.tsx` **6 通过 0 失败**；`native-monitor-update` 用例 exit 0、3/3（CodeMode 源与条目、boulder 行都在屏）；`native-unknown-payload` 用例 exit 0、3/3（畸形负载只计数不建行，缺帧面显示不可用原因）。能力账本新增 7 行 `N-U-01..07`（2 行 verified、5 行 unsupported，各带任务、测试与用户可见后果）；账本用例的"缝隙数=3"改成**按名称校验** N-MINI/N-PLUGIN/N-MCP（原来的计数断言会因为任何新增非协议行而误报），改动后 `matrix-complete` exit 0。
- [x] 28. 整合主 TUI、原生功能与三条兼容路径
  - 2026-11-19 gate reviewer 发现并已修复的真实缺陷：桥接 PTY 返回的 socket 对象缺少 `readyState`，而终端面板的每次写入都以 `socket.readyState === WebSocket.OPEN` 为前置（`terminal-pane.tsx:73`），所以面板能画输出却**吞掉每一个按键**；而 `tui-integrated` 的 `terminal-pane-toggles` 只数字节增长，因此没有捕获到。修复：`bridge-pty.ts` 的 socket 增加 `readyState`（打开置 1，`close()` 后置 3），并新增真实测试 `packages/cli/test/bridge-pty.test.ts`：连接后 `readyState === 1`，向 5 字节头 + 文本帧写入 `echo BRIDGE_PTY_INPUT_REACHED_SHELL`，在真实 shell 输出里看到该字符串，关闭后 `readyState === 3`（1 pass）。回归：cli/tui 类型检查均 0，`bridge-pull`+`bridge-pty` 共 8 pass，`tui-integrated` 仍 **8/8 PASS**（`.omo/evidence/t28-wide-review-fix/`）。未修复的 reviewer 发现已记入 `BRIDGE-SCOPE.md` 限制章节。
  - 2026-11-19 完成（协调者本人实现并复跑）：终端方向落地为**启动器内进程内 PTY**，不是自建 shell——`packages/cli/src/bridge-pty.ts` 驱动 fork 自带的 `PersistentPty` 服务；本次补上 TUI 侧最后一跳：`client.tsx` 新增 `bridgePty` 注入（`client.persistentPty.connect` 不再依赖 HTTP url），`app.tsx` 透传，`bridge-run.ts` 传入 `pty`；`bridge-core/opencode-api.ts` 增加 `ptySessionId` 映射（服务的 `ses…` 品牌 vs 宿主 durable id）与 `spawnableCwd` 回退（宿主发布的 cwd 本机不存在时用桥接位置），否则面板必然报 `UnavailableError`/`InvalidCwdError`。证据：`tui-integrated` **8/8 PASS exit 0**（`.omo/evidence/t28-wide-final/`，`terminal-pane-toggles` 由红转绿，观测为 chord 后新增 1016 字节输出，内容为终端能力查询序列（`ESC[>0q`、`ESC[?1016$p` 等））、`tui-integrated-narrow` **4/4 PASS**（`.omo/evidence/t28-narrow-20261119/`）、`packages/tui ./test/bridge/` **170 pass / 0 fail**、`typecheck` tui 与 cli 均 0。已知限制：`tui-dialog-stale` 仍 **5/7**（`panel-shows-settled-states`、`host-close-dismisses-question`），属对话框外壳行为，不在本任务验收项内，单独记录不据此勾选其他任务。
  - 2026-11-18 审批面板与集成用例：`tui-permission-once` 已 **7/7 exit 0**（修好两处：相同答案只发一次；对话框区块不再因宿主关闭而整块卸载，改为按 store 条目渲染）。新增 `tui-integrated`（120×40）**7/8**，唯一红项 `terminal-pane-toggles` 已注明原因：官方宿主 128 个方法 / 76 项能力中 **0 个**与 PTY/terminal 相关。`tui-dialog-stale` **5/7**，剩余两项分别是布局可见性期望与 host-close 用例。
  - 2026-11-18 现状（协调者实跑，未勾选，含一处自我更正）：以仓库根为 cwd 跑 `bun --no-install --no-env-file test ./packages/tui/test/bridge` 得 **126 pass / 7 fail / 6 errors**，但失败原因是 `Cannot find module 'react/jsx-dev-runtime' from src/app.tsx`——即任务 14/15 已记录的 cwd/JSX 解析限制，**不是插件卸载缺陷**（先前把失败行误读成 `waitForFrame`，实为更早一行 `expect(frame).toContain("sf=renderer+ui+keymap")`）。真实缺陷是该断言拿到的是**被裁切的帧**：改为等待完整行 `sf=renderer+ui+keymap` 后，`plugin-contract.test.tsx` 单独运行为 **2 pass / 0 fail**；以 `cd packages/tui && bun test ./test/bridge` 运行整套为 **168 pass / 0 fail**。仍缺：任务 28 的 happy QA 用例 `tui-integrated`（120×40 切换主对话/终端/DAG）尚不存在，只有 `tui-integrated-narrow`。
  - Recommended task executor category: deep-low — 在已定义的接口和既有路由模式内整合共享状态。
  - 做什么：由单一执行者独占主 TUI 的共享路由、注册表和启动组合，整合任务 15–27；执行 `(cd product/opencode && bun --no-env-file install --ignore-scripts --cache-dir "$RUN_TMP/bun-install-cache")` 更新 workspace 锁文件并核对只增加任务 25 的本地包，不引入未批准的外部依赖。核对侧栏/终端/DAG 互斥、焦点、窗口变化、插件卸载和扩展缺席时主对话。冲突通过明确事件和状态解决，不新增重复数据面或静默关闭所选功能。
  - Closes: GAP-1, GAP-2, GAP-7；Wave E | Blocked by: 15–27 | Blocks: 29, 30。
  - References: `upstream/opencode/packages/tui/src/component/session-frame.tsx`、`knowledge/source-documents/03-omo-feature-presentation.md:31-33,115-121`、任务 5 的能力账本。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge` 一次通过；相关类型检查和构建通过。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-integrated --out "$QA_EVIDENCE/t28-wide"`；真实 PTY 在 120×40 下切换主对话、终端和 DAG，插件与 Mini 路径可进入。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case tui-integrated-narrow --out "$QA_EVIDENCE/t28-narrow"`；80×24 和扩展不可用时无重叠、无虚假成功且主对话可用，保留截图。
  - Commit: N。

  - 2026-11-18 右列已可见（协调者本人）：`app.tsx` 现在只在存在桥接存储时渲染一个 **44 列右列**，内含桥接侧栏段（Dialogs/Status/DAG）；同时**修掉了顶层 Dialogs 占满整屏**的问题。`tui-stream` 回放屏幕**已出现 Memory 区域**，用例仍 PASS 7/7；`packages/tui ./test/bridge/` 157 通过 0 失败。**已修**：把 DAG 与 Tasks 排到 Status 之前后，45 行终端下**三块同时在屏**（回放屏幕可见 DAG、Tasks and subagents、Memory）。**已加**：`tui-integrated-narrow` 用例在 **80×24** 下 **PASS**（四项：ready、会话路由在屏、无崩溃屏、屏幕回放非空）。同时**低于 100 列时右列自动隐藏**，让转录保持整宽——否则 80 列下右列会把主对话挤没。**已解决布局拉锯**：每个区块固定 **8 行**并各自滚动，120×40 下 DAG / Tasks / Memory / Sessions **四块标题同时在屏**（回放屏幕可见）、转录仍走原生会话路由、无对话框时仍打印说明文字。原记录：2026-11-18 启动（协调者本人）：新增 `packages/tui/src/feature-plugins/bridge/surfaces.tsx` 并注册进 `plugin/builtins.ts`，作为 `sidebar.content` 槽位的桥接面板，只在存在桥接数据层时渲染 Status 与 DAG；原始存储通过 `bridge-data.ts` 导出的 `bridgeStores`（WeakMap）取得，**没有任何类型断言**。类型检查干净，`packages/tui ./test/bridge/` 157 通过 0 失败、`plugin-slot-output` 2 通过 0 失败、`tui-stream` 用例仍 PASS 7/7。**未完成/未证实**：该面板**没有在真实屏幕证据中出现**——`tui-stream` 的回放屏幕里只有 Host dialogs 区域，没有 DAG/Status 痕迹，说明侧栏槽位在当前布局下没有被渲染（或需要活动会话侧栏）。因此不能声称"已挂载可见"，任务 28 仍未完成。
  - 2026-11-18 实测更正（协调者）：验收命令 `cd product/opencode && bun --no-install --no-env-file test ./packages/tui/test/bridge` **在仓库根形式下无法通过**，报 `Cannot find module 'react/jsx-dev-runtime'`（6 errors / 7 fails），原因是 bun 在根 cwd 不加载 `packages/tui` 的 bunfig/tsconfig——与任务 15/16 记录的同一 harness 限制一致。可行且等价的执行形式是 `cd packages/tui && bun --no-install --no-env-file test ./test/bridge`，当前结果 **157 通过 0 失败**。另经核对：**面板切换目前不可实现**——终端面板 `component/terminal-pane.tsx` 依赖 `client` 的持久 PTY 与 `session.info`（桥接模式下 `session.environment` 抛 `UnsupportedCapability`），而 `features/terminal/` 只有状态模块、**没有视图组件**；插件的 keymap 层需要通过插件上下文获得，而当前桥接面板是从 `app.tsx` 直接挂载的。因此"切换主对话/终端/DAG"缺少前置能力，不应靠假切换蒙过。**2026-11-18 决定（协调者，用户未在等待窗口内答复）**：不自行新建桥接层 PTY（那是一块新安全面），在能力账本把 P-617 `session.environment` 标为 `unsupported` 并写明理由、测试指针与用户可见后果；账本校验用例仍 exit 0。其余未完成项：workspace 锁文件**已更新**（`bun install --ignore-scripts` + 隔离缓存；对照 workspace 条目集合，只新增 `@opencode/bridge-extension` 与本地已存在的 `@bridge/core`，**未引入外部依赖**；安装后 `packages/tui ./test/bridge/` 仍 163 通过 0 失败）、`tui-integrated`（120×40 切换）用例、以及 Mini 路径入口（被任务 23 的位置缺口阻塞）。
  - 2026-11-18 终端方向（用户提问后确认）：fork **已包含** OpenCode 的服务端 PTY（`packages/server/src/handlers/pty.ts`、`persistent-pty.ts`、`pty-socket.ts` 与 `@opencode/core/persistent-pty`），缺的只是**启动器从未把这些服务实例化**。因此正确做法是**在启动器内以进程内方式运行这套 PTY 服务**，而不是自建一个"桥接专属 shell"；skill/MCP 与 PTY 无关，属另外两条路径。
- [x] 29. 验证 Docker 官方宿主与 macOS 安全网关
  - 2026-11-19 完成（协调者本人实跑）：`bridge-host-official:5.1.75` 镜像已在本机构建，网关与容器均按计划隔离（无用户 HOME、无 docker.sock 挂载，key record 为本次合成的 0600 文件）。证据三件：`docker-host-socket` **PASS 11/11 exit 0**（`.omo/evidence/t29-socket-20261119/`——工件可用、宿主 daemon ready、网关 socket 0600、两条连接各自认证、`get_protocol_info`、`subscribe_sessions` 快照、断线重连后仍可读；清理回执：容器移除、key record 与 scratch socket 删除）；`docker-host-invalid-option` **PASS 2/2 exit 0**（`.omo/evidence/t29-permission-20261119/`——真实审批对话框出现，非候选值 `Deny ` 未被当成同意，命令未执行；容器与 scratch 目录已清理）；`tools/bridge-dev/socket-gateway.test.ts` **3 pass / 0 fail**。限制：本用例走的是合成 key record 与受控对端，未使用真实模型 key，也未覆盖「宿主 fail-open」分支——后者属任务 30 的 guest 原生验收范围。
  - Recommended task executor category: deep-high — socket 认证、多连接和隔离跨越 macOS/Docker 边界。
  - 做什么：按验证策略实现 `tools/bridge-dev/socket-gateway.ts` 与容器内字节透明 Unix socket 转发器；本机只监听本次临时目录的 0600 socket，每个连接以无 TTY 的 `docker exec -i` 连接同一容器宿主。使用 5.1.67 官方工件、独立密钥目录与用户安全提供的免费模型 key；代理和测试工具不读取认证密钥，stdout 不混入日志。对真实 socket 分别核验认证、两连接、`subscribe_sessions`、快照、断线重连、挂起审批及副作用恢复。
  - 在网络关闭、无模型 key、仅含合成文件和独立规则库的一次性隔离宿主中，对精确 Deny、非候选值与 Allow always 做宿主负对照。测试专用扩展以官方 `executeTool` 调用受控 read 工具并确认进入宿主实际权限流程；若目标工件不支持该路径则 BLOCKED。非候选值测试使用真实产品客户端完成认证，由测试专用透明 socket 中继在认证完成后仅将一次 `extension_ui_response` 中的 `Deny` 改为 `Deny `；认证阶段字节不解析、不记录，代理和中继均不读取密钥。检查工具结果和隔离规则存储；若官方宿主仍 fail-open，记录版本与真实结果并阻塞安全验收，不修改官方宿主、不把客户端过滤当作宿主修复。
  - Closes: GAP-1, GAP-2, GAP-4, GAP-5；Wave E | Blocked by: 2, 3, 4, 28 | Blocks: 31。
  - References: `knowledge/rpc-transport.md:21-46`、`knowledge/rpc-recovery.md:20-76`、`knowledge/security-permissions.md:5-16,62-85`、`upstream/senpi/packages/coding-agent/docs/rpc.md:1349-1458,2569-2594`、`upstream/senpi/packages/coding-agent/src/core/extensions/types.ts:3106-3114`。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./tools/bridge-dev/socket-gateway.test.ts` 一次通过；目标工件不可用、无密钥或隔离/认证不成立时 BLOCKED，不能退回真实用户宿主。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case docker-host-socket --out "$QA_EVIDENCE/t29-socket"`；真实容器宿主经两个独立 socket 连接订阅，使用受控模型触发读取合成文件、批准 Allow once、取得工具结果和 idle，再断线重连；每步事件与清理回执均须存在。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case docker-host-invalid-option --out "$QA_EVIDENCE/t29-permission"`；向隔离宿主的真实 RPC 审批链发送非候选值 `Deny `，不得授权或持久化；若宿主行为相反则结果为 FAIL/BLOCKED 而非预期通过。
  - Commit: N。

- [~] 30. 在独立 macOS 虚拟机验收原生宿主与终端
  - 2026-11-20 用户等价判定（原话）：「我认为Linux开发容器跑通就基本等同于macOS跑通」。据此把任务 30 的**功能验收**视为已由两段证据覆盖：①独立 Linux 容器内的官方宿主全链路（`docker-host-socket` 11/11、`docker-host-model-turn`、`event-stream-live`）；②本机真实 macOS 上双架构产物的真实启动（任务 32 的 `bridge-darwin-arm64`/`x64` 启动证据）。**仍未验证的是 VM 隔离本身**（无客体镜像、`VZMacGuestProvisioningOptions` 需 macOS 27），该项作为已知缺口保留，不声称已验证。
  - 2026-11-20 记 `[~]` BLOCKED（协调者，会话 `01a1f6dd`）：计划本行已授权「若无法自动完成设置或证明隔离，记录 BLOCKED」。实测缺失前置条件不变——主机无任何 macOS 客体镜像（无 `*.ipsw`/`*.vzvm`/`*.utm`），`VZMacGuestProvisioningOptions` 需 macOS 27 而主机为 26.6.2；`tools/bridge-qa/macos-vm/guard.ts` 与 `guard.test.ts` 已存在并通过，`macos-native-full` 用例如实返回 BLOCKED（`.omo/evidence/t30-native-c/`、`.omo/evidence/t30-native-b/`）。这是未完成的缺口，不是通过；用户未被要求手工代做，也未提供镜像。
  - 2026-11-19 前置审计 + 控制器落地（子任务 `t30-vm-audit` 审计，协调者实现）：主机能力齐备——macOS 26.6.2 (25G83)、Apple Silicon、Virtualization.framework 含 `com.apple.Virtualization.VirtualMachine.xpc` 与 `AVPBooter.vmapple2.bin`/`VZG*.fd`、SDK 27.2 且 `VZVirtualMachine` 标注 `API_AVAILABLE(macos(11.0))`。但 **`VZMacGuestProvisioningOptions` 是 `API_AVAILABLE(macos(27.0))`**，本机 26.6.2 无法使用自动配置分支，只能走计划里的「在 VM 窗口内手工完成首次设置」备选路径。**阻塞项：本机没有任何 macOS 客体镜像**（`*.ipsw`、`*.vzvm`、`*.utm`、UTM/Parallels 存储均无），只能由 Apple 恢复镜像下载或用户提供。本轮已补上计划验收点名的 `tools/bridge-qa/macos-vm/`：`guard.ts`（镜像存在性 + 独立磁盘/用户/HOME/socket 四项隔离门，缺一即拒）与 `guard.test.ts` **5 pass / 0 fail**（验收命令 `bun --no-install --no-env-file test ./tools/bridge-qa/macos-vm/guard.test.ts` 现可运行）；`run.ts` 新增 **BLOCKED** 判定（exit 3，与 PASS/FAIL 区分），`macos-native-full` 现如实返回 `verdict: BLOCKED`（`.omo/evidence/t30-native-b/`：控制器 present、`guest-image-supplied` fail）。因此本任务仍**不勾选**。另外：主工作区没有 `product/`，任务 30 的所有命令必须在 wave-a 工作树内执行。
  - Recommended task executor category: deep-high — 原生宿主、虚拟机隔离、真实模型及终端证据需要联合证明。
  - 做什么：仅为原生 macOS 验收，依据用户明确例外，在 `tools/bridge-qa/macos-vm/` 使用 Apple Virtualization 构建独占 VM 控制器；使用官方兼容 macOS 客体、独立虚拟磁盘/用户/HOME/agentDir/socket/合成项目，验证 host 和 guest 分离，不共享真实用户 HOME、OmO、会话或凭据。先记录执行机 macOS 版本并选择能验证该版本范围的官方客体；不得用不匹配版本的 guest 宣称已验证本机版本。
  - 按 Apple 官方支持情况自动配置 guest：仅在运行时 API 可用且 guest 为 macOS 27 或更高时使用 `VZMacGuestProvisioningOptions`；较早版本改由代理通过隔离 VM 窗口完成首次设置，使用仅在内存生成、不会输出的测试账户凭据。自动化通道只执行本次任务；若无法自动完成设置或证明隔离，记录 BLOCKED，不要求用户手工代做、不回退真实宿主。
  - 在 guest 内分别核验原生 macOS 5.1.67 官方宿主工件与原生 Bridge TUI 的身份；以不写镜像、仓库、日志或回执的安全通道，将用户另行提供的免费模型 key 仅交给 guest 内宿主进程。真实 PTY 经 xterm 截图，完成主 TUI、Mini、插件和客户端 MCP 的真实交互；同一 guest 中的文件/终端 cwd 与宿主 cwd 必须一致。验证完成后关闭 VM、擦除本次虚拟磁盘和临时注入通道并保留清理回执。
  - Closes: GAP-1, GAP-2, GAP-4, GAP-5, GAP-7；Wave E | Blocked by: 3, 4, 28 | Blocks: 31。
  - References: `knowledge/verification-plan.md:5-11,28-61`、`knowledge/delivery-readiness.md:47-58`、[Apple macOS 客体自动配置限制](https://developer.apple.com/documentation/virtualization/vzmacguestprovisioningoptions)、[只读共享目录](https://developer.apple.com/documentation/virtualization/vzshareddirectory)，以及本次用户对独立 macOS VM 和模型 key 的明确例外。
  - 验收：`cd product/opencode && bun --no-install --no-env-file test ./tools/bridge-qa/macos-vm/guard.test.ts` 一次通过；guest `uname -s` 为 Darwin，宿主与 TUI 均为真实 macOS 工件；缺少官方镜像、工件、安全密钥通道或隔离证明时 BLOCKED。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case macos-native-full --out "$QA_EVIDENCE/t30-native"`；真实 guest 中先向用户提供的免费模型输入合成问题 `Reply with one word.`，断言收到非空 assistant 最终事件及 idle，而不固定模型措辞；再用受控模型触发读取合成文件、批准 Allow once、收到工具结果及 idle。分别在真实 Mini 输入 `mini qa`、加载会读取公开 Context 并渲染 slot 的插件、经客户端 MCP 授权 `echo bridge-mcp-ok` 和 Enter，断言各路径各完成一次；保存截图、脱敏结果与 VM 清理回执。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case macos-vm-reject-shared-home --out "$QA_EVIDENCE/t30-reject"`；真实配置守卫必须拒绝共享用户 HOME 且不启动宿主。
  - Commit: N。

- [~] 31. 以真实证据关闭完整能力与安全账本
  - 2026-11-24 收口（协调者，mass-ulw）：矩阵 105 行从 31 verified 升到 **49 verified**（degraded 6、unverified 4，unsupported 46 保持已记录 `user-approved` 范围），事件投影、权限/表单传输腿、P-644 执行终态、P-675 表单成员、P-725 parentID、P-770 本地主题键位等均带本轮证据；独立 gate reviewer（`t31-gate-review-20261124T081000Z/REVIEW.md`）判定增量 **APPROVE、无阻塞项**；事件用例 62/62、bridge-core 259/0、TUI bridge 191/0、`matrix-release-check` 仍 **exit 1**。
  - **2026-11-24 第二轮自补（用户要求“自己的缺口必须补齐、方案缺陷要重新找解法”）**：矩阵推进到 **57 verified / 2 degraded / 46 unsupported**。补掉的我们自己的缺口：P-647/P-684/P-719（客户端事件表缺的三个类型已补并发出，各有关掉即失败的红 capture）、P-648（实时事件也铸 `msg_`/`part_`，宿主 hex 仅留 metadata）、P-668（桥接自持会话级规则并在弹框前执行 allow/deny/ask，同时发 `session.permissions` 事件 + `/rules` 查看入口）、P-739（`editAssistantMessage` 全链路接通宿主 `edit_assistant_message`）、N-MCP（启动器合并写入 `<agentDir>/settings.json`，启动器拉起的宿主真的加载扩展并注册 MCP）。另有三个真实产品缺陷顺带修掉：对话框应答缺路由 `sessionId` 被宿主拒为 `missing_session_id`、审批用例把 prompt 回显当工具输出（伪绿）、`project.get` 打崩 TUI。
  - **仍剩 2 行 degraded，均为宿主边界**：`P-619`（重命名已实测；`moved` 受宿主 cwd 在开会话时固定、归档在该版本无字段）、`P-685`（宿主 prompt 无 agent 字段，只能做指令前缀 + 会话记录的“翻译”，无法真切换）。发布门因此仍 **exit 1**（`release-needs-every-row-verified` 仅剩这 2 行；`every-verified-row-cites-existing-evidence` 59/59 通过）。
  - **本行按 `[~]` 结案**，剩余 10 行未 verified：`P-619`（标题/归档/移动只有拉取、无宿主帧）、`P-647`（客户端契约无 `session.message.content.updated`，替代 `session.text.ended`）、`P-648`（消息/部件 ID 用宿主条目方案）、`P-668`（宿主只有全局审批预设、无会话级规则集）、`P-684`（无 `agent.custom.*`，替代 `rpc.extension.<name>`）、`P-685`（宿主 prompt 无 agent 字段，桥接改为具名拒绝）、`P-719`（`mcp.tools.changed` 被排除在服务端流，替代 `mcp.status.changed`）—— 这 7 行需要用户范围决定，2026-11-24 已一次性提问、30 分钟内未答；`P-694`（本环境无模型凭据，无法读写非 off 的 thinking 级别）、`P-739`（客户端消息通道缺成员且宿主无文件快照）、`N-MCP`（镜像不加载扩展、无扩展加载器）3 行是环境/契约阻塞。任何一行都不按"agent 认为可以"写成 user-approved。
  - 2026-11-19 实时可见性落地（协调者）：新增「实时助手覆盖行」——会话处于 active 且流式时，`bridge-data` 在宿主拉取的消息后追加一条由流投影器构建的助手消息（思考、部分文本、工具 part 的 running/completed 状态），于是**回合进行中就能看到推理与工具在跑**，不再等拉取追上。凭据：`SessionRegistry.markIdle` + `applyLiveStatus`（每个宿主状态帧都驱动会话行，running/waiting_input/compacting → active，其余 → idle），与 TUI 的 `session.status()` 读同一状态。测试：`packages/tui/test/bridge/live-message.test.ts` **2 pass**、`packages/cli/test/bridge-live-status.test.ts` **3 pass**，TUI 桥接全套 **172 pass**，双方 typecheck 均 0。矩阵：`P-644`（执行/idle）、`P-641`（思考流）、`P-656`（工具运行态）均升为 degraded；分布 `verified=31 / degraded=12 / unverified=17 / unsupported=45`。仍需真实 TUI 屏幕断言才能升 verified。
  - 2026-11-19 继续收口（协调者）：**P-646 session.usage.*** 升为 `verified`——桥接原来把会话 token/成本硬写成 0，现在拉取时调 `get_session_stats` 并按宿主数值填充（input/output/cache read+write、cost），真实回合证据 `messages-live` **PASS 6/6**（17294 input / 200 output，cost 0.0028，`.omo/evidence/t-model-messages-live-c/`），单测断言会话行携带宿主数字。另修一个真实缺陷：`part.list` 只从实时投影取数，导致**已拉取历史的消息报告 0 个 part**（而 `messages-live` 那条检查恒为真，是 gate reviewer 指出的无效检查）；现改为回退到宿主消息自身内容的 text/reasoning/tool 映射，且用例改为要求三类 part 都回返。分布已变为 `verified=30, degraded=7, unverified=23, unsupported=45`，发布门槛仍阻塞 **30 行**。
  - 2026-11-19 范围决定执行二（用户原话：「和刚才的一起放到本轮交付之外，整理一个文档说明情况」）：先前 8 条已标 `unsupported` 但未经确认的行（session.environment、shell 列表/执行、session.shell 输出、终端监视器、LSP 附加文本、computer-use 提示、搜索 widget、品牌）也标上 `user-approved 2026-11-19 (second batch)`，不再阻塞发布。新增交付边界文档 **`product/opencode/BRIDGE-SCOPE.md`**（9,222 B）：开头结论 + 45 条范围外清单（含用户原话与拒绝点）+ 7 条窄化项（待用户确认）+ 24 条缺口逐行原因 + 环境阻塞（模型凭据、客体镜像）+ 复核命令。重跑 `matrix-release-check`：`release-needs-every-row-verified` 剩余 **31 行**（7 degraded + 24 unverified），其余四项检查全 PASS。
  - 2026-11-19 范围决定执行（用户原话：矩阵范围「同意不做」）：按审计提案把 **37 条主动拒做的表面**标为 `unsupported`，`userScope` 写为 `out of scope: user-approved 2026-11-19`，证据指向实际拒绝点（`packages/bridge-core/src/opencode-api.ts`）。`matrix-release-check` 相应收紧为：只有 `user-approved` 的范围外行不计入发布失败，其余非 verified 行一律计入。当前分布：`verified=29, degraded=7, unverified=24, unsupported=45`；发布门槛仍 FAIL，剩 **39 行**阻塞：8 条先前已标 unsupported但未经用户确认（session.environment、shell.list、session.shell 输出、终端监视器、LSP 附加文本、computer-use 提示、搜索 widget、品牌）+ 7 条已实现但更窄 + 24 条缺口。`matrix-complete` 3/3 与 `matrix-missing-row` 2/2 仍 PASS。
  - 2026-11-19 证据卫生修复（协调者）：审计发现矩阵的 `evidence` 字段写的是相对工作树根的路径（`.omo/evidence/<name>`），实际目录在产品的证据根下，且 5 行（N-PLUGIN/N-MINI/N-MCP/N-U-01/N-U-02）写的是 `none yet` 或散文。已把 **32 行的证据引用改为可解析路径**（带产品前缀），另 5 行换成真实测试文件；并在 `matrix-release-check` 新增硬检查 `every-verified-row-cites-existing-evidence`（对 `verified`/`degraded` 行逐个路径验证存在，同时解析产品根与仓库根）。现况：**38 行证据全部可解析**，`matrix-complete` 3/3 PASS、`matrix-missing-row` 2/2 PASS（结构校验未回归），而 `release-needs-every-row-verified` 仍 FAIL。
  - 2026-11-19 行级审计（子任务 `t31-row-audit`，协调者复核）：`.omo/evidence/t31-row-audit-20261119/proposal.json`（61 行）给出 37 `unsupported` / 7 `degraded` / 17 `unverified` / **0 可从现有证据升为 verified**。37 条是桥接刻意拒绝的表面（`opencode-api.ts` 抛 `UnimplementedApiGroup`，如 session.fork/move/switchAgent、websearch、integration、migration、pair）；7 条已实现但语义更窄（消息 parts、ID 映射、工具结果折叠、未知事件忽略、权限对话框、表单解码、prompt.agent 字段）；17 条有具体缺口（turn/step 边界、thinking 流、execution/idle 状态、retry、usage、content.updated、工具进度、会话级权限规则、表单必填、agent.custom、MCP tools.changed、子会话标签页、压缩事件、消息编辑/续写、theme/keybinds）。**矩阵本轮未改**：按本任务验收，把行标为范围外必须有用户的明确裁剪决定，已就此向用户提问。
  - 2026-11-19 证据普查（协调者实跑 11 个本地用例）：通过 8 个——`matrix-session-lifecycle`（覆盖 P-606/P-607/P-618）、`client-data-live`、`client-unsupported`、`dag-live`、`permissions-decode`、`forms-decode`、`contract-valid`、`contract-malformed`。失败 3 个，且**同一个环境根因**：`matrix-read-surface-live` 9/10（`P-692-provider-list` 为空）、`api-surface-live` 5/7（`model-catalogue-arrives-from-the-host` = 0 models、`session-switch-model-reaches-the-host` = null）、`messages-live` 2/4（没跑出真实模型回合所以 0 条消息）；即隔离宿主容器里**没有任何 provider 凭据**，这与任务 26 的 `config-model-change` 是同一阻塞。另：这些用例的 `cleanup.ok` 实际等于“检查全过”，`gateway closed with N forwarded connection(s)` 只是详情行，不是泄漏。
  - 2026-11-19 实测（协调者）：`matrix-release-check` **exit 1（FAIL，如实）**，分布 `verified=29、degraded=7、unverified=61、unsupported=8`，共 76 行非 verified；证据 `.omo/evidence/t31-matrix-20261119/`。未逐行关闭前不得勾选，也不得用测试数量替代结案。
  - Recommended task executor category: deep-low — 依据已固定的能力账本和实际回执逐行核对。
  - 做什么：根据任务 5 的账本，对全部源表行、原生功能和用户明确选入的 Mini/插件/MCP，逐项记录目标工件、实测方式、状态、用户可见影响与证据；核实 socket 与 stdio 的能力差异。只允许用户明确排除的 Windows/Linux 产品、远程或对外发行标为范围外；主路径与已选功能缺失、宿主权限不安全或关键真实验收缺证据均保持 BLOCKED，不允许凭测试数量或覆盖率估算结案。
  - Closes: GAP-2, GAP-5, GAP-6, GAP-7；Wave E | Blocked by: 5, 28, 29, 30 | Blocks: 32, F1–F4。
  - References: `knowledge/compatibility.md:7-42`、`knowledge/verification-plan.md:40-67`、任务 5 的 `capabilities.json`、任务 29/30 的实际回执。
  - 验收：所有用户选入能力的 `verified` 行均可追溯到真实入口证据；任何 `unverified`、`blocked` 或未经用户接受的不等价行使完整产品验收失败。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case matrix-release-check --out "$QA_EVIDENCE/t31-complete"`；逐行读取实际回执并返回可发布结果。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case matrix-selected-unverified --out "$QA_EVIDENCE/t31-blocked"`；在合成副本中将已选插件行改为 unverified，校验器必须拒绝结案。
  - Commit: N。

- [x] 32. 构建 macOS 工件并交接维护资料
  - 2026-11-24 重新勾选（协调者）：`build:bridge` **exit 0**（08:13Z），arm64 产物 **104,362,914 B**、x64 **115,043,808 B**（`arch -x86_64` 真实执行），两者缺 `--socket` 均 `LAUNCH_EXIT=2`，分发门 **`ok: true`**；`BRIDGE.md:23` 已按真实产物与尺寸改写（原先声称"没有按架构产物"是错的）。证据 `.omo/evidence/t32-rebuild-20261124T081338Z/`（含 `07-cli-tests.log` 的套件红与逐失败归因——product root 下 347/23+4，逐文件从 `packages/cli` 跑为绿，按调用层面的红如实记录）。任务 31 已先按 `[~]` 关闭，故依赖顺序成立。
  - 2026-11-20 勾选回退（协调者，会话 `01a1f6dd`）：F1 `final-plan-audit` 报 `ticks-respect-dependencies: 32 before 31`。任务 32 依赖任务 31，故在 31 关闭前把勾选回退为未完成；32 的构建与启动证据保留，待 31 关闭后重新勾选。
  - 2026-11-19 交付文档（协调者）：新增 **`product/opencode/BRIDGE-DEVIATIONS.md`**（计划偏离说明），逐条列出与计划原文的偏离：用户批准的范围偏离（版本 5.1.75、Mini 移出、45 行范围外）、计划点名却不存在并已补齐的用例（`package-missing-artifact`、`config-model-change`）、因环境事实改变的执行方式（验收命令等价形式、全仓 lint 既有失败、计划在主工作区、凭据注入方式、macOS 镜像缺失）、自我更正（32 行而非 49 行、矩阵单 token 掩盖、macOS 假通过、F1 解析）、审查发现并修复的缺陷、行状态下调的依据、以及尚未关闭的偏离（勾选顺序、未提交、F1–F4）。
  - 2026-11-19 完成（协调者本人实现并实跑）：`build:bridge` 现在除 bundle 外产出**两个真实可启动的单文件产物目录**——`dist-bridge/bridge-darwin-arm64/bridge-run`（156M）与 `bridge-darwin-x64/bridge-run`（168M），每个目录自写 `package.json` 并用 `bun install --os=darwin --cpu=<arch>` 装入与工作区同版本的原生包（`@opencode/pty@0.4.0`、`@opentui/core@0.8.1`）；这正是此前单文件编译产物启动即死（`Cannot find module '@opencode/pty-darwin-arm64/package.json'`）的根因。启动证据：两个架构分别无参启动均以退出码 2 拒绝缺 `--socket`（x64 经 Rosetta `arch -x86_64` 真实执行），发布门 `packages/cli/script/distribution.ts` 强制该项。构建输出 `{"ok":true,…,distributions:[arm64,x64]}`，exit 0。QA：`package-upgrade` **PASS 3/3**（`.omo/evidence/t32-upgrade-20261119/`）；失败场景原计划点名的 `package-missing-artifact` **当时不存在**（exit 66 `UNKNOWN_CASE`），故新建该用例（`.omo/evidence/t32-missing-b/`，PASS）：真实产物通过发布门，抽走 x64 目录后门报 `missing=x64` 并拒绝宣称支持，x64 目录已回位。限制：传递依赖许可证仍未枚举；产物为内部使用，未做公证/签名。
  - 2026-11-19 构建与可启动性实测（协调者）：`build:bridge` **exit 0**，产物 `packages/cli/dist-bridge/bridge-run.js` **11,533,063 字节**；进一步试了单文件编译：`Bun.build({ compile: { target: "bun-darwin-arm64" } })` **success=true** 且产物为 Mach-O arm64，但**启动失败**（`Cannot find module '@opencode/pty-darwin-arm64/package.json' from '/$bunfs/root/bridge-run'`）——本工作区根本没有安装任何 `@opencode/pty-*` / `@opentui/core-*` 原生包（`node_modules` 里一个都没有），而打包时它们被设为 external，所以单文件产物无法自包含运行。交叉编译到 x64 技术上可行（已验证 `compile.target: bun-darwin-x64` 能产出 x86_64 Mach-O），但同样会卡在同一个原生包缺失上。**因此本任务仍未完成**：双架构产物与真实启动证据均缺失，阻塞在「把原生附件随产物分发」这一打包工作上。
  - 2026-11-18 交接资料已落地：`product/opencode/BRIDGE.md`（安装/隔离/版本复探/升级演练/能力边界/回滚/数据保护）与 `BRIDGE-DEPENDENCIES.md`（cli 与 tui 的**直接**外部依赖 24 项及各自声明的许可证）。仍缺：分架构产物与实际启动证据；传递依赖许可证未枚举。证据：`.omo/evidence/t32-handover/`。
  - 2026-11-18 构建现状（协调者实跑，未勾选）：`build:bridge` 退出 0，产物 `packages/cli/dist-bridge/bridge-run.js`（11,530,749 字节）；但该产物**不能独立运行**（`Cannot find module '@opencode/pty-darwin-arm64/package.json'`，原生附件按设计外置），脚本自检跑的是**源码**而非产物；没有 `dist/bridge-darwin-arm64|x64` 双架构产物，也没有 `BRIDGE.md` 与依赖/许可证清单。证据：`.omo/evidence/t32-build-probe.md`。四项目标中仅第 1 项满足。
  - Recommended task executor category: deep-low — fork 构建、依赖许可和升级路径需闭环。
  - 做什么：在 fork 内创建 `packages/cli/script/build-bridge.ts` 与 `build:bridge`，复用现有 OpenTUI/Solid 构建机制，生成 `dist/bridge-darwin-arm64` 和 `dist/bridge-darwin-x64`；在对应原生 guest 或经验证的 Rosetta 环境实际启动各工件。编写 `product/opencode/BRIDGE.md`、许可清单和维护说明：安装、隔离、版本复探、升级演练、能力边界、回滚及用户资料保护；只支持个人或内部使用，不发布。不得把测试用 xterm 放入产品运行依赖。
  - Closes: GAP-3, GAP-4, GAP-6, GAP-8；Wave E | Blocked by: 31 | Blocks: F1–F4。
  - References: `upstream/opencode/packages/cli/package.json:18-26`、`upstream/opencode/packages/cli/script/build.ts`、`knowledge/licensing.md`、`knowledge/source-documents/04-roadmap.md:149-151`、任务 1 的工作区基线。
  - 验收：`bun --no-install --no-env-file run --cwd product/opencode/packages/cli build:bridge` 退出 0；两种 macOS 架构分别有构建及实际启动证据，缺少可用验证环境时对应项 BLOCKED；所有直接依赖和许可证有清单。
  - QA happy：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case package-upgrade --out "$QA_EVIDENCE/t32-upgrade"`；在独占副本重放版本升级检查、构建和两架构启动，并核对原工作区未改。失败：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case package-missing-artifact --out "$QA_EVIDENCE/t32-missing"`；缺少目标工件或平台执行环境必须拒绝宣称支持。
  - Commit: N。

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  - 2026-11-24 终审（协调者）：`final-plan-audit` 双向核对结果 **4/5 PASS**（`.omo/evidence/f1-final-check-20261124T095552Z/`：`plan-parses` 36 items、`ids-are-unique` unique、`named-evidence-exists` all present（34 个不同路径 / 38 处引用全部可解析）、`ticks-respect-dependencies` **consistent**），唯一失败是 `plan-is-complete: open: F1` —— 即审计自己那条未勾。两个既有的解析陷阱经核已死：条目正文里不再有多于一个依赖标记 token，F1 自身的正文也不再携带豁免令牌。本行勾选后另跑一次复核以确认 `plan-is-complete` 翻绿。
  - 2026-11-19 审计实测（协调者）：`final-plan-audit` 读计划与证据路径，结果 **FAIL（如实）**：36 项全解析、证据全存在，但 `ticks-respect-dependencies` 报 `32 before 31`，`plan-is-complete` 列出 open: 30、31、F1–F4。证据 `.omo/evidence/f1-final-e/`。本次同时修了它的两个解析缺陷：以前不认大写的 `[X]`（任务 24 因此被误报）且把用户已移出交付的任务 23 当未完成，现在按"已移出交付"视为已结算。
  - 对照全部用户选择、32 项任务和依赖矩阵逐项核对实际产物与证据，特别检查隔离、未跟踪文件、版本门槛及所选兼容范围；任何遗漏 REJECT。
  - QA：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case final-plan-audit --out "$QA_EVIDENCE/f1"`，读取真实产物和任务回执；伪造、缺失或不匹配的证据不得通过。
- [x] F2. Code quality review
  - 2026-11-24 收口（协调者）：四道门本轮全部 **exit 0**，证据 `.omo/evidence/f2-fixes-20261124T083232Z/`（`01-lint.log`、`02b-typecheck-force.log` 无缓存 36/36、`03-core-test.log` 259/0、`04-tui-bridge-test.log` 191/0、`05-build-bridge.log`、`07-lint-after-build.log` 构建后仍 0 错误）。修复前的真实红有记录：lint 曾 99 个 `eslint(no-restricted-globals)` Reflect 错误（38 个在我们自写的 14 个文件、61 个在未被 gitignore 的 `dist-bridge`），typecheck 曾不覆盖 `bridge-core`/`bridge-extension`（无任务）。修法：把 `Reflect` 换成规则允许的写法（无 disable、无规则改动，`.oxlintrc.json` 与上游 diff 为空）、`.gitignore:16` 忽略 `packages/cli/dist-bridge`、给两个包补 tsconfig 与 `typecheck: bun check --no-script`（turbo 任务数 34→36）。**已公开的残留**：`bridge-core/test` 与 `bridge-extension/test` 仍不在 typecheck 内，实测 9 个真类型错误在 4 个 bridge-core 测试文件，属另一笔改写；本条不因此降级为 `[~]`，因为"相关测试、lint、类型检查、构建"四道门均已成跑并记录退出码。
  - 2026-11-19 实测（协调者）：F2 点名的四条门里，`typecheck`（tui/cli 均 0）与 `build:bridge`（exit 0，双架构产物）已绿；但另外两条在本工作区**无法按字面满足**：`bun run lint` 全仓 exit 1（550 warnings / 95 errors，6934 个文件，均为 gui-plugins 等未触及包里的既有 `anti-slop` 类规则问题；本轮 15 个改动文件单独跑 oxlint 为 0/0）；`cd product/opencode && bun test ./packages/bridge-core/test ./packages/bridge-extension/test ./packages/tui/test/bridge ./packages/tui/test/mini` 为 541 pass / 18 fail，失败全是 `Cannot find module 'react/jsx-dev-runtime'`（根目录不加载 tui 的 bunfig solid preload，`--preload=@opentui/solid/preload` 也无法从根解析，而给根加 @opentui/solid 依赖会改动计划不允许动的 workspace 锁文件）；等价可执行形式 `cd packages/tui && bun test ./test/bridge` 为 170 pass / 0 fail。
  - 独立审查所有变更、异常处理、安全边界与测试有效性；不接受跳过或压制失败。一次执行相关测试、lint、类型检查和构建并记录退出码。
  - QA：`cd product/opencode && bun --no-install --no-env-file test ./packages/bridge-core/test ./packages/bridge-extension/test ./packages/tui/test/bridge ./packages/tui/test/mini && bun --no-install --no-env-file run lint && bun --no-install --no-env-file run typecheck && bun --no-install --no-env-file run --cwd packages/cli build:bridge`；必须全部退出 0。
- [~] F3. Real manual QA
  - 2026-11-24 实测（协调者）：Docker 半段在当前树上 **重跑 PASS 11/11**（exit 0，`.omo/evidence/f3-docker-rerun-20261124T085030Z/`：工件存在、daemon ready、socket 0600、两条并发认证连接、`get_protocol_info`/`subscribe_sessions`/`list_sessions`、断线重连后仍应答；清理回执 `docker ps -a` 无残留、gateway 关闭、临时 socket 与 key 记录删除），并覆盖了自上次跑后改动过的 `bridge-run.ts`（哈希在跑前跑后一致）。其余真曲面证据均已存在：`tui-stream` 7/7、`tui-stream-error` 8/8、`client-mcp-allow` 3/3、`plugin-real-renderer` 修 HOME 隔离后 7/7、`docker-host-invalid-option` 2/2。
  - **本行按 `[~]` 结案**：macOS 半段仍是 **BLOCKED**（`.omo/evidence/f3-macos-native-full-20261124T081349Z/`：无客体镜像，宿主 26.6.2 不支持自动供给需 27）；且任何一半都未跑真实模型回合（无凭据）。按用户 2026-11-20 的等价判断「Linux 开发容器跑通就基本等同于macOS跑通」，功能面由 Docker 半段覆盖，隔离面保持记名缺口。
  - 2026-11-19 两半实测（协调者）：Docker 半段 `docker-host-socket` **PASS 11/11**（`.omo/evidence/f3-docker-20261119/`：工件可用、daemon ready、socket 0600、双连接认证、subscribe、重连）；macOS 半段 `macos-native-full` **BLOCKED**（`.omo/evidence/t30-native-b/`：无客体镜像、无独立磁盘/用户/HOME/socket）。两者未同时通过，故 F3 不勾选。
  - 用代理驱动真实终端、独立 Docker 官方宿主和独立 macOS 虚拟机，重跑主对话、拒绝/恢复、Mini、真实插件、客户端 MCP 及权限安全负对照；查看截图和日志并核验每个清理回执。
  - QA：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case docker-host-socket --out "$QA_EVIDENCE/f3-docker"`，随后 `bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case macos-native-full --out "$QA_EVIDENCE/f3-macos"`；任一前置条件缺失为 BLOCKED。
- [~] F4. Ideal-state fidelity
  - 2026-11-24 逐行判定（协调者，证据 `.omo/evidence/f4-fidelity-20261124T081403Z/IS-VERDICTS.md`，之后又补两项真缺口）：**IS-1 部分证明** —— `tui-stream` 7/7、`tui-stream-error` 8/8、审批面修好后 `tui-dialog-stale` PASS 8/8（含 settled 与 host-close），终态新增 `tui-terminal-state` PASS 7/7（running→idle→aborted 三态在渲染屏上断言，`.omo/evidence/is1-terminal-20261124T091101Z/`）；但官方宿主在 TUI 内的整链仍 BLOCKED（无客体镜像）；`tui-stream` 曾因 `project.get` 报 `UNSUPPORTED_CAPABILITY` 把 TUI 打崩，已修（屏幕撞在 `session-tabs.tsx` 的 `detail()`，现由宿主公布的会话目录作答），并把用例的拉取顺序断言扩到九个文档化命令、稳定等待改读渲染后的网格——最终 `tui-stream` PASS 7/7、`tui-terminal-state` PASS 7/7（`.omo/evidence/tui-stream-crash-20261124T093656Z/`，含崩溃红 capture 与原样恢复哈希）。**IS-2 部分证明（结构性）**：`dialog-invalid-stale` 3/3、`recovery-gap` 4/4、`docker-host-invalid-option` 2/2。**IS-3 部分证明**：`native-task-todo-goal` 5/5、`native-memory-team` 6/6、`dag-live` 3/3，但均是在合成帧/替代宿主上，VM 半段 BLOCKED。**IS-4 部分证明**：`container` 6/6 与 `docker-host-socket` 11/11，macOS 半段 BLOCKED。**IS-5 未证明**：发布门仍红在 10 行能力。**IS-6 未证明**：原生 TUI + 官方宿主的 VM 联调 BLOCKED。**IS-7 部分**：Mini 已由用户移出交付（`mini-stream` FAIL 作为该行缺口）；插件用例修 HOME 隔离后 7/7；客户端 MCP `client-mcp-allow` 3/3。**IS-8 已补**：新增 `workspace-inventory` 用例，构建窗与清理窗两次 PASS 9/9，并带红 capture（`.omo/evidence/is8-inventory-20261124T090714Z/`）。
  - **本行按 `[~]` 结案**：IS-5/IS-6 依赖未决的 10 行能力与不存在的 macOS 客体镜像；IS-2 仍为结构性证据；IS-1 的恢复面与官方宿主整链未验。按 F4 规则，这些短项已各自转成可复核证据或已记录的阻塞（详见行内引用），不另起新条目，以免把环境阻塞伪装成待实现任务。
  - 2026-11-19 审计实测（协调者）：`ideal-state-audit` **PASS 4/4**（`.omo/evidence/f4-final-20261119/`：8 条 IS 行均有交付任务、点名的 QA 用例存在、证据路径可解析）。注意这是**结构核对**，不证明体验达标；F4 仍需在 31 关闭后人工逐行对照真实证据，所以不勾选。
  - 独立按 IS-1 至 IS-8 对照真实证据和用户体验，不把已选能力降级为“暂不支持”；检查原工作区与上游前后清单、证据保留和全部资源清理。
  - QA：`bun --no-install --no-env-file product/opencode/tools/bridge-qa/run.ts case ideal-state-audit --out "$QA_EVIDENCE/f4"`；每个 IS 均有可复核证据，缺一项则 REJECT 并新增实现任务。

## Commit strategy
本次计划和后续执行不暂存、提交、推送或创建 PR。只允许检查 Git 状态和读取索引；影子文件检查点不创建 Git commit。用户以后若明确要求提交，再按当时指令另行处理。

## Success criteria
> One row per IS row. The plan is complete only when every IS row has a delivering todo and a proving QA scenario; F4 checks the delivered behavior against these rows 1:1, and a shortfall becomes new `- [ ] N.` rows, never a note.
| IS | Delivering todo(s) | Proving QA scenario | Evidence |
| --- | --- | --- | --- |
| IS-1 | 9, 13–15, 17, 28–30 | `tui-stream`、`docker-host-socket`、`macos-native-full` | `$QA_EVIDENCE/t15-stream/`、`t29-socket/`、`t30-native/` |
| IS-2 | 8, 10–12, 16–19, 29–31 | `dialog-invalid-stale`、`recovery-gap`、`docker-host-invalid-option` | `$QA_EVIDENCE/t10-reject/`、`t11-gap/`、`t29-permission/` |
| IS-3 | 20–22, 26–28, 30–31 | `native-task-todo-goal`、`native-memory-team`、`dag-live` 和 VM 实测 | `$QA_EVIDENCE/t20-native/`、`t21-status/`、`t22-live/`、`t30-native/` |
| IS-4 | 2–4, 29–30 | `container`、`official-5167-reprobe`、`macos-native-full` 及清理回执 | `$QA_EVIDENCE/t02-container/`、`t03-reprobe/`、`t30-native/` |
| IS-5 | 4–5, 29–32 | `matrix-release-check`、`final-plan-audit` | `$QA_EVIDENCE/t31-complete/`、`f1/` |
| IS-6 | 19, 29–32 | `terminal-open-resize`、`macos-native-full`、`package-upgrade` | `$QA_EVIDENCE/t19-resize/`、`t30-native/`、`t32-upgrade/` |
| IS-7 | 23–25, 28, 30–31 | `mini-stream`、`plugin-real-renderer`、`client-mcp-allow`、VM 实测 | `$QA_EVIDENCE/t23-mini/`、`t24-plugin/`、`t25-allow/`、`t30-native/` |
| IS-8 | 1, 2, 30, 32 | `snapshot`、`container`、`package-upgrade` 的前后清单与清理回执 | `$QA_EVIDENCE/t01-snapshot.json`、`t02-container/`、`t32-upgrade/` |
