import { matches } from "../delivery/project.ts";
import { wasRejected } from "./api.ts";
import type { Settings } from "./settings.ts";

export type MR = {
  id: number;
  head: string;
  base: string;
  branch: string;
  target: string;
  status: string;
  requirements: boolean;
  conflict: boolean;
  title: string;
  description: string;
  merged: string;
  behind?: number;
};
export type Finding = { title: string; text: string };
export type Check = {
  name: string;
  head: string;
  status: string;
  conclusion?: string;
  writer: string;
  detail?: string;
};
export type State = {
  head?: string;
  base?: string;
  findings?: Finding[];
  reviewed?: boolean;
  rounds?: number;
  repairSent?: boolean;
  approved?: string;
  mergeIntent?: boolean;
  merged?: string;
  repairData?: { head: string; text: string; branch: string };
  ciIntent?: boolean;
  ciRun?: string;
  ciMarker?: string;
  ciIntentAt?: number;
  ciRetryOf?: string;
  ciPipeline?: string;
  deploySettings?: Settings;
  deployExpected?: boolean;
  denied?: string;
  deployIntent?: boolean;
  deployment?: string;
  live?: boolean;
};
export type Answer = { choice?: number; about?: string };
export type DeliveryIO = {
  project: string;
  requireApproval?: boolean;
  mr(): Promise<MR>;
  settings(): Promise<Settings>;
  diff(since?: string): Promise<{ text: string; files: string[] }>;
  review(text: string, settings: Settings): Promise<Finding[]>;
  checks(): Promise<Check[]>;
  check(head: string, conclusion: "success" | "failure", text: string): Promise<void>;
  merge(): Promise<void>;
  deploy(sha: string, settings: Settings): Promise<string>;
  deployment(id: string, settings: Settings): Promise<string>;
  live(settings: Settings): Promise<string | null>;
  save(state: State): void;
  now(): Date;
};
export type Result = {
  phase: "blocked" | "repair" | "checking" | "approval" | "changed" | "shipping" | "live" | "attention" | "merged";
  summary: string;
  repair?: { head: string; text: string; branch: string };
  ask?: { title: string; text: string; options: string[]; about: string; key: string };
  later?: boolean;
};

export function bindChecks(state: State, version: Pick<MR, "head" | "base">, save: DeliveryIO["save"]) {
  if (!/^[a-f0-9]{40}$/.test(version.head) || !/^[a-f0-9]{40}$/.test(version.base))
    throw new Error("无法确认 MR 当前提交");
  if (state.head !== version.head || state.base !== version.base) {
    const rounds = state.rounds ?? 0;
    Object.assign(state, {
      head: version.head,
      base: version.base,
      reviewed: false,
      findings: [],
      repairSent: false,
      repairData: undefined,
      ciIntent: false,
      ciRun: undefined,
      ciRetryOf: undefined,
      ciMarker: undefined,
      ciIntentAt: undefined,
      ciPipeline: undefined,
      approved: undefined,
      denied: undefined,
      mergeIntent: false,
      rounds,
    });
    save(state);
  }
}

export async function checkCommit(
  io: Pick<DeliveryIO, "review" | "check" | "checks" | "save">,
  state: State,
  version: Pick<MR, "head" | "branch">,
  settings: Settings,
  text: string,
): Promise<Result | undefined> {
  if (!state.reviewed) {
    state.findings = await io.review(text, settings);
    state.reviewed = true;
    state.rounds = (state.rounds ?? 0) + 1;
    io.save(state);
  }
  await io.check(
    version.head,
    state.findings?.length ? "failure" : "success",
    state.findings?.map((f) => `${f.title}：${f.text}`).join("\n") || "独立审查未发现阻断问题",
  );
  if (state.findings?.length) {
    if (state.repairSent) return { phase: "blocked", summary: "审查问题已交回，等待新提交", later: true };
    if ((state.rounds ?? 0) >= 3) return { phase: "attention", summary: "三轮审查后仍有问题，需要重新确认实现方案" };
    state.repairSent = true;
    state.repairData = {
      head: version.head,
      branch: version.branch,
      text: state.findings.map((f) => `${f.title}：${f.text}`).join("\n"),
    };
    io.save(state);
    return { phase: "repair", summary: "审查发现问题，交回开发任务", repair: state.repairData };
  }
  const checks = await io.checks();
  const required = settings.checks.map((c) =>
    checks.find((row) => row.name === c.name && row.head === version.head && c.writers.includes(row.writer)),
  );
  if (required.some((c) => c && c.status === "completed" && c.conclusion !== "success")) {
    if (state.repairSent) return { phase: "blocked", summary: "CI 失败已交回，等待新提交", later: true };
    state.repairSent = true;
    state.repairData = {
      head: version.head,
      branch: version.branch,
      text: `Codeup 当前提交的必需检查未通过，请根据以下资料修复并推送新提交：\n${required
        .filter((c) => c?.conclusion !== "success")
        .map((c) => `${c?.name}: ${c?.detail ?? c?.conclusion}`)
        .join("\n")}`,
    };
    io.save(state);
    return { phase: "repair", summary: "CI 失败，交回开发任务", repair: state.repairData };
  }
  if (required.some((c) => !c || c.status !== "completed"))
    return { phase: "checking", summary: "等待当前提交的必需 CI 检查", later: true };
}

export async function deliver(io: DeliveryIO, state: State, answers: Answer[]): Promise<Result> {
  const mr = await io.mr();
  const settings = await io.settings();
  if (state.live) return { phase: "live", summary: "已核实交付完成" };
  if (mr.status === "CLOSED" || mr.status === "UNDER_DEV")
    return { phase: "blocked", summary: "MR 已关闭或仍为草稿，未交付" };
  if (mr.status === "MERGED") {
    state.deployExpected = !!(state.deploySettings?.deploy || settings.deploy);
    state.merged = mr.merged;
    io.save(state);
  }
  if (!state.merged) {
    bindChecks(state, mr, io.save);
    const changes = await io.diff();
    if (mr.behind && mr.behind > 0) {
      state.repairData = {
        head: mr.head,
        branch: mr.branch,
        text: "目标分支已更新。先将可信目标分支合入当前工作分支，保留已有变更，解决冲突后运行全部必需检查并推送；不得强推。",
      };
      state.repairSent = true;
      io.save(state);
      return { phase: "repair", summary: "先同步目标分支，再重测重审", repair: state.repairData };
    }
    const result = await checkCommit(io, state, mr, settings, changes.text);
    if (result) return result;
    const binding = JSON.stringify({
      kind: "codeup-merge",
      project: io.project,
      mr: mr.id,
      head: mr.head,
      base: mr.base,
    });
    const decision = answers.find((a) => a.about === binding);
    if (decision?.choice === 0) {
      state.approved = binding;
      io.save(state);
    }
    if (decision?.choice === 1) {
      state.denied = binding;
      io.save(state);
    }
    if (state.denied === binding) return { phase: "blocked", summary: "本人已取消本提交的合并" };
    const needsHuman =
      io.requireApproval ||
      !settings.autoMerge ||
      !settings.protectedBranchVerified ||
      changes.files.some((p) =>
        matches(p, [
          ...settings.sensitive,
          "ops/**",
          ".flow/**",
          "**/AGENTS.md",
          "package.json",
          "**/package.json",
          "**/*.sql",
        ]),
      );
    if (needsHuman && state.approved !== binding)
      return {
        phase: "approval",
        summary: "检查通过，等待本人批准当前提交",
        ask: {
          title: "是否批准本次代码合并？",
          text: `MR ${mr.id}，提交 ${mr.head}，目标 ${mr.base}。${settings.protectedBranchVerified ? "" : "尚未核实 Codeup 保护分支配置，请在 Codeup 完成人工合并。"}`,
          options: ["批准当前提交", "取消本次合并"],
          about: binding,
          key: `merge-${mr.id}-${mr.head.slice(0, 12)}-${mr.base.slice(0, 12)}`,
        },
      };
    if (!settings.protectedBranchVerified)
      return {
        phase: "attention",
        summary: "未核实 Codeup 原生门禁，不执行自动合并；请在 Codeup 合并后继续跟踪",
        later: true,
      };
    const current = await io.mr();
    if (current.head !== mr.head || current.base !== mr.base || current.status === "UNDER_DEV")
      return { phase: "changed", summary: "提交或目标分支已变化，重新检查", later: true };
    if (!current.requirements || current.conflict)
      return { phase: "checking", summary: "Codeup 原生门禁尚未通过，未合并", later: true };
    if (state.mergeIntent)
      return { phase: "attention", summary: "上次合并响应未确认，请核对 Codeup；不会盲目重发合并" };
    state.mergeIntent = true;
    io.save(state);
    try {
      await io.merge();
    } catch (error) {
      const reread = await io.mr();
      if (reread.status !== "MERGED") {
        if (wasRejected(error)) {
          state.mergeIntent = false;
          io.save(state);
        }
        throw error;
      }
    }
    const merged = await io.mr();
    if (merged.status !== "MERGED" || !/^[a-f0-9]{40}$/.test(merged.merged)) throw new Error("Codeup 尚未确认合并提交");
    state.deployExpected = !!(state.deploySettings?.deploy || settings.deploy);
    state.merged = merged.merged;
    io.save(state);
  }
  if (!/^[a-f0-9]{40}$/.test(state.merged ?? "")) return { phase: "attention", summary: "无法确认已合并的完整提交号" };
  const releaseSettings = state.deploySettings ?? settings;
  if (!releaseSettings.deploy) return { phase: "merged", summary: `代码已合并到 ${mr.target}` };
  if (!state.deployment) {
    if (state.deployIntent)
      return { phase: "attention", summary: "发布请求结果不确定，请核对 Flow 运行记录；不会自动重复发布" };
    state.deployIntent = true;
    state.deploySettings = structuredClone(releaseSettings);
    io.save(state);
    try {
      state.deployment = await io.deploy(state.merged!, state.deploySettings);
    } catch (error) {
      if (wasRejected(error)) {
        state.deployIntent = false;
        state.deploySettings = undefined;
        io.save(state);
      }
      throw error;
    }
    io.save(state);
    return { phase: "shipping", summary: "已启动 Flow 发布，等待执行结果", later: true };
  }
  const deployedSettings = state.deploySettings ?? settings;
  const status = await io.deployment(state.deployment, deployedSettings);
  if (["FAIL", "FAILED", "CANCELED", "CANCELLED"].includes(status))
    return { phase: "attention", summary: "Flow 发布失败，尚未确认上线" };
  if (status !== "SUCCESS") return { phase: "shipping", summary: "等待 Flow 发布完成", later: true };
  if ((await io.live(deployedSettings)) !== state.merged)
    return { phase: "shipping", summary: "Flow 成功，等待线上版本匹配本次提交", later: true };
  state.live = true;
  io.save(state);
  return { phase: "live", summary: "Flow 发布成功，线上版本已核实" };
}
