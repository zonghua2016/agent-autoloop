import { dirname, isAbsolute, join } from "node:path";

export type Settings = {
  ci?: { pipeline: string; env: Record<string, string> };
  checks: { name: string; writers: string[] }[];
  sensitive: string[];
  review: { model: string; effort: string; points: string };
  autoMerge: boolean;
  protectedBranchVerified: boolean;
  deploy?: { pipeline: string; env: Record<string, string>; health: { url: string; field: string } };
};
export type Project = {
  id: string;
  organization: string;
  repository: string;
  git: string;
  cwd: string;
  workRoot: string;
  branch: string;
  tokenEnv: string;
  serviceUserId: string;
  api: string;
  settingsPath: string;
  codex: string;
  developmentModel: string;
  personalFeedback?: boolean;
  localEnv?: { file: string; keys: string[] };
  mysqlMigration?: { binDir: string; database: string; command: string[] };
  commands: string[][];
};
const words = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && !!x);
export function projectSettings(raw: unknown): Settings {
  const x = raw as Settings;
  const bad = () => {
    throw new Error("Codeup 交付设置无效：检查名称与写入者、审查规则和发布版本接口必须明确配置");
  };
  if (
    !x ||
    !Array.isArray(x.checks) ||
    !x.checks.length ||
    !x.checks.every((c) => c && typeof c.name === "string" && words(c.writers) && c.writers.length)
  )
    bad();
  if (
    !words(x.sensitive) ||
    !x.review ||
    !x.review.model ||
    !x.review.points ||
    !["low", "medium", "high", "xhigh"].includes(x.review.effort)
  )
    bad();
  if (typeof x.autoMerge !== "boolean" || typeof x.protectedBranchVerified !== "boolean") bad();
  if (
    x.ci &&
    (!/^[1-9]\d*$/.test(x.ci.pipeline) || !x.ci.env || !Object.values(x.ci.env).every((v) => typeof v === "string"))
  )
    bad();
  if (x.deploy) {
    if (
      !/^[1-9]\d*$/.test(x.deploy.pipeline) ||
      !x.deploy.env ||
      !Object.values(x.deploy.env).every((v) => typeof v === "string")
    )
      bad();
    const url = new URL(x.deploy.health?.url);
    if (url.protocol !== "https:" || url.username || url.password || !x.deploy.health.field) bad();
  }
  return x;
}
export function project(raw: unknown): Project {
  const input = raw as Project;
  const x = Object.assign(
    {
      branch: "main",
      api: "https://openapi-rdc.aliyuncs.com",
      tokenEnv: "YUNXIAO_TOKEN",
      settingsPath: "ops/codeup-delivery.json",
      codex: "codex",
    },
    input,
  );
  if (typeof x.git === "string" && x.repository === undefined)
    x.repository = new URL(x.git).pathname.slice(1).replace(/\.git$/, "");
  if (typeof x.cwd === "string" && typeof x.id === "string" && x.workRoot === undefined)
    x.workRoot = join(dirname(x.cwd), ".autoloop-worktrees", x.id);
  if (
    !x ||
    typeof x.id !== "string" ||
    !/^[a-z][a-z0-9-]*$/.test(x.id) ||
    typeof x.organization !== "string" ||
    !/^[\w-]+$/.test(x.organization) ||
    !x.repository ||
    typeof x.cwd !== "string" ||
    !isAbsolute(x.cwd) ||
    typeof x.workRoot !== "string" ||
    !isAbsolute(x.workRoot)
  )
    throw new Error("Codeup 项目登记无效");
  const api = new URL(x.api),
    git = new URL(x.git);
  if (
    api.protocol !== "https:" ||
    api.hostname !== "openapi-rdc.aliyuncs.com" ||
    api.username ||
    api.password ||
    api.pathname !== "/" ||
    api.search ||
    api.hash
  )
    throw new Error("Codeup API 必须使用中心版 HTTPS 接入点 openapi-rdc.aliyuncs.com");
  if (
    git.protocol !== "https:" ||
    git.hostname !== "codeup.aliyun.com" ||
    git.username ||
    git.password ||
    git.search ||
    git.hash
  )
    throw new Error("项目必须登记无凭据的 Codeup HTTPS Git 地址");
  if (
    !/^[A-Z][A-Z0-9_]+$/.test(x.tokenEnv) ||
    !x.branch ||
    !/^ops\/[\w./-]+\.json$/.test(x.settingsPath) ||
    x.settingsPath.includes("..")
  )
    throw new Error("Codeup 配置路径或凭据引用无效");
  if (
    !x.codex ||
    !x.developmentModel ||
    !Array.isArray(x.commands) ||
    !x.commands.length ||
    !x.commands.every((c) => words(c) && c.length)
  )
    throw new Error("项目缺少开发工具或检查命令");
  if (x.localEnv !== undefined) {
    const e = x.localEnv;
    if (
      !e ||
      typeof e.file !== "string" ||
      !isAbsolute(e.file) ||
      !words(e.keys) ||
      !e.keys.length ||
      !e.keys.every(
        (key) =>
          /^[A-Z_][A-Z0-9_]*$/.test(key) && !/^(AGENT_AUTOLOOP_|CODEUP_|YUNXIAO_)/.test(key) && key !== x.tokenEnv,
      )
    )
      throw new Error("本地环境配置需要绝对文件路径和允许传给开发进程的项目变量名");
  }
  if (x.mysqlMigration !== undefined) {
    const m = x.mysqlMigration;
    if (
      !m ||
      typeof m.binDir !== "string" ||
      !isAbsolute(m.binDir) ||
      typeof m.database !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(m.database) ||
      !words(m.command) ||
      !m.command.length
    )
      throw new Error("MySQL 迁移测试需要本机工具目录、测试库名和检查命令");
  }
  return x;
}
