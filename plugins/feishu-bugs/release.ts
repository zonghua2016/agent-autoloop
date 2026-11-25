import { Codeup, wasRejected } from "../codeup/api.ts";
import { verifyCheckout } from "../codeup/flow-ci.ts";
import { remoteHead } from "../codeup/git.ts";
import type { Project } from "../codeup/settings.ts";

export type TestDeployment = { pipeline: string; health: string; versionField: string; page?: string; module?: string };
export type ReleaseEvidence = { mr: number; branch: string; head: string; base: string };
export type ReleaseProgress = { intent?: { config: TestDeployment; sha: string }; run?: string };

const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);

function previewUrl(value: string, commit: string) {
  const url = new URL(value.replaceAll("{commit}", commit));
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error("测试预览地址无效");
  return url;
}

export function testDeploymentUrls(config: TestDeployment, commit = "0".repeat(40)) {
  if (
    !/^[1-9]\d*$/.test(config.pipeline) ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.versionField) ||
    (config.module !== undefined && (typeof config.module !== "string" || !/^[a-zA-Z0-9_-]+$/.test(config.module))) ||
    !sha(commit)
  )
    throw new Error("测试部署配置无效");
  const health = previewUrl(config.health, commit);
  const page = config.page ? previewUrl(config.page, commit) : undefined;
  if (page && page.origin !== health.origin) throw new Error("测试页面与版本入口必须同源");
  return { health: health.href, page: page?.href };
}

export async function followRelease(
  project: Project,
  config: TestDeployment | undefined,
  evidence: ReleaseEvidence,
  progress: ReleaseProgress,
  save: () => void,
  request: typeof fetch = fetch,
  branchHead: typeof remoteHead = remoteHead,
) {
  if (
    project.branch !== "autoloop/acceptance" ||
    !sha(evidence.head) ||
    !sha(evidence.base) ||
    !Number.isSafeInteger(evidence.mr) ||
    evidence.mr < 1
  )
    throw new Error("缺少已核实的验收分支和审查提交");
  const api = new Codeup(project, process.env[project.tokenEnv] ?? "", request);
  const mr = await api.mr(evidence.mr);
  if (
    mr.localId !== evidence.mr ||
    mr.sourceBranch !== evidence.branch ||
    mr.targetBranch !== project.branch ||
    !mr.sourceProjectId ||
    mr.sourceProjectId !== mr.targetProjectId
  )
    throw new Error("待部署 MR 与原 Bug 修复不匹配");
  if (mr.status !== "MERGED")
    return {
      note: mr.status === "CLOSED" ? "MR 已关闭，未启动测试部署" : "CR / CI 已通过，待本人确认合并",
      awaitingMerge: ["UNDER_REVIEW", "TO_BE_MERGED"].includes(mr.status) && mr.workInProgress !== true,
    };
  const merged = mr.mergedRevision;
  if (!sha(merged)) throw new Error("Codeup 未返回完整合并提交");
  if (merged !== evidence.head && !progress.intent) {
    const commit = await api.call(`${api.repo()}/commits/${merged}`);
    if (
      commit.id !== merged ||
      commit.parentIds?.length !== 2 ||
      commit.parentIds[0] !== evidence.base ||
      commit.parentIds[1] !== evidence.head
    )
      throw new Error("合并提交与已核实的 CR / CI 提交不匹配");
  }
  if (!config) return { note: `已合并，等待测试部署配置\n合并提交：${merged}` };
  const { health, page } = testDeploymentUrls(config, merged);
  if (progress.intent) {
    const original = progress.intent;
    if (
      original.sha !== merged ||
      original.config.pipeline !== config.pipeline ||
      original.config.health !== config.health ||
      original.config.versionField !== config.versionField ||
      original.config.page !== config.page ||
      (original.config.module !== undefined && original.config.module !== config.module)
    )
      throw new Error("部署期间验收配置或合并提交发生变化");
    if (!progress.run) throw new Error("测试部署启动结果未知，请核对云效运行记录，避免重复部署");
  } else {
    if (branchHead(project, project.branch) !== merged) throw new Error("验收分支已变化，无法部署该合并提交");
    progress.intent = { config: { ...config }, sha: merged };
    save();
    try {
      const result = await api.call(api.flow(config.pipeline), {
        params: JSON.stringify({
          runningBranchs: { [project.git]: project.branch },
          envs: { AUTOLOOP_EXPECTED_SHA: merged, AUTOLOOP_TARGET_ENV: "test" },
          comment: `autoloop-bug-test:${project.id}:MR${evidence.mr}:${merged}`,
        }),
      });
      if (!Number.isSafeInteger(result) || result < 1) throw new Error("云效未返回测试部署运行编号");
      progress.run = String(result);
      save();
    } catch (error) {
      if (wasRejected(error)) {
        delete progress.intent;
        save();
      }
      throw error;
    }
    return { note: `测试部署已启动，流水线 ${config.pipeline}，运行 ${progress.run}` };
  }
  const run = await api.call(api.flow(config.pipeline, progress.run));
  if (["FAIL", "FAILED", "CANCELED", "CANCELLED"].includes(run.status))
    throw new Error(`测试部署未成功，流水线 ${config.pipeline}，运行 ${progress.run}`);
  if (run.status !== "SUCCESS") return { note: `等待测试部署，流水线 ${config.pipeline}，运行 ${progress.run}` };
  verifyCheckout(run, config.pipeline, progress.run, project.git, project.branch, merged);
  const probe = (url: string, method = "GET") =>
    request(url, {
      method,
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
      headers: { "cache-control": "no-cache" },
    });
  const environment = await probe(health);
  if (!environment.ok || (await environment.json())?.[config.versionField] !== merged)
    return { note: `流水线 ${config.pipeline} 运行 ${progress.run} 已成功，等待测试环境版本匹配` };
  if (page) {
    const entry = await probe(page, "HEAD");
    if (!entry.ok || !entry.headers.get("content-type")?.toLowerCase().startsWith("text/html"))
      return { note: `流水线 ${config.pipeline} 运行 ${progress.run} 已成功，等待验收页面可用` };
  }
  return {
    live: true,
    page,
    note: [
      "测试环境部署已核实，待验收",
      `流水线 ${config.pipeline}，运行 ${progress.run}`,
      `提交：${merged}`,
      ...(page ? [`验收页面：${page}`] : []),
      `版本入口：${health}`,
    ].join("\n"),
  };
}
