// Produce reviewable rule fragments; never change an online install or cloud permissions implicitly.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { project, type Project } from "./settings.ts";

export function configuration(projects: Project[], registry: string, worker: string, toolkit: string, node: string) {
  const sources: Record<string, object> = {},
    agents: Record<string, object> = {},
    rules: object[] = [];
  const intake = [];
  for (const p of projects) {
    const source = `codeup-${p.id}`,
      developer = `${source}-develop`,
      delivery = `${source}-deliver`,
      poll = `${source}-poll`;
    sources[source] = { name: `Codeup ${p.id}`, adapter: "codeup" };
    agents[developer] = {
      name: `Codex 开发 ${p.id}`,
      worker,
      use: "command",
      command: [node, join(toolkit, "plugins/codeup/develop.ts"), registry, p.id],
      timeout: 90,
    };
    agents[delivery] = { name: `Codeup 交付 ${p.id}`, worker, use: "codeup", command: [registry, p.id], timeout: 35 };
    agents[poll] = {
      name: `Codeup 轮询 ${p.id}`,
      worker,
      use: "command",
      command: [node, join(toolkit, "plugins/codeup/poll.ts"), registry, p.id],
    };
    const events = Object.fromEntries(["feature", "change", "bug"].map((kind) => [kind, `${p.id}.${kind}`]));
    const verify = `${source}-verify`;
    agents[verify] = {
      name: `验收 ${p.id}`,
      worker,
      use: "command",
      command: [node, join(toolkit, "plugins/codeup/verify.ts"), registry, p.id],
      timeout: 90,
    };
    intake.push({
      id: p.id,
      name: p.id,
      aliases: [],
      events: { ...events, verify: `${p.id}.verify` },
      verifyBranch: p.branch,
    });
    rules.push(
      {
        name: `${p.id} 飞书验收`,
        when: { source: "feishu-chat", types: [`${p.id}.verify`] },
        to: verify,
        cwd: p.cwd,
        parallel: 1,
        tell: "never",
      },
      {
        name: `${p.id} 飞书开发`,
        when: { source: "feishu-chat", types: Object.values(events) },
        to: developer,
        cwd: p.cwd,
        prompt: "按可信项目登记处理已确认开发任务",
        group: `${p.id}-development`,
        emits: { source, types: ["delivery.requested"] },
        tell: "needed",
      },
      {
        name: `${p.id} 自动返修`,
        when: { source, types: ["repair.requested"] },
        to: developer,
        cwd: p.cwd,
        prompt: "沿用原开发任务修复当前 MR",
        group: `${p.id}-repair`,
        emits: { source, types: ["delivery.requested"] },
        tell: "needed",
      },
      {
        name: `${p.id} 交付`,
        when: { source, types: ["delivery.requested", "merge_request.*"] },
        to: delivery,
        cwd: p.cwd,
        prompt: "按目标分支可信设置完成交付",
        group: `${p.id}-delivery`,
        parallel: 1,
        emits: { source, types: ["repair.requested", ...(p.personalFeedback ? ["delivery.feedback"] : [])] },
        tell: "needed",
      },
      {
        name: `${p.id} 查看 MR`,
        when: { cron: "*/2 * * * *" },
        to: poll,
        cwd: p.cwd,
        prompt: "读取本项目待交付 MR",
        emits: { source, types: ["delivery.requested"] },
        tell: "never",
      },
    );
  }
  return { rules: { sources, agents, rules }, intake };
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const [registry, worker, output] = process.argv.slice(2);
  if (!registry || !worker || !output) throw new Error("用法：configure.ts <projects.json> <worker名字> <输出目录>");
  const values = JSON.parse(readFileSync(registry, "utf8"));
  const generated = configuration(
    values.map(project),
    resolve(registry),
    worker,
    resolve(import.meta.dirname, "../.."),
    process.execPath,
  );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  writeFileSync(join(output, "rules.pending.json"), JSON.stringify(generated.rules, null, 2) + "\n");
  writeFileSync(join(output, "intake.pending.json"), JSON.stringify(generated.intake, null, 2) + "\n");
  console.log("已生成规则与飞书项目清单；未修改在线规则、权限或触发云效。");
}
