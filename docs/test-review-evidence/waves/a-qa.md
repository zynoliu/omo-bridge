# a-qa

## Facts
- 入口是 `bun run qa:tui -- --scenario <name>`，脚本为 `bun run script/qa/web-terminal-visual-qa.mjs` [package.json:18]；main() 把场景返回的 `result.exitCode` 直接当进程退出码 [script/qa/web-terminal-visual-qa.mjs:78]。
- 场景抛错时只打印 stack 并 `process.exit(1)`，不写 report.json [script/qa/web-terminal-visual-qa.mjs:86]。
- 默认证据目录 `<cwd>/.qa/run-<ISO时间戳>`，可被 --evidence-dir 覆盖 [script/qa/web-terminal-visual-qa.mjs:31]；当前仓库无 .qa 目录 [cmd: ls -d .qa -> no such file]。
- 桥隔离三件套：`mkdtempSync(tmpdir()/qa-bridge-)`、随机端口 4500-4899、随机 Basic 口令 [script/qa/lib/bridge.mjs:28] [script/qa/lib/bridge.mjs:29] [script/qa/lib/bridge.mjs:30]。
- 启动就绪判据只有一条：`GET /api/info` 返回 200（带 Basic 头），默认 90s 超时 [script/qa/lib/bridge.mjs:62]。
- 桥进程 `detached: true`，stdout/stderr 由两个 pipeLog 循环追加进 bridge.log [script/qa/lib/bridge.mjs:48] [script/qa/lib/bridge.mjs:55]。
- 默认渲染器是 xterm.js 页面 + Bun.WebView 读 buffer；xterm 启动失败才回落到 tmux [script/qa/web-terminal-visual-qa.mjs:63] [script/qa/web-terminal-visual-qa.mjs:66]。
- send-message 的通过条件（原样）：`exitCode: outcome === "reply" && !checks.error && checks.order ? 0 : 1` [script/qa/scenarios/send-message.mjs:187]。
- reply 判据是「相对 before 帧新增了一行匹配 `/Build · .+ · \d+(?:\.\d+)?s/` 的行」 [script/qa/scenarios/send-message.mjs:4] [script/qa/scenarios/send-message.mjs:44]。
- order 判据是「含 `┃` 且以 你好 结尾的行，行号小于该 footer 行」 [script/qa/scenarios/send-message.mjs:29] [script/qa/scenarios/send-message.mjs:32]。
- error/idle 分支：新增行命中 `ERROR_PATTERN` 即 error，两者都不命中即 idle [script/qa/scenarios/send-message.mjs:42] [script/qa/scenarios/send-message.mjs:46]。
- send-message 写 frame-before.txt、frame-after.txt、transcript.txt、report.json、frame.png、bridge.log [script/qa/scenarios/send-message.mjs:77] [script/qa/scenarios/send-message.mjs:145] [script/qa/scenarios/send-message.mjs:168] [script/qa/scenarios/send-message.mjs:198] [script/qa/lib/bridge.mjs:34]。
- report.history 是桥侧交叉核对：`/api/session?limit=1` 取最近会话再拉消息，记 total/assistant/lastText [script/qa/scenarios/send-message.mjs:151] [script/qa/scenarios/send-message.mjs:156]。
- models-dialog 的通过条件（原样）：`exitCode: outcome === "models" ? 0 : 1` [script/qa/scenarios/models-dialog.mjs:123]；outcome 需 dialog 打开、标题为 Select model（非 Free models）、可见模型名 >0、且无 No results found [script/qa/scenarios/models-dialog.mjs:78]。
- models-dialog 先读 `/api/model`、`/api/provider`、`/api/integration` 再起 TUI [script/qa/scenarios/models-dialog.mjs:29]；模型名集合取自这次读 [script/qa/scenarios/models-dialog.mjs:51]。
- models-dialog 额外写 frame-typed.txt、frame-connect.txt（/connect 的画面） [script/qa/scenarios/models-dialog.mjs:81] [script/qa/scenarios/models-dialog.mjs:98]。
- tmux 路径的 transcript 是 `capture-pane -e` 当前可见屏并把 ESC 换成字面 `\e` [script/qa/lib/tui.mjs:62] [script/qa/lib/tui.mjs:84]；xterm 路径是全量 chunk 拼接 [script/qa/lib/xterm.mjs:133]。

## Gaps
- 状态目录从不删除：script/qa 内没有任何 rmSync/unlink/rm 调用 [cmd: grep -rn "rmSync|unlink|rm(" script/qa -> 0 match]；本机已残留 32 个 qa-bridge-* 临时目录，每个约 108-128K [cmd: ls -d /var/folders/yv/*/T/qa-bridge-* | wc -l -> 32] [cmd: du -sh -> 128K]；桥侧 stop 也不清目录 [src/launcher.ts:861]。
- README 自相矛盾：选项表说 --keep「保留桥状态目录」暗示默认删除 [script/qa/README.md:16]，Cleanup 段又说「runner 不删除任何其它东西」 [script/qa/README.md:76]。
- --keep 是空操作：只出现在默认值、解析分支和 USAGE 文本，解析后再无读取 [script/qa/web-terminal-visual-qa.mjs:28] [cmd: grep -n "keep" script/qa/web-terminal-visual-qa.mjs -> 7,15,20,28]。
- --agent-dir 同样是空操作：被放在 ctx.agentDir [script/qa/web-terminal-visual-qa.mjs:58]，但 ctx.startBridge 只转发 repo/bunExe/evidenceDir 与场景入参 [script/qa/web-terminal-visual-qa.mjs:60]，而桥侧确实支持 OMO_BRIDGE_AGENT_DIR [script/qa/lib/bridge.mjs:44]。
- 桥中途死亡无任何观测：lib/bridge.mjs 没有等待或监听 child.exited，唯一断言点是启动期 waitForHttp [script/qa/lib/bridge.mjs:62]；全树唯一的 child.exited 在 xterm 渲染器里 [script/qa/lib/xterm.mjs:173]。
- 桥死后 report 也不记录：report 字段没有桥 pid/exitCode/退出原因 [script/qa/scenarios/send-message.mjs:173]；死桥只会表现成 idle（等满 90s）或 no-dialog，与「模型慢」不可区分。
- 启动失败只 kill 直属子进程，不跑 killHostsFor：catch 分支只有 child.kill() [script/qa/lib/bridge.mjs:64]，killHostsFor 仅在 stop() 里调用 [script/qa/lib/bridge.mjs:89] → 端口绑定失败会留下 detached 私有 host 与状态目录。
- stop() 不等进程真退：先按端口轮询，再两次 child.kill()，全程没有 await child.exited [script/qa/lib/bridge.mjs:83] [script/qa/lib/bridge.mjs:85]。
- bridge.log 的尾巴可能丢：两个 pipeLog 都是 `void` 起的，stop() 不 await 它们 [script/qa/lib/bridge.mjs:55]，而 report 把 bridge.log 当唯一事后证据 [script/qa/scenarios/send-message.mjs:193]。
- `--fault bridge-down` 在 tmux 模式下会顺手杀掉 TUI 的 shell：场景在 TUI 仍运行时调 bridge.stop() [script/qa/scenarios/send-message.mjs:80]，stop() 会 `pgrep -f <stateDir>` 并 SIGKILL 所有命中 [script/qa/lib/bridge.mjs:111] [script/qa/lib/bridge.mjs:118]，而 tmux 命令行把 `OMO_BRIDGE_STATE_DIR="<stateDir>"` 写进了 shell 命令 [script/qa/lib/tui.mjs:45] → README「TUI 仍然活着」[script/qa/README.md:58] 在该模式下不成立。
- send-message 的 exitCode 不看 ready/opened/submitted：三者只进 report 不参与判定 [script/qa/scenarios/send-message.mjs:180] [script/qa/scenarios/send-message.mjs:187]；未提交（composer 里还留着 你好）时，只要 composer 行含 ┃ 且某条 footer 行在它下方，reply 与 order 可同时成立。
- `if (process.env.QA_OPEN_SESSION === "0") { opened; }` 是空语句，只起注释作用 [script/qa/scenarios/send-message.mjs:74]；该变量真正的效果只有跳过 Enter 重试 [script/qa/scenarios/send-message.mjs:115]。checks.idle 算出后从未使用 [script/qa/scenarios/send-message.mjs:141]。
- reply 判据不与提问绑定：任何新增的 Build · … · Ns 行都算答复 [script/qa/scenarios/send-message.mjs:44]，不校验答复文本、不校验消息条数，history 也不参与判定 [script/qa/scenarios/send-message.mjs:187]。
- models-dialog 的 /connect 只记录不判定：connect.opened/emptyView/visible 全写进 report [script/qa/scenarios/models-dialog.mjs:93]，exitCode 只看 models 分支 [script/qa/scenarios/models-dialog.mjs:123]。
- models-dialog 只要求「至少一个名字可见」，不与 catalog 数量比对 [script/qa/scenarios/models-dialog.mjs:75]；modelStatus/providerStatus/integrationStatus 只被记录 [script/qa/scenarios/models-dialog.mjs:114]。
- models-dialog 用固定 10s 睡眠等资源同步 [script/qa/scenarios/models-dialog.mjs:62]；tmux 起 TUI 后固定 sleep 500ms [script/qa/lib/tui.mjs:53]，都是时间而非状态判据。
- models-dialog 的 catalog 在起 TUI 之前读、之后不再重读 [script/qa/scenarios/models-dialog.mjs:50] → 同一份 report 两侧不是同一时刻。
- transcript 不是「原始 PTY 流」：tmux 模式只是当前可见屏 [script/qa/lib/tui.mjs:62]，与 README 说法不符 [script/qa/README.md:45]。
- tui.mjs 暴露 transcriptPath 指向 tmux-stream.log [script/qa/lib/tui.mjs:38]，但没有代码写它、也没有场景读它；stop() 里 `pipe-pane -t <name>` 不带命令是关闭管道 [script/qa/lib/tui.mjs:128]。
- frame.mjs 只处理 H/f/A/B/C/D/G/K/J [script/qa/lib/frame.mjs:81]，忽略滚动区、插入/删除行 → tmux 截图的重渲染可能不同于真实屏幕；该解析器只服务 tmux 截图 [script/qa/lib/tui.mjs:98]。
- USAGE 只写 bridge-down [script/qa/web-terminal-visual-qa.mjs:13]，README 写的是 host-down [script/qa/README.md:58]，场景还支持两处都没写的 bogus-session [script/qa/scenarios/send-message.mjs:64]。
- 端口随机且无绑定重试 [script/qa/lib/bridge.mjs:29]，并发跑会撞端口，表现成 90s waitForHttp 超时而非端口错误。

## Claims
- send-message 的 pass 等价于「你好 上方出现一条 footer 模板行」，不校验答复内容或入库 | script/qa/scenarios/send-message.mjs:187 | high
- /connect 与 catalog 状态码不在任何 pass 条件内 | script/qa/scenarios/models-dialog.mjs:123 | high
- --keep 与 --agent-dir 均为空操作，README/USAGE 的承诺与实现不符 | script/qa/web-terminal-visual-qa.mjs:60 | high
- 每次运行遗留一个 qa-bridge-* 状态目录，任何模式都不清理 | script/qa/lib/bridge.mjs:89 | high
- 桥中途死亡不能被识别为桥故障，只会降级成 idle/no-dialog 且 report 无桥退出信息 | script/qa/lib/bridge.mjs:62 | high
- 启动失败会漏掉 detached 私有 host | script/qa/lib/bridge.mjs:64 | medium
- bridge.log 是不可靠的事后证据（写者未 await） | script/qa/lib/bridge.mjs:55 | medium
- tmux 模式下 --fault bridge-down 会杀掉 TUI 自己的 shell | script/qa/lib/tui.mjs:45 | medium
- transcript.txt 在 tmux 路径下是可见屏而非流 | script/qa/lib/tui.mjs:62 | high
- 场景抛错时证据目录里不会出现 report.json | script/qa/web-terminal-visual-qa.mjs:86 | high
- models-dialog 的 10s 固定睡眠让结果依赖机器速度 | script/qa/scenarios/models-dialog.mjs:62 | medium
- 断言读的是渲染后的 buffer，未覆盖真实终端的鼠标/焦点、slash 补全分支与并发运行 | script/qa/lib/xterm.mjs:129 | low
