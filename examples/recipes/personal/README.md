# 个人 Agent

个人插件把长期记忆、定时复盘和任务论证放在同一个可替换的接口之后。现有事件中台通过命令、普通回执和定时规则调用它。Antigravity CLI 用 `use: "agy"` 接入只读分析，旧 Gemini CLI 继续使用 `use: "gemini"`。

| 功能 | 入口 |
| --- | --- |
| 对话原文 | `chat` 默认写入用户原文和助手回复，可用 `recordChats: false` 关闭；`record` 可导入授权原文 |
| 日总结与月志 | `day`、`month`，每条摘要带来源 ID；`morning` 带上最近月志末段 |
| 词典、关系和检索 | `concepts` 从原文提取标签和关系；`graph` 查看关联来源；`recall` 结合文本和向量排名后补读来源 |
| 间隔复习 | 记录 `study` 后由巡检提醒，`revise <id> remembered` 或 `forgot` 记录结果并重排 |
| 梦境与经验改进 | `dream` 产出仅供查看的反思；`improve` 从真实反馈提炼候选经验，由另一模型评估，经本人采用才进入检索 |
| 闹钟、待办 | `morning` 读取“做对的本本”，`巡检` 读待办和复习，`done <id>` 完成待办 |
| 关怀与相处偏好 | `preference` 可记录称呼、沟通方式、陪伴主题和边界；`care` 只使用未过期的明确近况，支持时区、免打扰和一天一条 |
| 纠正与忘记 | `correct` 更正原记录；`forget` 删除原记录及引用它的派生记录；`prune` 清理到期记录 |

第一版自进化会更新后续任务可检索的做事方法，模型参数和执行授权仍由各自的配置管理。评估会检查经验的证据和回归方法。业务回归由相应项目的 CI 执行。内置向量是本地词项向量。需要语义向量时，`embedding` 可指定本机模块，其默认导出接收文本并返回 `number[]`。切换向量提供方时使用新库或重新导入，否则旧向量不可直接比较。关系采用 SQLite 中的来源和有类型关联，检索会带回关联上下文。

## 安装和运行

使用 Node 24。复制 `config.json` 到本地私有目录，将路径和模型改成接单用户实际可用的命令。先使用本地样例验证：

```sh
node plugins/personal/run.ts /absolute/private/personal.json record /absolute/private/entry.json
node plugins/personal/run.ts /absolute/private/personal.json recall 发布
node plugins/personal/run.ts /absolute/private/personal.json chat /absolute/private/question.txt research
node plugins/personal/configure.ts /absolute/private/registration.json
```

`record` 的 JSON 示例为 `{"kind":"preference","text":"平时使用简短中文"}`。个人近况还需提供带时区的 ISO 到期时间，例如 `"expires":"2027-01-01T09:00:00+08:00"`。用 `list` 找记录编号。用不同数据库与 scope 隔离私人和工作信息，工作者仅配置有权使用的库。数据库是本地文件，依赖操作系统的文件权限与备份管理；删除也应覆盖导出与备份。

Gemini 需要用后台接单用户登录，并准备可用沙箱。版本检查只是本机命令检查。独立注册执行器时，在 `agents` 下添加 `"gemini-agent": {"name":"Gemini","worker":"mac","use":"gemini"}`，把 `mac` 改为实际接单程序名称。工作论证使用 `dsh` 和 `roles.review` 指定的另一位审查模型。省略 `roles.review` 时默认使用 `gemini`。例如，在 `models` 中登记 `claude` 后，可把 `roles.review` 设为 `"claude"`。CLI 外的 Kimi 或其他模型可用兼容结构化输出的 `command` 适配器配置为角色。工具的认证设置各自管理。角色映射由配置决定，私人数据会随检索结果进入该次配置的模型，所以不同用途分别选择模型。本人聊天默认记录到指定的本地 scope，`recordChats: false` 关闭原文保存与后续自动提取。配置中的 `credentials` 只能列本次模型确需的环境变量名。

飞书可选 `tasks.personal: {"owner":"ou_…","config":"/absolute/private/personal.json"}`，在允许名单中指定同一个本人账号。启用消息理解后，本人普通闲聊也会进入个人聊天；仍支持显式输入 `个人 你还记得上次说的安排吗`；群聊及其他账号不读该记忆库。个人定时规则须绑定本人私聊通道。需要主动问候时将 `care.proactive` 设为 true；也可以仅保留日常对话。定时规则配置只生成片段，合并到现有 rules.json 后生效。

可选 `fallbackModels: ["dsh", "agy", "gpt"]`。先用该角色的首选模型，命令启动失败、超时或没有可读的 JSON 结果时，依次尝试列表中的模型，同一轮失败过的模型会跳过，下一轮重新尝试。全部用尽时，本轮失败并列出候选及安全的失败类别（启动错误码、退出码、JSON 格式或结果校验），不复制进程 stderr、提示词或凭据。列表中的模型都须允许读取本次资料，包括该范围内的记忆。要停用一个模型，移除它的模型登记，并更新角色和候补列表。

当前 `agy` 使用计划模式和终端沙箱执行只读分析，用后台接单账号配置登录。每次调用明确禁止写文件、执行命令、调用 MCP 和访问网页。项目要优先用它独立审查，可在 `models` 登记 `"agy": {"use":"agy"}`，再设 `roles.review` 为 `"agy"`。

后台发现多个 Gemini 安装时，可以用 `--version` 核对版本，并在模型或执行器中显式登记支持 `plan` 的程序路径。早期 0.27 版需要在 Gemini 设置中启用 `experimental.plan` 才能使用只读论证。

## 项目派单与 Bug 来源

1. 参照 `registration.json` 生成项目规则。把原来同一来源、同一事件类型直达开发的规则替换为论证规则，否则一个需求会被派两次。保留 Codeup 开发执行器及 `developerEmits`，继续复用独立工作区、MR 和 CI/CD。
2. DeepSeek 判定复杂度后，常规任务由 DeepSeek 单审，开放式规划由配置的另一位审查模型单审。复杂任务尽量由两位模型独立出方案，再由另一位审查模型汇总。启用候补后，第二份审查拿不到时会标明单审并继续；已提出的问题仍通过卡片索取文字补充，通道须开启 `links: true` 并使用可达的卡片地址。最终方案和原始需求进入 Codex 开发规则，涉及写代码和返修时沿用该规则的执行器和权限。经验候选仍需要由另一位模型评估后才能请本人采用。
3. 在 Codeup 项目登记中打开 `personalFeedback`，重新生成交付规则，允许发出 `delivery.feedback`，并在个人规则中订阅。失败及成功回执进入项目记忆。旧版 Codeup 配置可维持现状。
4. Bug 平台确定前，可用 `bugFeed` 指定本机 JSON 数组，并为项目设置 `chron.bugs`。每项包含 `id`、`revision`、`project`、`summary`，可选 `detail`、`link`；只列可领取的普通项目缺陷。接正式平台时提供 `bugProvider` 模块，默认导出实现 `list()`、`claim(bug,key)`，并可实现 `ack(key,eventNumber)`。同一个 key 重试时，已经由同一接入方领取的记录仍应返回成功，直到中台确认后再从待处理列表隐藏。项目、Bug ID、修订号决定稳定事件号。需要确认回写或超过回执上限时，配 `bugHub.url` 和 `bugHub.keyEnv`，由项目来源密钥提交，拿到中台编号后回写。接入后 Bug 会走同一套论证和 Codex 修复规则。
5. 可用模拟 Bug 源验证领取、去重和路由。生产平台的状态字段、鉴权和领取 API 由实际平台适配器负责。

设计依据：[MemGPT](https://arxiv.org/abs/2310.08560)、[Generative Agents](https://arxiv.org/abs/2304.03442)、[Reflexion](https://arxiv.org/abs/2303.11366)。Gemini 开关参考 [官方 Headless 模式文档](https://geminicli.com/docs/cli/headless/)。

纠正记忆时使用当前配置的 embedding 重新计算向量；未配置时使用本地词面向量。纠正失败保留原记录，成功后仍清除依赖旧记录的派生记忆。论证详情按序列化后的长度裁剪字段，保持合法 JSON；超限摘要带 `truncated: true`，完整论证仍保存在本地记忆库。

## 本人记忆与关怀闭环

聊天注入已批准偏好、相关记忆和成对的近期对话。原文保存后进入持久提取队列，飞书后台每 30 秒处理；重启继续，失败保留，不阻塞回复。直接运行 CLI 时可执行 `node plugins/personal/run.ts /absolute/private/personal.json extract` 消费队列。只提取本人明确表达的偏好、决定和近况；自动近况必须有有效到期时间且不超过 30 天，不从普通聊天推断疾病。去重、明确纠正与恢复会更新相关记录；遗忘原文会连带删除派生记录和提取任务。

数据库使用 WAL；本地中文向量同时包含单字与双字词项，近期记录优先，稳定偏好与决定不作时间衰减。关怀参考最近三条问候记录及当日聊天，可返回 `skip`，当天不再重复生成。已成功发送的关怀、待办、复习和提醒进入本人私聊上下文，引用回复可以继续对话。主动关怀仍需要 `care.proactive: true`。

月志定时改为每月 1 日汇总上一月，以 `YYYY-MM` 去重；手动 `month` 默认查看当前月。手动记录近况也必须给出合理到期时间（最长 90 天）。模型与凭据继续使用本机既有配置；未添加外部向量服务。

### 提取失败恢复

过期原文不会占据自动提取队列。相同原文连续失败三次后保留记录并停止自动尝试；修复模型配置后，沿用本插件原有 CLI 参数格式运行 `extract-failures` 查看当前 scope 的失败记录，再用 `extract-retry` 将它们重新入队。该操作不自动恢复已遗忘或过期的原文，也不把私人内容写进中台日志。
