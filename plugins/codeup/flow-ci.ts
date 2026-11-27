import { randomUUID } from "node:crypto";
import { Codeup, wasRejected } from "./api.ts";
import { failureLogs } from "./diagnostics.ts";
import type { State } from "./delivery.ts";
import type { Settings } from "./settings.ts";

export function verifyCheckout(run: any, pipeline: string, id: string, repo: string, branch: string, head: string) {
  const sources = run.sources?.filter((s: any) => s.type === "codeup");
  const src = sources?.length === 1 && sources[0].data;
  const commits = src && typeof src.commit === "string" && JSON.parse(src.commit);
  if (
    String(run.pipelineId) !== pipeline ||
    String(run.pipelineRunId) !== id ||
    !src ||
    src.repo !== repo ||
    src.branch !== branch ||
    !/^[a-f0-9]{40}$/.test(head) ||
    !Array.isArray(commits) ||
    commits[0]?.commitId !== head ||
    run.globalParams?.some(
      (param: any) => ["CI_COMMIT_SHA", "AUTOLOOP_EXPECTED_SHA"].includes(param.key) && param.value !== head,
    )
  )
    throw new Error("Flow 实际检出的仓库、分支、提交或运行编号不匹配，暂不采用结果");
}

function dependencyTimeout(log: string) {
  const text = log.replace(/\x1b\[[0-9;]*m/g, "");
  return (
    /(?:ETIMEDOUT|ERR_SOCKET_TIMEOUT)\s+request to https?:\/\/[^\s]+ failed/i.test(text) ||
    (/npm (?:error|ERR!)\s+(?:code\s+)?(?:ETIMEDOUT|FETCH_ERROR|ERR_SOCKET_TIMEOUT)\b/i.test(text) &&
      /(?:network timeout at:|request to https?:\/\/[^\s]+ failed[^\n]*(?:timed?\s*out|timeout|ETIMEDOUT)|Socket timeout)/i.test(
        text,
      ))
  );
}

export async function checkFlowCI(
  api: Codeup,
  state: State,
  save: () => void,
  mr: number | string,
  branch: string,
  head: string,
  ci: NonNullable<Settings["ci"]>,
  recordCheck: Codeup["check"] = api.check.bind(api),
) {
  const pipeline = ci.pipeline,
    path = api.flow(pipeline),
    repo = api.project.git;
  if (state.ciPipeline && state.ciPipeline !== pipeline) throw new Error("CI 流水线配置已变化");
  if (!state.ciRun) {
    if (state.ciIntent) {
      if (!state.ciMarker) throw new Error("旧 CI 启动请求结果不确定，请核对 Flow 记录");
      // A successful POST can lose its reply. Only adopt the attempt whose private correlation ID we persisted.
      const rows = await api.call(path + "?page=1&perPage=100");
      for (const row of rows) {
        if (state.ciRetryOf && Number(row.pipelineRunId) <= Number(state.ciRetryOf)) break;
        const id = String(row.pipelineRunId);
        const candidate = await api.call(api.flow(pipeline, id));
        if (!candidate.globalParams?.some((x: any) => x.key === "BUILD_REMARK" && x.value === state.ciMarker)) continue;
        if (
          !["SUCCESS", "FAIL", "FAILED", "CANCELED", "CANCELLED"].includes(candidate.status) &&
          !candidate.sources?.some((s: any) => s.data?.commit)
        )
          return false;
        verifyCheckout(candidate, pipeline, id, repo, branch, head);
        state.ciRun = id;
        save();
        break;
      }
      if (!state.ciRun) {
        if (state.ciIntentAt && Date.now() - state.ciIntentAt > 10 * 60_000)
          throw new Error("Flow 未找到具有本次启动标识的运行，无法确认是否已启动");
        return false;
      }
    } else {
      const label = typeof mr === "number" ? `MR${mr}` : mr;
      state.ciMarker = `autoloop-ci:${api.project.id}:${label}:${head}:${randomUUID()}`;
      state.ciIntent = true;
      state.ciIntentAt = Date.now();
      state.ciPipeline = pipeline;
      save();
      try {
        const id = await api.call(path, {
          params: JSON.stringify({
            runningBranchs: { [repo]: branch },
            envs: { ...ci.env, AUTOLOOP_EXPECTED_SHA: head },
            comment: state.ciMarker,
          }),
        });
        if (!Number.isSafeInteger(id) || id < 1) throw new Error("Flow 未返回 CI 运行编号");
        state.ciRun = String(id);
        save();
      } catch (error) {
        if (wasRejected(error)) {
          state.ciIntent = false;
          save();
          throw error;
        }
        return false;
      }
    }
  }
  const id = state.ciRun!;
  const run = await api.call(api.flow(pipeline, id));
  if (!["SUCCESS", "FAIL", "FAILED", "CANCELED", "CANCELLED"].includes(run.status)) return false;
  verifyCheckout(run, pipeline, id, repo, branch, head);
  if (run.status === "SUCCESS") {
    await recordCheck(head, "autoloop-ci", "success", `Flow CI 通过，运行 ${id}`);
    return true;
  }
  const log = await failureLogs(api, pipeline, id, run);
  if (!state.ciRetryOf && ["FAIL", "FAILED"].includes(run.status) && dependencyTimeout(log)) {
    await recordCheck(head, "autoloop-ci", "failure", `依赖下载超时，准备自动重跑。\n${log}`);
    state.ciRetryOf = id;
    state.ciRun = undefined;
    state.ciIntent = false;
    state.ciMarker = undefined;
    state.repairData = undefined;
    state.repairSent = false;
    save();
    return false;
  }
  await recordCheck(head, "autoloop-ci", "failure", log);
  return true;
}
