# 飞书项目 · 我的需求和缺陷

插件通过飞书官方 `meegle` 客户端调用飞书项目 MCP。个人清单读取登录账号、登记的视图和业务线选项。查看清单只需读权限。当前支持飞书项目公有云的需求视图和缺陷视图。

## 查看我的工作项

1. 在接单机安装官方客户端，例如 `npm install -g @lark-project/meegle`，用接单用户运行 `meegle auth login --host project.feishu.cn --device-code`。用 `meegle auth status` 核对账号授权。本机验证版本为 1.0.28。后台找不到命令时，在配置的 `cli` 填写实际可执行文件的绝对路径；Windows 可指定客户端的原生 exe 或 npm 包内的 bin/meegle.js。
2. 复制 [config.json](config.json) 到 `~/.config/agent-autoloop/feishu-project.json`，也可以在运行时指定其他路径。团队填入需求、缺陷视图链接。只关心本人负责的事项时，`profile.projects` 填 `"*"`，可省略顶层 `projects`。按项目订阅或派发时，在顶层 `projects` 登记本地项目编号与飞书业务线的对应关系。`businessLine` 可以是业务线名称或选项 ID。项目使用单独的视图时，可设置项目级 `storyView`、`issueView`。只登记一种视图也可以运行。
3. 个人只填 `profile.role` 和 `profile.projects`。前端跨业务线跟进可用 `{"role":"前端","projects":"*","match":"owner"}`；限定项目时可填 `"projects":["demo"]`。职务支持前端、后端、iOS、Android。身份默认取本机飞书项目登录用户；在共用机器上为每人使用各自的系统账号，并用 `profile.userKey` 锁定预期身份。登录身份与配置不符时会在读取视图前停止。
4. 从仓库根目录运行（Node 24）：

```sh
node plugins/feishu-project/run.ts list
```

每项列出所属项目、标题、状态和飞书详情链接。`[]` 表示符合当前范围的事项为零。默认 `match: "owner"` 显示本人为当前负责人、进行中节点负责人、指定岗位的需求负责人或缺陷经办人的事项。`projects: "*"` 覆盖已登记视图的所有业务线，也包含未填业务线的事项。希望缩小范围时，可用 `match: "role"` 只查指定需求角色，以及经办人和所属端都匹配的缺陷。创建者、报告人以及同名同事不会被算作本人。

业务线在接口中可能只返回选项 ID。插件每轮读取字段配置进行匹配。岗位以稳定角色标识匹配，即使界面上的角色拼写有差异也能匹配。团队可在 `roles` 覆盖职务映射，例如 `{"客户端开发":{"storyOwner":"pc","issuePlatforms":["本空间的端选项ID"]}}`。系统或自定义字段标识可在 `fields` 覆盖，默认值为 `line: business`、`platform: bug_classification`、`issueOwner: operator`、`description: description`。其中 `issueOwner` 对应经办人角色标识。

## 接到现有开发流程

列清单会显示匹配的工作项。列表中的事项只有能唯一对应登记项目、岗位分工匹配且状态满足配置时，才会进入开发。定时同步只派发项目在 `ready` 里明确允许的状态，例如在 `projects.demo` 中另加 `"ready": {"issue":["OPEN"],"story":["开发中"]}`。状态要使用本空间实际名称。项目编号应对应可信登记的开发目标；先核对业务线是否足以唯一确定仓库，再启用派发。

将下列片段合并到本机规则，替换机器名、工作目录、项目编号与个人配置文件路径。示例使用已登记的 Codeup 开发执行器。已有需求论证规则也可订阅同一来源；为每个项目和事件类型选择一条接单规则。

```json
{
  "sources": { "feishu-project": { "name": "飞书项目" } },
  "agents": {
    "my-feishu-project": {
      "name": "我的飞书项目",
      "worker": "mac-mini",
      "use": "feishu-project",
      "command": ["/absolute/private/feishu-project.json"]
    }
  },
  "rules": [
    {
      "name": "检查我的飞书项目",
      "when": { "cron": "*/10 * * * *" },
      "to": "my-feishu-project",
      "prompt": "检查本人已获分配的工作项",
      "cwd": "/absolute/private",
      "tell": "never"
    },
    {
      "name": "demo 飞书项目开发",
      "when": { "source": "feishu-project", "types": ["demo.feature", "demo.bug"] },
      "to": "codeup-demo-develop",
      "prompt": "按照已登记的项目规则开发",
      "cwd": "/absolute/path/to/demo",
      "parallel": 1,
      "group": "demo-development",
      "emits": { "source": "codeup-demo", "types": ["delivery.requested"] }
    }
  ]
}
```

先用 `meegle user me --format json` 获取 `user_key` 并填入 `profile.userKey`，定时同步据此核对登录身份。在个人配置中添加 `"hub": {"url":"http://127.0.0.1:实际中台端口","keyEnv":"FEISHU_PROJECT_SOURCE_KEY"}`，将该来源的中台密钥交给运行插件的进程。需要新来源密钥时使用 `agent-autoloop key new source feishu-project`。该密钥仅用于中台，飞书授权由官方客户端管理。

`poll` 会直接向中台逐条提交符合条件的事项。派发前按编号重读候选项的负责人、状态和描述，再次核对目标项目。浏览清单时只取筛选和展示字段。相同来源下，每个空间、类型和工作项编号只触发一次开发；标题更新、重复轮询、提交响应丢失后重试都会复用同一编号。已归档的旧任务再次出现也沿用此语义。飞书侧的经办人分配和状态继续由团队工作流维护，本插件只读飞书。旧的多维表格领取器仍使用其独立的数据源。

### 正式轮询本人经办的前端缺陷

同事提的 Bug 也可以自动接单。在固定的开发目标下登记飞书空间，省去逐条登记编号和维护个人视图。例如：

```json
{
  "profile": { "userKey": "本人的飞书项目用户标识", "role": "前端", "projects": ["demo"] },
  "projects": {
    "demo": { "assignedIssueSpace": "空间英文标识", "ready": { "issue": ["OPEN", "REOPENED"] } }
  }
}
```

`assignedIssueSpace` 填空间链接里的英文标识。插件按飞书登录用户的经办人角色查找工作项，读取所有结果页，再核对所属端和状态。报告人可以是任意同事，业务线可以留空。派发前会复查负责人和开工条件。由试点切换时保留中台的来源标识，同一缺陷不会因为发现方式变化再次开工。

要把 MR 链接私发给本人，在专用的 Codeup 开发命令末尾加 `--notify-mr`，为该规则设置 `tell: "needed"` 并指定已绑定本人的飞书通道。两项检查通过并创建 MR 后，中台会投递一张带链接的通知卡。人工合并的流程使用独立来源记录 `delivery.requested`，不把该来源接入自动交付规则。

验收时按测试人员的视角录入缺陷：写明页面、操作步骤、实际结果和期望结果。能用一条示例让人复现，就写这条示例。比如「从客服公告点开帮助链接，网址末尾少了一个右括号」。

### 先用测试仓库验收

团队共用一个缺陷视图时，可以只登记准备用于验收的飞书缺陷编号。这种登记方式允许业务线为空，且继续核对经办人、所属端和状态。例如：

```json
{
  "issueView": "https://project.feishu.cn/example/issueView/example-issue",
  "issueIds": ["12345"],
  "ready": { "issue": ["OPEN", "REOPENED"] }
}
```

将这段放在 `projects.<测试项目>`。编号以字符串填写，空列表表示只轮询。这里选择已分配、尚待开工或重开的缺陷，跳过处理中、已解决和已关闭的记录。重开的缺陷如果已派发过，沿原任务跟进；同一编号始终只触发一次初始开发。

使用中台定时任务时，可以在 Agent 的 `command` 中将 `"receipt"` 放在配置文件路径后，并给轮询规则设置 `emits`，只允许从专用来源产生 `<测试项目>.bug`。该模式复用本轮的回执权限，无需另外签发来源密钥或配置 `hub`。待处理事项较多时会自动分批，每批最多 100 条，剩余事项由中台定时接着处理。测试项目开发规则只订阅这一种事件。验收到创建 MR 为止时，将开发规则的 `delivery.requested` 回执记在该专用来源，不为它登记交付订阅。开发仍要通过目标分支登记的独立审查和 CI。结果可在本机轮次和 Codeup MR 中查看。

[飞书项目 MCP 官方说明](https://project.feishu.cn/b/helpcenter/1ykiuvvj/qaq5d7ru) · [官方客户端与登录说明](https://github.com/larksuite/meegle-cli)

### MR 合并后的测试验收

为测试项目启用两条命令规则，均运行 `node plugins/feishu-project/follow.ts <本机验收配置> <操作>`，沿用可以读取该仓库、启动测试流水线的 Codeup 环境。配置包含 `project`、`registry`、Codeup 工作记录的 `database`、`space`、可信事件 `source`、纳入跟进的首个 MR 编号 `fromMR`、本人项目账号 `userKey` 及已绑定飞书通道的 `ownerOpenId`。`deployment` 使用多维表格测试部署的同一结构，须填写测试流水线、版本接口、版本字段及页面地址。地址中的 `{commit}` 对应合并提交。可选 `instructions.<缺陷编号>.steps` 和 `expected` 可为个别历史缺陷补充测试说明，日常从缺陷描述取材。若模板在送验时要求解决字段，在 resolvedFields 配置对应选择项 ID（多选为 ID 数组）；单项缺陷可在 instructions 对应的 resolvedFields 覆盖。只填空字段，保留经办人已经填写的值。

| 操作 | 触发方式 | 回执 |
| --- | --- | --- |
| `discover` | 定时扫描本项目已通过审查、CI 且有 MR 的缺陷开发记录 | 在原专用来源发出 `<项目>.acceptance` |
| `track` | 订阅同来源的 `<项目>.acceptance`，设置 `parallel: 1`、`tell: "needed"` 和本人飞书通道 | 按 MR 单独复查，重开时只允许发 `<项目>.bug` 给原开发规则 |

1. 人工合并后，后台核对 MR 的来源、目标分支、审查提交和合并提交，触发测试部署，并在缺陷详情的评论区记录进度。流水线通过、实际检出版本匹配、版本接口返回该合并提交、测试页面返回 HTML 后，缺陷才进入 `RESOLVED`。
2. 打开缺陷详情可看到测试链接、复现步骤、预期结果、MR 和版本。报告人、经办人按项目身份去重。绑定账号收到一张可操作的飞书卡，其他相关人收到飞书项目详情评论的定向提醒。
3. 推荐在飞书项目详情将 `RESOLVED` 转为 `CLOSED` 或 `REOPENED`。验收未通过时在详情留言写明所见现象。绑定账号也可以直接点验收卡的两个按钮。后台读回实际状态，原生操作会同步结算旧卡；已关闭的缺陷仍定时检查重开情况。
4. 重新打开后，仍由本人经办的前端缺陷从最新验收分支新建返修工作区，随任务附上原 MR、缺陷详情、实际验收过的完整测试地址和合并提交号。返修使用该版本页面复现；若缺少测试公告等数据，在卡片输入框补充并提交文字。新提交再次走 CR、CI、人工合并和测试验收。重复轮询沿用同一个返修事件编号。

### 网页复验后的原卡同步

在验收配置中将 `retestDirectory` 指向可信浏览器验收程序的输出目录。在本人的飞书通道配置 `channels.feishu.updateOnlyRules` 中加入验收跟进规则的准确名称，例如 `["跟进飞书缺陷验收"]`。通道按中台保存的投递记录更新原消息；飞书拒绝更新时记录失败并按原消息重试。通道配置在后台服务重新加载后生效。

浏览器验收程序在实际点击完成后，将以下 JSON 写入临时文件，再在同一目录改名为 `feishu-<缺陷编号>-mr<MR编号>/results.json`。这个目录只交给可信的验收程序写入。下一次复验用新完成的报告覆盖旧报告，页面和版本取自对应 MR 的部署记录。浏览器程序在开始测试时从本轮任务资料读取 `verification.repairId`，原样写入报告；较早轮次迟到的报告会被跳过。启用此功能前已派发的历史事项可接入一次旧格式报告。

```json
{
  "issue": "12345",
  "mr": 8,
  "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "page": "https://test.example/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/help",
  "repairId": "本轮任务资料中的 verification.repairId",
  "testedAt": "2026-11-27T04:16:51.623Z",
  "fixture": "仅在本次浏览器会话中替换公告文字",
  "results": [
    { "scenario": "点击帮助链接", "expected": "https://example.org/Guide_(PC)", "actual": "https://example.org/Guide_(PC)" }
  ]
}
```

后台会发现已登记返修的复验报告，核对项目、缺陷、MR、版本、测试页、测试时间和每一项实际结果。通过后在详情备份复验结果，发一张由中台登记的验收卡。验收人在飞书项目关单后，下一次状态复查会更新同一张卡。首次接入时已经关单的报告只登记结果。重新打开且仍由本人经办的前端缺陷按新的返修轮次处理；上轮卡片和上次报告不能替本轮做决定。
