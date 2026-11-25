import { createHash } from "node:crypto";
import { ModelsUnavailable } from "../command/model.ts";

export const hash = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex").slice(0, 40);
type ModelChoice = { exclude?: string; selected?: (name: string) => void };
export type Model = (name: string, operation: string, data: unknown, choice?: ModelChoice) => Promise<unknown>;
type Plan = { plan: string; risks: string[]; questions: string[]; singleReviewer?: true };
function words(value: unknown, limit = 10): string[] {
  if (!Array.isArray(value) || value.length > limit || !value.every((s) => typeof s === "string" && s.length <= 500))
    throw new Error("模型返回的条目格式无效");
  return value;
}
function plan(value: unknown): Plan {
  const v = value as Plan;
  if (!v || typeof v.plan !== "string" || !v.plan.trim() || v.plan.length > 3000)
    throw new Error("模型没有给出有效方案");
  return { plan: v.plan, risks: words(v.risks), questions: words(v.questions) };
}
export async function deliberate(task: unknown, call: Model, reviewer = "gemini", allowSingle = false) {
  const result = (await call("dsh", "triage", task)) as { complexity: string };
  const complexity = result?.complexity;
  if (complexity === "dsh") return plan(await call("dsh", "review", task));
  if (complexity === "reviewer" || complexity === "gemini") return plan(await call(reviewer, "review", task));
  if (complexity !== "dual") throw new Error("任务复杂度无效");
  if (!allowSingle && reviewer === "dsh") throw new Error("双审需要配置另一个审查模型");
  let independent: Plan[];
  if (allowSingle) {
    let firstName = "dsh";
    const first = plan(await call("dsh", "review", task, { selected: (name) => (firstName = name) }));
    try {
      independent = [first, plan(await call(reviewer, "review", task, { exclude: firstName }))];
    } catch (error) {
      if (error instanceof ModelsUnavailable) return { ...first, singleReviewer: true as const };
      throw error;
    }
  } else {
    independent = (await Promise.all([call("dsh", "review", task), call(reviewer, "review", task)])).map(plan);
  }
  const final = plan(await call(reviewer, "synthesis", { task, reviews: independent }));
  final.questions = [...new Set([...independent.flatMap((r) => r.questions), ...final.questions])];
  return final;
}

export type Bug = {
  id: string;
  revision: string;
  project: string;
  summary: string;
  detail?: string;
  link?: string;
  kind?: string;
};
export type BugProvider = {
  list(): Promise<Bug[]>;
  claim(bug: Bug, key: string): Promise<boolean>;
  ack?(key: string, event: number): Promise<void>;
};
function bugLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 500) return url.href;
  } catch {
    /* Unusable links do not block a bug. */
  }
}
export async function collectBugs(provider: BugProvider, project: string, source: string) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(project)) throw new Error("Bug 项目未登记");
  const events = [];
  for (const b of await provider.list()) {
    if (
      b.project !== project ||
      (b.kind && b.kind !== "bug") ||
      typeof b.summary !== "string" ||
      !b.summary.trim() ||
      typeof b.id !== "string" ||
      !b.id ||
      typeof b.revision !== "string" ||
      !b.revision
    )
      continue;
    const id = hash([source, project, b.id, b.revision]);
    if (!(await provider.claim(b, id))) continue;
    const link = bugLink(b.link);
    events.push({
      id,
      type: `${project}.bug`,
      subject: `bug-${hash([source, project, b.id])}`,
      summary: b.summary.slice(0, 200),
      detail: String(b.detail ?? "").slice(0, 4000),
      ...(link && { link }),
    });
  }
  return events;
}

export type Care = { enabled: boolean; timezone: string; quietStart: number; quietEnd: number };
export function care(config: Care, now: string) {
  if (!config.enabled) return false;
  const { timezone, quietStart, quietEnd } = config;
  if (![quietStart, quietEnd].every((x) => Number.isInteger(x) && x >= 0 && x <= 23)) throw new Error("免打扰时段无效");
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(new Date(now)),
  );
  return (
    quietStart === quietEnd ||
    (quietStart < quietEnd ? hour < quietStart || hour >= quietEnd : hour < quietStart && hour >= quietEnd)
  );
}
