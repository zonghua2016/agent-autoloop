# 上游同步与本地流程兼容评估

2026-11-25 已完成同步：[PR #1](https://github.com/zonghua2016/agent-autoloop/pull/1) 已合并，本地与 fork 的 `main` 均为 `a4c47b7202a747de2bd075eb65e5e1cfe194d4bd`。本次没有发布版本、重启服务或修改运行数据；检查通过不代表在线服务已采用新代码。

同步基线：本地 `46a92daaa2e8815af69beca66a87b7f5d64bc5b7`；共同祖先 `5eb4be89077461aa6a355757eed834667efe6749`；上游目标 `9f3e4a86c349dedc0623ac9aadfa40cd6923381b`，共 48 个提交。保留上游提交历史；相对本次上游目标，合并后的 main 领先 5 个提交、落后 0 个提交。

## 上游变更及影响

| 领域 | 上游变化 | 对本地的影响和处理 |
| --- | --- | --- |
| 内核与协议 | 配额用尽暂停派单、到期恢复；复查/回答保留原事件关联；规则换组和时区变更正确生效；重复回执事件内容冲突明确拒绝 | 是兼容扩展；原规则和插件继续工作。配额识别目前主要来自 Claude，其他模型不会自动获得同等识别能力。旧日志由既有格式指纹重建投影，插件私有库不迁移 |
| 失联与停止 | 本人可结束 unknown 轮次；不能确认进程结束时保留真实原因 | 本地飞书、看板改成中性“本轮已结束”，同时保留 summary/error，不把结案误报为进程已停止 |
| worker | 只扫描活跃任务、异步清理历史；Windows 进程句柄；登录 shell 的 PATH 查询；Codex 安装位置发现；失败文本不截断 Unicode | 保留本地登录噪声分流与完成结果完整读取；原有恢复、取消和长输出测试继续验证 |
| 状态与 CLI | 按规则分页历史、状态统计索引优化、布尔参数修复、可选 tags、通道获得 lane | host/state 冲突按字段合并，保留本地 runId 和来源聚合；tags/lane 正常扩展。看板当前未专门展示配额限流卡之外的 agents.limited，属于新增展示能力而非旧流程故障 |
| 飞书 | 连接被拒绝时每分钟重试，授权失败给可读说明 | 本地任务确认回调和送达记录扩展保留，仍用既有 lark 事件总线；不启动新的真实监听 |
| GitHub delivery | 两级发现、两轮后负责人决定；最终差异审查；长 CI 等待不消耗失败重试次数；默认审查模型 gpt-6.2-sol；路径 ** 修复 | GitHub 自身策略跟随上游。Codeup 共用命令构造、路径匹配和回执编码，不跟随其审查门禁策略。Codeup settings 已要求显式模型，默认模型变化不覆盖项目设置 |
| 安装与示例 | 系统级服务不被用户安装覆盖、非法端口不留半安装、禁止 Agent 在自己轮次里启动同一中台；轮询示例改 Node 兼容 Windows | 不改变本次本机服务；使用临时 HOME 做安装冒烟。已运行服务需要正常重启后才完整采用新代码，本批不主动重启 |

## 冲突与兼容修复

文本冲突仅有 `host/state.ts` 与 `docs/protocol.md`，合并后的本人状态同时包含上游 tags/lane/about 与本地 runId。异步来源、本地看板认证、个人记忆、Codeup/Flow 与飞书任务扩展均保留。

独立审查发现 Codeup 复用了 GitHub 的 parseReview，后者升级后拒绝旧 title/text 结果。新增假 CLI 驱动真实 runtime.review 的失败测试，再由 Codeup 自己解析既有合约；不删除检查、不让非空发现变成通过。失联结案的同类提示已一并修正并补回归。

## 最终验证与收尾

本机 macOS / Node 24.10.0 使用临时 HOME、随机回环端口与假 CLI，验证了 Codeup 非空发现、飞书失联结案、看板时间线和安装到卸载流程；typecheck、format:check 通过。没有向真实用户发消息、创建真实 Codeup MR 或验收生产部署。

以下结果对应最终提交 `a4c47b7202a747de2bd075eb65e5e1cfe194d4bd`，2026-11-25 已核对：

| 检查 | 结果与证据 |
| --- | --- |
| 合并前 check | [Ubuntu、macOS、Windows 全部通过](https://github.com/zonghua2016/agent-autoloop/actions/runs/45583356964) |
| 完整 nightly | [deep 与三平台最新 Node 检查全部通过](https://github.com/zonghua2016/agent-autoloop/actions/runs/45583675243)。该次手动运行以 `commit` 输入检出上述完整提交号；包含 20 万步模拟、有界穷举、1000 次实际强杀和全部变异检出，以及安装冒烟 |
| 合并后 main check | [三平台全部通过](https://github.com/zonghua2016/agent-autoloop/actions/runs/45584624583) |
| 独立审查 | 独立 Codex 审过最终提交，并在合并后复核本批全部改动，未发现阻挡合并的问题；结论记在 PR 的「如何验证」 |

Fork 的 Actions 和每日检查已按本人授权启用。同步临时工作树及本地、远端同步分支已清理；保留 `codex/backup-before-upstream-20261125` 备份分支。清理范围仅为本次同步创建的对象，不包括业务项目工作树。没有修改上游仓库。

## CI 与后续观察

CI 发现并修复了测试的平台假设：飞书 CLI 的 shebang 假程序按现有 Unix 测试入口运行；Unicode 路径继续跨平台验证，换行文件名只在 Unix 验证；多连接 SQLite 测试先关闭全部连接再删除目录。Codex ACL 脚本在缺少 CodexSandboxUsers 时由 `return` 改为 `exit 0`，其他 ACL 错误仍失败；新增的命令准备回归已在真实 Windows runner 通过。

飞书按钮集成测试改为等实际卡片 ref 绑定后再模拟点击，授权与重复点击断言保持不变。真实用户在服务端已显示卡片但本地送达绑定前点击，仍可能被忽略；本批没有改变该低频窗口，测试通过不证明该窗口已消除。

DeepSeek 两次审查均超时，未取得完整结论。其部分输出中，主控和独立 Codex 核实了一项后续观察：同一 Claude Agent 的并行轮次分别报告 T1、T2 恢复时间，并在 T1 前手动成功时，仅等待 T2 的轮次立即恢复，等待 T1 的旧轮次仍延迟到 T1；任务未丢失。DSH/agy 当前不产生 limitedUntil，不受此路径影响。按仓库对罕见组合的范围约束，本批记录而不扩改内核。其他关于空字段误判、跨来源事件冲突与 unknown 释放名额的推测，与字段标准化、按来源去重及已有计数代码不符，未采纳。

## 提交追溯

上游 48 个提交的完整列表见 [GitHub 差异](https://github.com/KKKKhazix/agent-autoloop/compare/5eb4be89077461aa6a355757eed834667efe6749...9f3e4a86c349dedc0623ac9aadfa40cd6923381b)，本地也可按固定基线查询：

```sh
git log --reverse --oneline 5eb4be89077461aa6a355757eed834667efe6749..9f3e4a86c349dedc0623ac9aadfa40cd6923381b
```

本 fork 的同步与修复提交：`859c02c` 合并及插件兼容修复，`b4a1bcd` 跨平台测试修正，`8bd7183` Windows Codex ACL 修复，`a4c47b7` 可选 SID 探测回归修正。同步前本地功能集中在 `46a92da`；各阶段设计与验收见[五阶段实现](modification-plan.md)、[首批审查](batch-review-2026-11-23.md)及[架构修复](architecture-implementation-2026-11-25.md)。
