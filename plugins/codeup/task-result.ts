import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
// Public query contract: callers do not depend on this plugin's storage schema.
export type DeliveryResult = {
  title: string;
  text: string;
  verified?: string;
  deploymentChecked?: true;
  stage?: "review" | "ci" | "repair" | "mr" | "approval" | "blocked" | "shipping" | "complete";
};
export type TaskQuery = { event: number; message: string; sender: string; project: string; type: string };
import { Codeup } from "./api.ts";
import type { State } from "./delivery.ts";
import { verifyCheckout } from "./flow-ci.ts";
import { project, type Project } from "./settings.ts";

export type ResultConfig = { registry: string; envFile: string; source: string };
import { deliveryRecord, type WorkRecord as Work } from "./query.ts";
const mrUrl = (p: Pick<Project, "git">, number: number) => p.git.replace(/\.git$/, "") + "/change/" + number;

export function pausedAnswer(state: unknown, answer: unknown) {
  return (
    state === "nothing" &&
    typeof answer === "string" &&
    /^(?:先不动了|先暂停|暂停|暂不处理|先不做了)[。！!]?$/u.test(answer.trim())
  );
}

export function mergedResult(
  p: Pick<Project, "git" | "branch" | "serviceUserId">,
  work: Work,
  state: State,
  mr: any,
  checks: any[],
  run: any,
): DeliveryResult {
  const head = state.merged!;
  if (
    !/^[a-f0-9]{40}$/.test(head) ||
    mr.mergedRevision !== head ||
    mr.status !== "MERGED" ||
    mr.localId !== work.mr ||
    !mr.sourceProjectId ||
    mr.sourceProjectId !== mr.targetProjectId ||
    mr.sourceBranch !== work.branch ||
    mr.targetBranch !== p.branch
  )
    throw new Error("MR 与任务记录不一致");
  const conclusion = (name: string) => {
    const check = checks
      .filter((c) => c.name === name && c.headSha === head && String(c.writer?.id) === p.serviceUserId)
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (check?.status !== "completed") return "待核实";
    return check.conclusion === "success" ? "通过" : "未通过";
  };
  let ci = conclusion("autoloop-ci");
  const cr = conclusion("autoloop-cr");
  if (state.ciRun || state.ciPipeline) {
    try {
      if (!state.ciPipeline || !state.ciRun) throw new Error();
      verifyCheckout(run, state.ciPipeline, state.ciRun, p.git, work.branch, head);
      if (ci === "通过" && run.status !== "SUCCESS") ci = "待核实";
    } catch {
      ci = "待核实";
    }
  }
  const pipeline = state.ciPipeline && state.ciRun ? `（运行 #${state.ciRun}）` : "";
  const shipping = !!(state.deployExpected || state.deploySettings?.deploy || state.deployIntent || state.deployment);
  const flow = state.deployment ? "Flow #" + state.deployment + " · " : "";
  const deployment = state.live
    ? "\n" + flow + "部署版本已核实：" + head
    : shipping
      ? "\n" + flow + "部署结果待核实"
      : "";
  return {
    deploymentChecked: true,
    title: state.live ? "部署版本已核实" : "已合并",
    text: `MR !${work.mr} 已合并到 ${p.branch}\n${mrUrl(p, work.mr!)}\nCI ${ci}${pipeline}\n独立 CR ${cr}\n提交 ${head}${deployment}`,
    ...(ci !== "待核实" &&
      cr !== "待核实" && {
        verified: proofKey(p, work, state),
        stage: shipping && !state.live ? "shipping" : "complete",
      }),
  };
}

function proofKey(p: Pick<Project, "git" | "branch" | "serviceUserId">, work: Work, state: State) {
  return JSON.stringify([
    p.git,
    p.branch,
    p.serviceUserId,
    work.mr,
    work.branch,
    state.merged,
    state.ciPipeline,
    state.ciRun,
    state.deployExpected,
    state.deploySettings?.deploy?.pipeline,
    state.deployIntent,
    state.deployment,
    state.live,
  ]);
}

export function codeupTaskResults(
  config: ResultConfig,
  home: string,
  log: (message: string) => void,
  connection?: { url: string; sourceKey: string },
): (task: TaskQuery, previous?: DeliveryResult) => Promise<DeliveryResult | undefined> {
  const projects = new Map<string, Project>(
    JSON.parse(readFileSync(config.registry, "utf8")).map((row: unknown) => {
      const p = project(row);
      return [p.id, p];
    }),
  );
  const retryAt = new Map<string, number>();
  return async (task, previous) => {
    const p = projects.get(task.project);
    if (!p) return;
    const subject = "feishu-" + task.message,
      key = p.id + ":" + subject;
    const pending = { title: "交付结果待核实", text: "尚未核实最终交付记录。" };
    if ((retryAt.get(key) ?? 0) > Date.now() && previous?.title === "已合并" && !previous.verified) return previous;
    try {
      const localConfig = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
      if (!connection || !localConfig.owner) return pending;
      const get = async (path: string, key: string) => {
        const response = await fetch(new URL(path, connection.url), {
          headers: { authorization: "Bearer " + key },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error("中台状态暂不可读");
        return response.json();
      };
      const [outcome, snapshot] = await Promise.all([
        get(`/v1/events/${task.event}`, connection.sourceKey),
        get("/v1/state", localConfig.owner),
      ]);
      if (outcome.event !== task.event) return pending;
      const allCards = [...snapshot.cards, ...snapshot.recentCards];
      const about = (card: any) => {
        try {
          return JSON.parse(card.about);
        } catch {
          return {};
        }
      };
      const found = deliveryRecord(home, p.id, subject);
      if (!found) return { title: "已派发", text: "等待开发交付记录。" };
      const { work, state } = found;
      if (!work.mr) {
        let page = snapshot;
        let last: any;
        do {
          last = page.runs
            .filter((run: any) => run.events?.some((event: any) => event.subject === subject))
            .sort((a: any, b: any) => b.id - a.id)[0];
          if (last || !page.hasMore) break;
          page = await get(`/v1/state?before=${page.nextBefore}`, localConfig.owner);
        } while (true);
        if (!last) return pending;
        const facts = await get(`/v1/runs/${last.id}/why`, localConfig.owner);
        const changes = facts.flatMap((fact: any) => fact.changes ?? []);
        const rows = new Map<string, any>();
        for (const change of changes) rows.set(change.table + ":" + change.key, change.row);
        const run = rows.get("runs:" + last.id);
        if (!run || run.lane !== subject) return pending;
        const eventIds = new Set(
          [...rows.entries()]
            .filter(([key, row]) => key.startsWith("run_events:") && row?.run_id === last.id)
            .map(([, row]) => row.event_id),
        );
        const answered = [...rows.entries()]
          .filter(([key]) => key.startsWith("cards:"))
          .map(([, row]) => row)
          .sort((a, b) => (b?.answer_event ?? 0) - (a?.answer_event ?? 0))
          .find(
            (card) =>
              card &&
              eventIds.has(card.answer_event) &&
              card.lane === subject &&
              card.kind === "ask" &&
              card.state === "done" &&
              card.by === task.sender &&
              card.choice == null &&
              about(card).kind === "codeup-development" &&
              about(card).project === p.id &&
              about(card).work === key,
          );
        const context = { state: run.state, answer: answered?.answer };
        if (pausedAnswer(context.state, context.answer))
          return { title: "已暂停", text: `未创建 MR。\n发起人回复：${context.answer}` };
        const gate = work.gate;
        if (gate?.repairData) return { title: "等待返修", text: gate.repairData.text.slice(0, 1200), stage: "repair" };
        if (gate?.head && !gate.reviewed)
          return { title: "独立 CR 进行中", text: `正在审查提交 ${gate.head.slice(0, 12)}。`, stage: "review" };
        if (gate?.ciIntent || gate?.ciRun)
          return {
            title: "等待 CI 通过",
            text: gate.ciRun ? `Flow 检查 #${gate.ciRun}，通过后才建立 MR。` : "正在启动 Flow 检查。",
            stage: "ci",
          };
        return context.state === "nothing"
          ? { title: "未产生改动", text: "未创建 MR。" }
          : { title: "尚无 MR", text: "已建立开发任务，尚无 MR 记录。" };
      }
      const mr = work.mr;
      const blocker = allCards.find(
        (card: any) =>
          card.state === "open" &&
          card.kind === "ask" &&
          about(card).kind === "codeup-recovery" &&
          about(card).project === p.id &&
          about(card).mr === mr,
      );
      if (blocker?.text && !state?.live)
        return {
          title: state?.merged ? "部署需要处理" : "合并需要处理",
          text: [state?.deployment && "Flow #" + state.deployment, String(blocker.text).slice(0, 1200)]
            .filter(Boolean)
            .join("\n"),
          stage: "blocked",
        };
      if (!state?.merged) {
        if (state?.denied) return { title: "已取消合并", text: `MR !${mr} 的当前提交未获批准。`, stage: "complete" };
        const approval =
          state?.head &&
          state.base &&
          allCards.some(
            (card: any) =>
              card.state === "open" &&
              card.kind === "ask" &&
              about(card).kind === "codeup-merge" &&
              about(card).project === p.id &&
              about(card).mr === mr &&
              about(card).head === state.head &&
              about(card).base === state.base,
          );
        return {
          title: state?.repairSent ? "等待返修" : approval ? "等待批准合并" : "已创建 MR",
          text: `MR !${mr}\n${mrUrl(p, mr)}\n${approval ? "等本人批准当前提交。" : "尚无已合并记录。"}`,
          stage: state?.repairSent ? "repair" : approval ? "approval" : "mr",
        };
      }
      const marker = proofKey(p, work, state);
      if (previous?.verified === marker) return previous;
      const local = {
        title: "已合并",
        text: `MR !${mr} 的交付记录已登记合并。\n${mrUrl(p, mr)}\nCI、独立 CR 结果待核实。`,
      };
      if ((retryAt.get(key) ?? 0) > Date.now())
        return previous?.title === local.title && !previous.verified ? previous : local;
      retryAt.set(key, Date.now() + 60_000);
      try {
        const env = parseEnv(readFileSync(config.envFile, "utf8"));
        const api = new Codeup(p, env[p.tokenEnv] ?? "");
        const [remote, checks, run] = await Promise.all([
          api.mr(mr),
          api.checks(state.merged),
          state.ciRun && state.ciPipeline ? api.call(api.flow(state.ciPipeline, state.ciRun)) : undefined,
        ]);
        const result = mergedResult(p, work, state, remote, checks, run);
        if (result.verified) retryAt.delete(key);
        return result;
      } catch {
        log("飞书任务暂未核实云效检查结果，稍后重试");
        return local;
      }
    } catch {
      log("飞书任务暂未读到关联交付记录");
      return previous ?? pending;
    }
  };
}
