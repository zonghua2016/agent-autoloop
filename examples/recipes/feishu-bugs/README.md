# 飞书 Bug 表自动处理

从固定的飞书数据表领取 `所属项目` 等于登记项目且 `状态` 为 `待修复` 的 Bug。用独立工作树修复，CR 与 CI 通过后回填 MR，由负责人在 Codeup 确认合并。合并目标固定为 `autoloop/acceptance`。

## 配置

配置包括 `database`、`cli`、`base`、`table`、`url`、`project`、`registry`、`target`、`records`。路径 `database`、`cli`、`registry` 用绝对路径。应用须能读取和更新这张表，由 CLI 使用已有的应用凭据。`records` 保留旧版白名单模式。新增以下选项：

```json
{
  "discover": true,
  "testDeployment": {
    "pipeline": "1234",
    "module": "kefu",
    "health": "http://beta.example.com/kefu/{commit}/version.json",
    "page": "http://beta.example.com/kefu/{commit}/index.html",
    "versionField": "commit"
  },
  "notifyUsers": ["ou_example"]
}
```

- `discover` 分页查询指定项目。启用后，现有和未来符合条件的待修复记录都会被领取。逐条核对项目和当前状态，首次领取冻结需求。同一条记录只对应一个修复任务。需要再次修复时新建记录。
- `testDeployment` 应指向隔离的测试流水线。测试作业在上传前校验检出 SHA 等于 `AUTOLOOP_EXPECTED_SHA`，且 `AUTOLOOP_TARGET_ENV` 为 `test`。Flow 实际检出、运行结果和测试版本入口都匹配才写成 `待验收`。如果配置了 `page`，还会确认页面可用并把链接写入表格和通知。测试地址支持 HTTP/HTTPS，`{commit}` 会替换成完整合并 SHA。探测不发送凭据或跟随跳转，正式发布继续要求 HTTPS。省略部署配置时仍回填「已合并，等待测试部署配置」。旧版任务如果没有保存审查和 CI 证明，不追溯部署。
- `notifyUsers` 是允许接收消息的飞书 Open ID。MR 创建且同一提交的独立 CR、CI 均通过后，在下一轮轮询私聊记录中的 `负责人`，请其手动确认合并。发送前重新检查 MR 仍开放且非草稿、源和目标提交未变化、可信 CR/CI 及实际 CI 运行均成功，再回读表格的项目、状态和人员。提醒包含 Bug 记录、MR、CR 检查页和具体 CI 运行链接，以及核实的提交和目标分支。合并提醒不要求配置测试部署；系统不会替负责人合并。
- 测试部署验证通过后，验收通知私聊记录中的 `验收人`；`已关闭` 通知私聊记录中的 `提交人`、`负责人`、`验收人`。只发送给各阶段人员字段与 `notifyUsers` 的交集，字段重复人员合并为一个收件人。没有已授权的负责人时在本机提示，不自行扩大授权。机器人需要应用身份发送消息权限及相应的可用范围。省略名单时保持安静，只回填表格。

表中人员字段使用人员类型。`状态` 使用 `待修复`、`修复中`、`待验收`、`已关闭`。验收后由人在表里改为 `已关闭`。在验收前改为其他状态会停止下一轮操作，已经提交的工作不会被强制取消。回填使用 `修复说明` 和 `代码或 MR 链接`。第一次领取时保存原有修复说明，此后该列由自动化维护。

## 运行与恢复

客服 beta 试点使用 [kefu-beta-flow.yml](kefu-beta-flow.yml)。通过云效 CreatePipeline 接口提交该模板，替换代码库、现有 Codeup/OSS 服务连接标识、桶和地域。凭据由服务连接提供。构建沿用项目 test 参数，上传目标固定到 `web/standoff2/autoloop-preview/kefu/flow/<完整提交>`。定义使用 Autoloop 传入的提交与环境变量，无代码源自动触发。流水线构建单个子项目时设置 `module`。只有模块与其相同的 Bug 会部署，支持 `kefu · 公告滚动条` 这样的细分写法；其他模块仍回填合并结果。

```text
node plugins/feishu-bugs/run.ts /absolute/config.json poll
node plugins/feishu-bugs/run.ts /absolute/config.json work
```

`poll` 使用 `Bug 表试点领取` 规则的 `when.cron`（试点为 `*/5 * * * *`，每 5 分钟）和已有可信来源发出 `bitable.bug.ready`。`work` 消费该来源和类型。两条规则设 `parallel: 1` 并与项目开发使用同一个组，保证同一台中台上按顺序操作。`work` 不发交付事件，通过定时复查继续等待 CI。两条规则使用本地通道，避免把排错卡自动发到飞书，业务通知由表格人员字段和收件人配置决定。保持该验收项目的普通交付规则暂停，避免同一 MR 同时被通用交付路径消费。

Codeup 登记检查时要求源提交已关联 MR。试点先做独立 CR，推送后创建 MR，再登记同一提交的 CR 检查和 CI。只有两项通过后才确认合并。部署和通知状态保存在本机 SQLite。表格回写失败会在后续轮询重试。部署启动响应丢失时到云效核对运行记录，插件不会重复启动。飞书通知保存回执 ID，只在飞书去重期限内以同一键重试，超期且未确认的消息在本机状态中提示人工查验。请保留本机配置和数据库，只用一台中台消费该配置。

合并提醒的去重键绑定 Bug、MR、已核实的源/目标提交和每位收件人。发送意图先持久化，成功回执跨进程保存，重复轮询不重复发送；丢响应在 55 分钟内沿用同一键重试，重试也重新核对当前 MR/检查。已合并或关闭的 MR、已进入待验收或关闭的 Bug 不补发合并提醒。既有验收、关单的去重键不变，历史发送回执继续有效。
