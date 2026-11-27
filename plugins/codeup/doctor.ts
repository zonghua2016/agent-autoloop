// Inspect the target branch and the operator's installed configuration without running project code.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { project, projectSettings, type Project } from "./settings.ts";
import { git, ref, remoteHead } from "./git.ts";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { Codeup } from "./api.ts";

export function wiring(p: Project, rules: any, config: any, registry?: string): string[] {
  const issues: string[] = [];
  const source = "codeup-" + p.id;
  if (rules.sources?.[source]?.adapter !== "codeup") issues.push("rules.sources." + source);
  const channels = Object.entries<any>(config.channels ?? {}).filter(([, c]) => c.use === "feishu-tasks");
  const entries = channels.flatMap(([channel, c]) =>
    (c.tasks?.projects ?? []).filter((t: any) => t.id === p.id).map((t: any) => ({ channel, t })),
  );
  if (!entries.length) issues.push("飞书 tasks.projects 缺少 " + p.id);
  for (const { channel, t } of entries) {
    if (t.verifyBranch !== p.branch) issues.push(channel + " 的 verifyBranch 应为 " + p.branch);
    for (const kind of ["feature", "change", "bug", "verify"]) {
      const type = t.events?.[kind],
        to = source + (kind === "verify" ? "-verify" : "-develop");
      const agent = rules.agents?.[to],
        command = agent?.command;
      if (
        agent?.use !== "command" ||
        !Array.isArray(command) ||
        command.at(-1) !== p.id ||
        (registry && command.at(-2) !== resolve(registry)) ||
        typeof command[1] !== "string" ||
        basename(command[1]) !== (kind === "verify" ? "verify.ts" : "develop.ts")
      )
        issues.push("rules.agents." + to);
      if (
        !type ||
        !rules.rules?.some(
          (r: any) =>
            r.to === to && r.cwd === p.cwd && r.when?.source === "feishu-chat" && r.when.types?.includes(type),
        )
      )
        issues.push(channel + " 的 " + kind + " 缺少指向 " + to + " 的项目规则");
    }
  }
  const deliver = source + "-deliver",
    develop = source + "-develop";
  const receiver = rules.agents?.[deliver];
  if (
    !(
      receiver?.use === "codeup" ||
      (receiver?.use === "command" &&
        typeof receiver.command?.[1] === "string" &&
        basename(receiver.command[1]) === "run.ts")
    ) ||
    receiver.command?.at(-1) !== p.id ||
    (registry && receiver.command?.at(-2) !== resolve(registry))
  )
    issues.push("rules.agents." + deliver);
  for (const [type, to, emitter] of [
    ["delivery.requested", deliver, develop],
    ["repair.requested", develop, deliver],
  ]) {
    if (
      !rules.rules?.some(
        (r: any) => r.to === to && r.cwd === p.cwd && r.when?.source === source && r.when.types?.includes(type),
      )
    )
      issues.push("缺少路由 " + type + " → " + to);
    if (
      !rules.rules?.some(
        (r: any) => r.to === emitter && r.cwd === p.cwd && r.emits?.source === source && r.emits.types?.includes(type),
      )
    )
      issues.push(emitter + " 缺少 " + type + " 事件许可");
  }
  return [...new Set(issues)];
}

if (import.meta.main) {
  const {
    values,
    positionals: [file, ...extra],
  } = parseArgs({
    allowPositionals: true,
    options: { home: { type: "string" }, project: { type: "string" }, online: { type: "boolean" } },
  });
  if (extra.length) throw new Error("只支持一个项目登记文件");
  if (!file) throw new Error("用法：doctor.ts projects.json [--project 项目] [--home 中台目录] [--online]");
  const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
  const registered = read(file) as Project[];
  const rows = registered.filter((row) => !values.project || row.id === values.project);
  if (!rows.length || new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error("项目未登记或重复登记");
  for (const row of rows) {
    let temporary: string | undefined;
    try {
      const p = project(row),
        issues = [];
      const token = process.env[p.tokenEnv];
      if (!token) issues.push("缺少环境变量 " + p.tokenEnv);
      if (!p.serviceUserId) issues.push("缺少 serviceUserId");
      const home = values.home;
      if (home) issues.push(...wiring(p, read(join(home, "rules.json")), read(join(home, "config.json")), file));
      const online = values.online;
      const head = online
        ? remoteHead(p, p.branch)
        : git(p.cwd, "rev-parse", "--verify", ref(p.branch).replace("refs/heads/", "refs/remotes/origin/"));
      if (online) {
        temporary = mkdtempSync(join(tmpdir(), "codeup-doctor-"));
        git(temporary, "init", "--bare");
        git(temporary, "fetch", "--depth=1", "--no-tags", p.git, ref(p.branch));
        if (git(temporary, "rev-parse", "FETCH_HEAD") !== head) throw new Error("远端分支已更新，请重新核对");
      }
      const settings = projectSettings(JSON.parse(git(temporary ?? p.cwd, "show", head + ":" + p.settingsPath)));
      if (!settings.ci) issues.push("目标分支未配置 ci.pipeline");
      if (online && token) {
        const api = new Codeup(p, token);
        const repo = await api.call(api.repo());
        if (!repo?.id) throw new Error("未读到云效仓库");
        if (settings.ci) await api.call(api.flow(settings.ci.pipeline) + "?page=1&perPage=1");
      }
      console.log(p.id, p.branch, head.slice(0, 12), online ? "远端分支已核对" : "使用本地 origin 跟踪分支", ...issues);
      if (issues.length) process.exitCode = 2;
    } catch (error) {
      console.error(
        row.id,
        "待核对：",
        error instanceof SyntaxError
          ? "配置文件不是有效 JSON"
          : error instanceof Error && "stderr" in error
            ? "无法读取本地仓库、目标提交或交付设置"
            : (error as Error).message,
      );
      process.exitCode = 2;
    } finally {
      if (temporary) rmSync(temporary, { recursive: true, force: true });
    }
  }
}
