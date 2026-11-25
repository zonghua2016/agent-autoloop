import { join } from "node:path";
import { HOME } from "../../host/home.ts";
import { loadProject } from "./runtime.ts";
import { verifyCheckout } from "./flow-ci.ts";
import { Store } from "./store.ts";
import { Codeup } from "./api.ts";
import type { State } from "./delivery.ts";

const [registry, id, mr, kind, runId] = process.argv.slice(2);
if (!/^[1-9]\d*$/.test(mr ?? "") || !["ci", "deploy"].includes(kind) || !/^[1-9]\d*$/.test(runId ?? ""))
  throw new Error("用法：reconcile.ts <projects.json> <项目> <MR编号> <ci|deploy> <已存在的Flow运行编号>");
const p = loadProject(registry, id),
  api = new Codeup(p, process.env[p.tokenEnv] ?? "");
const store = new Store(join(HOME, "codeup.db"));
try {
  const key = `delivery:${id}:${mr}`,
    state = store.get<State>(key, {});
  const pipeline = kind === "ci" ? state.ciPipeline : state.deploySettings?.deploy?.pipeline;
  const expected = kind === "ci" ? state.head : state.merged;
  const intent = kind === "ci" ? state.ciIntent : state.deployIntent;
  if (!pipeline || !expected || !intent) throw new Error("没有对应的不确定请求，不能绑定运行记录");
  const run = await api.call(api.flow(pipeline, runId));
  if (kind === "ci") {
    const remote = await api.mr(Number(mr));
    if (remote.targetBranch !== p.branch || remote.sourceProjectId !== remote.targetProjectId)
      throw new Error("MR 与登记项目不符");
    verifyCheckout(run, pipeline, runId, p.git, remote.sourceBranch, expected);
  } else if (!(run.globalParams ?? []).some((x: any) => x.key === "AUTOLOOP_EXPECTED_SHA" && x.value === expected))
    throw new Error("Flow 运行的预期提交与本次交付不一致");
  if (kind === "ci") state.ciRun = runId;
  else state.deployment = runId;
  store.put(key, state);
  console.log("已核对并绑定现有 Flow 运行；没有重新启动流水线。请回复原卡片继续核实。");
} finally {
  store.close();
}
