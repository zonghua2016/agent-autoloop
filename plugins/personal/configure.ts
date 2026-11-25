import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type Registration = {
  config: string;
  cwd: string;
  worker: string;
  project?: string;
  inputSource?: string;
  outputSource?: string;
  developer?: string;
  feedbackSource?: string;
  feedbackType?: string;
  developerEmits?: { source: string; types: string[] };
  chron?: Partial<
    Record<"day" | "month" | "dream" | "concepts" | "improve" | "morning" | "巡检" | "care" | "bugs" | "prune", string>
  >;
  channels?: string[];
};

export function configure(p: Registration, toolkit: string, node: string) {
  if (!isAbsolute(p.config) || !isAbsolute(p.cwd) || !p.worker)
    throw new Error("请登记配置和工作目录的绝对路径、接单机器");
  if (p.project && !/^[a-z][a-z0-9-]{0,30}$/.test(p.project)) throw new Error("项目编号无效");
  const tag = p.project ?? "private";
  const source = p.outputSource ?? `personal-${tag}`;
  const sources = { [source]: { name: `个人 Agent · ${tag}` } };
  const agents: Record<string, object> = {};
  const rules: object[] = [];
  function agent(operation: string, args: string[] = []) {
    const id = `personal-${tag}-${operation === "巡检" ? "check" : operation}`;
    agents[id] = {
      name: `个人 Agent ${operation}`,
      worker: p.worker,
      use: "command",
      command: [node, join(toolkit, "plugins/personal/run.ts"), p.config, operation, ...args],
    };
    return id;
  }
  const channels = p.channels?.length ? { channels: p.channels } : {};
  if (p.project && p.developer && p.inputSource) {
    rules.push(
      {
        name: `${tag} 需求论证`,
        when: { source: p.inputSource, types: ["feature", "change", "bug"].map((k) => `${tag}.${k}`) },
        to: agent("plan", [p.project]),
        cwd: p.cwd,
        parallel: 2,
        ...channels,
        emits: { source, types: [`${tag}.ready`] },
      },
      {
        name: `${tag} 论证通过后开发`,
        when: { source, types: [`${tag}.ready`] },
        to: p.developer,
        tell: "always",
        cwd: p.cwd,
        parallel: 1,
        ...channels,
        ...(p.developerEmits && { emits: p.developerEmits }),
      },
    );
  }
  if (p.feedbackSource && p.feedbackType)
    rules.push({
      name: `${tag} 归档任务反馈`,
      when: { source: p.feedbackSource, types: [p.feedbackType] },
      to: agent("feedback"),
      cwd: p.cwd,
      ...channels,
    });
  for (const [op, cron] of Object.entries(p.chron ?? {})) {
    if (op === "bugs" && !p.project) throw new Error("Bug 轮询需要明确的项目");
    rules.push({
      name: `${tag} ${op}`,
      when: { cron },
      to: agent(op, op === "bugs" ? [p.project!] : []),
      cwd: p.cwd,
      ...channels,
      ...(op === "bugs" && { emits: { source: p.inputSource ?? source, types: [`${tag}.bug`] } }),
    });
  }
  return { sources, agents, rules };
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const registration = JSON.parse(readFileSync(process.argv[2], "utf8"));
  console.log(
    JSON.stringify(configure(registration, resolve(import.meta.dirname, "../.."), process.execPath), null, 2),
  );
}
