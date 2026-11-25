# Codeup + Flow：React / NestJS 自动交付

这是一套可选插件，不修改中台内核，也不替换 GitHub 的 `delivery`。新增项目只登记可信配置和检查命令；React、NestJS、monorepo 共用相同的任务、MR、审查、返修和发布流程。它支持中心版 `openapi-rdc.aliyuncs.com`；不把 GitLab API 当作 Codeup API 使用。

## 本批的实际验证范围

本地测试使用临时 Git、临时数据库、本机假 Codeup/Flow HTTP 服务和假开发/审查模型，实际经过开发入口、worktree、检查命令、提交、独立 Codex 审查、工作分支推送、Flow CI、MR 创建、人工回答恢复、合并、Flow 调用和版本核实。另有 CI/CR 失败返修、过期批准、来源验证、主干变化和不确定请求的行为测试。

没有云效令牌时，不声称已经真实创建 MR、配置云端门禁、合并或部署。模型联调、实际项目的完整检查、Flow 脚本及线上版本接口仍需真机验收。这里的 React/NestJS 测试验证编排与命令执行，不替代业务仓库测试。

## 可信配置

1. 在接单机器准备 `projects.json`，参照本目录示例。登记仓库、工作目录、worktree 根目录、检查命令和令牌的**环境变量名称**，不写令牌值。`serviceUserId` 是实际写入 CR/CI 检查的云效用户 ID。
2. 在业务仓库目标分支提交 `ops/codeup-delivery.json`，参照 `delivery.json`。CI pipeline 的 `0` 必须替换为真实的**检查流水线**编号。`checks[].writers` 填允许写入检查的用户 ID。
3. 前端采用 `react-ci.json`，NestJS 采用 `nestjs-ci.json`，按项目实际脚本调整。它们是模板，不能假设每个 React 项目都有相同命令。避免在 CI 使用 `lint --fix`、会写文件的 format 或生产数据库测试。
4. 在首选通道登记飞书答复人。每个 MR 都须批准当前提交和目标分支，才会请求 Codeup 合并。

审查、CI 和发布设置从目标分支的 Git 对象读取。MR 自己改的交付配置不能放宽本轮权限。开发可以执行业务代码；交付进程不检出、不运行 MR 代码，只提供只读文字差异给独立 Codex。

### 开发工作区的本地配置和迁移测试

在接单机的项目登记项中按需添加以下字段。已有项目可继续沿用原配置。

```json
{
  "localEnv": {
    "file": "/absolute/path/nestjs-api/.env",
    "keys": ["DATABASE_URL", "LOG_PATH"]
  },
  "mysqlMigration": {
    "binDir": "/usr/local/mysql/bin",
    "database": "app_migration_test",
    "command": ["npm", "run", "test:migration"]
  }
}
```

`file` 指向项目原目录或接单机上单独维护的 dotenv 文件。开发进程和 `commands` 只从该文件读取 `keys` 点名的变量，值通过子进程环境传入。文件留在原处，缺文件或缺变量会让本轮停下来。登记开发所需的最小权限配置；项目代码能读取传给它的变量。独立审查和 Flow 使用自己的环境。

`mysqlMigration` 适用于有 MySQL 8 服务端及客户端的 macOS 或 Linux 接单机。`command` 填项目实际存在的迁移测试命令，工作目录是本次 worktree；套件若需要开关，可用 `["/usr/bin/env", "SDK_PLATFORM_DB_TEST=1", ...]` 启动。普通检查通过后，接单程序每次用私有目录和 Unix socket 启动独立 MySQL，在其中创建指定名称的空库，再通过 `DATABASE_URL` 把测试连到该库。测试进程获得 PATH、HOME 和这份测试库连接。并发任务即使配置同一库名也各用自己的实例。检查结束后停库并清理临时目录，启动或测试失败会阻止提交和推送。

## 准备云效访问令牌（可在本地验收之后做）

在云效个人设置的个人访问令牌页面创建令牌。对应文档：https://help.aliyun.com/zh/yunxiao/developer-reference/obtain-personal-access-token 。需要：代码库及提交读取、MR 读写、运行检查读写、Flow 运行实例读写。不要用浏览器 Cookie，也不要把令牌放到需求、MR、Git 或日志中。

把令牌通过运行服务的环境注入，例如环境变量 `YUNXIAO_TOKEN`。终端 export 不代表 launchd 服务会继承它；应在私有启动包装脚本中读取权限为 0600 的本地 env 文件，再 exec 原来的启动程序。开发和 CR 子进程会移除云效及中台凭据环境变量，但这不是完整的操作系统级凭据隔离；生产环境仍应分别管理开发、检查和发布身份。

```sh
node plugins/codeup/doctor.ts /absolute/path/projects.json
node plugins/codeup/configure.ts /absolute/path/projects.json mac-mini /absolute/path/pending
```

`configure` 只生成 `rules.pending.json`、`intake.pending.json`，不修改在线配置。先核对其 sources、agents、rules，再合入现有 rules.json；将 intake 清单追加到现有飞书 tasks.projects，不覆盖其他项目。各仓库独立来源、固定执行器，规则决定目录和权限。通过现有 `key new source <名字>` 配置来源身份；Webhook URL 及 Secret 必须对应相同来源。

轮询规则是 Webhook 的替代入口。上线前可只启用一种，避免无用轮询。所有入口都用完整仓库路径加 MR 编号作为 subject，因此同一 MR 不会因两个入口分成不同事项。Webhooks 的 Secret 使用 `X-Codeup-Token`，API 则使用个人令牌，两者不是同一种密钥。

## Flow 检查流水线

新建独立的检查流水线，禁止包含 OSS 正式上传、主机部署、生产凭据或生产数据库访问。构建机使用 Node 24+；按业务需要安装对应 pnpm/npm。Flow 检查本次工作的源分支。开发先独立审查本地提交，CR 通过后推送该分支启动 CI。等待 CI 时结束本轮，由定时复查续接。两项检查通过后才创建 MR。缺交付设置、CI 流水线或交付凭据时保留本地提交并跳过自动交付。无效配置会报错。

在流水线内安装可信版本的本工具，固定到已审查的提交；从目标分支获得受信的 CI profile（不是直接执行 MR 修改后的 profile），再执行：

```sh
node /trusted/agent-autoloop/plugins/codeup/ci.ts /trusted/project/react-ci.json
```

交付插件启动 Flow 时传入 `AUTOLOOP_EXPECTED_SHA`。`ci.ts` 首先核对 `git rev-parse HEAD`，不匹配就失败；然后执行 profile 中的命令，失败立即停止。Flow 成功才由交付身份写回当前提交的 `autoloop-ci`。开发代码运行的构建任务不持有写检查结果或发布的令牌。

monorepo 可以先全量检查，确认正确后再按依赖图缩小范围；公共包、锁文件和构建配置变化需要覆盖所有受影响应用。发布目录由可信目标配置确定。第一版一项交付配置对应一个发布单元；跨多个活动或多个服务的 MR 应拆分交付，或人工协调，不推断任意活动参数和发布路径。

## Codeup 门禁和独立审查

保护 main：限制直接推送，要求当前提交的 `autoloop-ci`、`autoloop-cr` 通过，按需要开启人工评审、CodeOwner 和未解决评论卡点。只有实际核实这些配置及新提交会使旧检查失效后，才将 `protectedBranchVerified` 改为 true。

飞书点「批准当前提交」后，Autoloop 重新核对 head、base 和 Codeup 原生门禁，再请求合并。新提交或 main 变化会使批准失效。取消决定对当前 head/base 持久保存。原有 `autoMerge` 和 `sensitive` 配置仍可读取。所有 Codeup 合并均需本人批准。

独立 CR 使用临时只读快照、独立 Codex 会话，禁用记忆且不读取用户配置。发现问题交回原开发 worktree 返修。MR 描述只摘取原事件的 summary/detail，不复制任务上下文中的 answers、open、decided 等历史记录；超长摘要注明截短。MR 已经存在时保留原 MR，新提交重新检查。三轮 CR 后仍有问题，交回本人重新判断方案。同一提交不会仅通过重跑 CR 消除已报问题。CI 失败也触发返修；主干推进则先同步目标，再重测重审。合并使用 ff-only，不删除源分支。

## Flow 发布流水线

如果 Codeup 已配置 main 更新时自动部署，保留该流水线，并省略 Autoloop 的 `deploy`。需要让 Autoloop 主动启动发布并核实线上版本时，按实际环境配置下列字段。

```json
{
  "deploy": {
    "pipeline": "5280992",
    "env": { "PROJECT": "已核实的活动标识", "BUILD_ENV": "已核实的构建环境" },
    "health": { "url": "https://真实站点/活动/version.json", "field": "commit" }
  }
}
```

前端现有流水线可复用安装依赖、按 PROJECT 构建、OSS 上传、通知步骤，但必须增加检出提交校验、生成 `version.json`，并确认活动产物与 OSS 目录一一对应。MR 检查不使用正式发布流水线。预览环境可独立配置，不自动把开发分支上传到正式目录。

NestJS 的现有主机部署流水线可以复用，但部署脚本必须固定 `AUTOLOOP_EXPECTED_SHA` 对应代码/制品，不能无条件拉最新 main 并把它算作本次发布。建议检查环境构建并保存不可变制品，部署环境只安装该制品、重启服务，再提供含完整 commit 的健康接口。仅返回 hello 或 HTTP 200 的接口不能核实版本。

发布请求携带固定流水线编号、运行编号、预期提交和当时的健康配置，恢复时沿用同一绑定。main 随后改变流水线配置，不会把旧 run 当作新流水线结果。Flow 成功且线上版本精确匹配才通知完成。请求已发出但响应丢失时不自动再部署，交给本人核对运行记录。当前不自动执行 OSS/主机回滚；失败会阻断并通知。

CI 遇到 npm 或 pnpm 下载依赖的终止性网络超时，会为同一提交自动重跑一次。每次启动前保存唯一标识，若启动响应丢失，复查会从 Flow 的 BUILD_REMARK 找回该次运行。交付核对流水线、运行编号、实际仓库、源分支及完整检出 SHA 后才写成功。重跑仍超时或其他检查失败，会读取失败作业日志、脱敏后交回开发。

旧任务或持续无法确认启动结果时，可使用 `node plugins/codeup/reconcile.ts <projects.json> <项目> <MR编号> <ci|deploy> <运行编号>` 对账。CI 核对 Flow 源码记录与当前任务，发布按原有策略核对预期提交。

## 首次真实验收

依次验证：只读 API → CR 问题返修 → 工作分支 CI 成功/失败 → 创建 MR → 审批/取消/新提交失效 → 合并 → 测试环境发布 → 版本核实。保留任务、完整提交、MR、Flow run 和日志证据，再开放生产自动发布。没有这些记录时不要标记已上线。

官方契约：

- https://help.aliyun.com/zh/yunxiao/developer-reference/service-access-point-domain
- https://help.aliyun.com/zh/yunxiao/developer-reference/createchangerequest-create-merge-request
- https://help.aliyun.com/zh/yunxiao/developer-reference/createcheckrun
- https://help.aliyun.com/zh/yunxiao/developer-reference/createpipelinerun
- https://help.aliyun.com/zh/yunxiao/user-guide/webhooks-settings
