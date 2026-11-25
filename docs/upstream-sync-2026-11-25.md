# 上游同步与本地流程兼容评估

同步基线：本地 `46a92daaa2e8815af69beca66a87b7f5d64bc5b7`；共同祖先 `5eb4be89077461aa6a355757eed834667efe6749`；上游目标 `9f3e4a86c349dedc0623ac9aadfa40cd6923381b`，共 48 个提交。当前候选在独立工作树准备，不修改运行数据或主动重启服务。

## 上游变更及影响

| 领域 | 上游变化 | 对本地的影响和处理 |
| --- | --- | --- |
| 内核与协议 | 配额用尽暂停派单、到期恢复；复查/回答保留原事件关联；规则换组和时区变更正确生效；重复回执事件内容冲突明确拒绝 | 是兼容扩展；原规则和插件继续工作。配额识别目前主要来自 Claude，其他模型不会自动获得同等识别能力。旧日志由既有格式指纹重建投影，插件私有库不迁移 |
| 失联与停止 | 本人可结束 unknown 轮次；不能确认进程结束时保留真实原因 | 本地飞书、看板改成中性“本轮已结束”，同时保留 summary/error，不把结案误报为进程已停止 |
| worker | 只扫描活跃任务、异步清理历史；Windows 进程句柄；登录 shell 的 PATH 查询；Codex 安装位置发现；失败文本不截断 Unicode | 保留本地登录噪声分流与完成结果完整读取；原有恢复、取消和长输出测试继续验证 |
| 状态与 CLI | 按规则分页历史、状态统计索引优化、布尔参数修复、可选 tags、通道获得 lane | host/state 冲突按字段合并，保留本地 runId 和来源聚合；tags/lane 正常扩展。看板当前未专门展示配额限流卡之外的 agents.limited，属于新增展示能力而非旧流程故障 |
| 飞书 | 连接被拒绝时每分钟重试，授权失败给可读说明 | 本地任务确认回调和送达记录扩展保留，仍用既有 lark 事件总线；不启动新的真实监听 |
| GitHub delivery | 两级发现、两轮后负责人决定；最终差异审查；长 CI 等待不消耗失败重试次数；默认审查模型 gpt-6.2-sol；路径 ** 修复 | GitHub 自身策略跟随上游。Codeup 仅共用命令构造和路径匹配，不跟随其审查门禁策略。Codeup settings 已要求显式模型，默认模型变化不覆盖项目设置 |
| 安装与示例 | 系统级服务不被用户安装覆盖、非法端口不留半安装、禁止 Agent 在自己轮次里启动同一中台；轮询示例改 Node 兼容 Windows | 不改变本次本机服务；使用临时 HOME 做安装冒烟。已运行服务需要正常重启后才完整采用新代码，本批不主动重启 |

## 冲突与兼容修复

文本冲突仅有 `host/state.ts` 与 `docs/protocol.md`，合并后的本人状态同时包含上游 tags/lane/about 与本地 runId。异步来源、本地看板认证、个人记忆、Codeup/Flow 与飞书任务扩展均保留。

独立审查发现 Codeup 复用了 GitHub 的 parseReview，后者升级后拒绝旧 title/text 结果。新增假 CLI 驱动真实 runtime.review 的失败测试，再由 Codeup 自己解析既有合约；不删除检查、不让非空发现变成通过。失联结案的同类提示已一并修正并补回归。

## 验证与合并门禁

在 macOS / Node 24.10.0，临时 HOME、随机回环端口与假 CLI 验证，不向真实用户发消息，不创建 Codeup MR。Codeup 非空发现、飞书失联结案及看板时间线等针对性回归 71/71 通过；typecheck、format:check 通过。完整模拟、穷举、每日检查、安装冒烟及三平台 CI 的最终结果记录于同步 PR 与交付说明，不把本地结果冒充远端 CI。

仓库要求 main 合并前最终提交的 Ubuntu/macOS/Windows check 全部通过。因此候选先进入同步分支，待相同提交的检查和独立审查通过后再合入；保留同步前备份分支。没有发布新版本或修改上游仓库。

## CI 与后续观察

首次 Windows CI 暴露本地扩展测试的平台假设：飞书 CLI 的 shebang 假程序按现有 Unix 测试入口运行；Unicode 路径继续跨平台验证，换行文件名仅在允许它的 Unix 文件系统验证；多连接 SQLite 测试统一先关闭全部连接再删除目录；本地 Git remote 的测试重写使用 file URL，避免 Windows 盘符差异。真实 Windows 结果以最终 CI 为准。

DeepSeek 两次审查均超时，未取得完整结论。其部分输出中，主控和独立 Codex 核实了一项后续观察：同一 Claude Agent 的并行轮次分别报告 T1、T2 恢复时间，并在 T1 前手动成功时，仅等待 T2 的轮次立即恢复，等待 T1 的旧轮次仍延迟到 T1；任务未丢失。DSH/agy 当前不产生 limitedUntil，不受此路径影响。按仓库对罕见组合的范围约束，本批记录而不扩改内核。其他关于空字段误判、跨来源事件冲突与 unknown 释放名额的推测，与字段标准化、按来源去重及已有计数代码不符，未采纳。

## 全部新增提交

- `bfa6d79` chore(delivery): default Codex reviewer model gpt-6.2-sol (#336)
- `ea29fa0` feat(kernel): a check names the events its round worked on (#333)
- `ca5c0ff` fix(feishu): explain a listener Feishu refuses for another connection, and retry it once a minute (#337)
- `246bf67` feat(delivery): review findings in two levels, two rounds then the owner decides (#342)
- `d5b754e` fix(delivery): owner decides only after two rounds; the checking round still reviews unrelated new code (#343)
- `aecaa53` fix(delivery): an owner's decision counts only after the second round; a fresh full review keeps the known findings (#344)
- `dd4187a` fix(delivery): a blocking finding answered with docs only gets checked against the whole change (#345)
- `d1ec2d8` fix(kernel): an answer names the source's event when a check round asked (#341)
- `7c39ed4` 文档：补充 Agentica 的 ACP 接入方式 (#339)
- `ee98eb4` docs(agents): say the plugin tutorial is the document CI still tests (#361)
- `801a32b` perf(cli): 同一页历史复用时间格式和当天日期 (#353)
- `50600d2` fix(cli): 复制历史翻页命令时保留规则名和页码 (#352)
- `d1214be` fix(rules): 提前拒绝无效的来源插件名 (#359)
- `a297c2b` fix(worker): the reason a run failed keeps whole characters (#349)
- `49144a8` perf(runs): 按规则从中台分页读取历史轮次 (#355)
- `8609762` fix(worker): find agents a terminal's shell puts on PATH (#347)
- `1f1095e` fix(delivery): a failed reviewer's reason keeps whole characters (#365)
- `e2f32a0` examples: run the pollers on node so the recipes work on Windows (#358)
- `26f2793` fix(service): re-running the installer leaves a system-level unit to its owner (#366)
- `0729923` fix(kernel): a changed timezone moves schedules to the new zone's clock (#367)
- `9e97a61` fix(kernel): runs and open cards follow their rule into a new group (#368)
- `8e60f04` feat(kernel): hold an agent out of quota until its usage limit resets (#357)
- `f9bac87` fix(examples): the source template keeps whole characters in its summary (#373)
- `2a97d12` fix(feishu): a refused card says why and what to do, not lark-cli's JSON (#374)
- `47a9abf` 修复共享用量限制通知误报恢复状态 (#376)
- `3262b53` fix(worker): the worker's own failure text keeps whole characters (#377)
- `f27466d` 规则可选标签：写了 tags 就原样带进状态、轮次、卡片和资料文件 (#380)
- `707948e` test(usage-limit): pin the state view freeing an agent once its reset has passed (#382)
- `57ce6a3` test(windows): the link cases stand down where the account can't make one (#378)
- `8d3d1d7` fix(delivery): a path pattern ending in ** covers everything below it (#379)
- `ac761d3` test(pause): pin the state view freeing a rule once its pause has ended (#385)
- `2c5c621` fix(worker): 轮询只检查活跃任务，避免历史目录阻塞中台 (#383)
- `8c74ffd` fix(delivery): a reviewer that exits early no longer ends the run (#389)
- `a01ac28` fix(codex): the Codex an update moves is found where the app keeps it now (#387)
- `62feecc` test(usage-limit): a reset that has already passed holds nothing (#392)
- `0d8733a` fix(init): 非法端口不再留下半安装状态 (#399)
- `18307c0` fix(worker): a timed-out run nobody watched stop no longer says it was stopped (#395)
- `e3f13bc` perf(worker): Windows 用进程句柄检查自己启动的任务 (#396)
- `f85dd5a` feat(kernel): 通道卡片带上 lane，让通道能把卡片发回事项来的地方 (#393)
- `b8d082b` fix(up): refuse to restart the hub that runs the turn from inside it (#401)
- `3b160b2` fix(kernel): a stop nobody saw finish keeps the worker's reason (#402)
- `bbea675` fix(cli): 布尔参数不再吞掉后面的位置参数，支持 --flag=value (#404)
- `bdd9922` fix(kernel): an owner can end a round nobody has heard from (#410)
- `b0016b9` fix(kernel): a receipt event whose id already holds another event is listed in rejected (#407)
- `890d161` fix(delivery): a slow full check is waited for, not counted as a failed try (#411)
- `e11fa94` perf(state): 加快长历史下的状态汇总 (#406)
- `361154f` docs: README startup at 1.1 million facts matches the new history measurement (#412)
- `9f3e4a8` fix(delivery): only a check still going is waited on past the half hour (#413)
