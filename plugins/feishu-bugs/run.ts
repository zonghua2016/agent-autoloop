import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HOME } from "../../host/home.ts";
import {
  parseEvent,
  parseResult,
  type EventInput,
  type Later,
  type Ask,
  type Notice,
} from "../../protocol/validate.ts";
import { readMessage } from "../../worker/contract.ts";
import { receiptBlock } from "../delivery/input.ts";
import { Store } from "../codeup/store.ts";
import { deliveryRecord } from "../codeup/query.ts";
import { context, digest, loadProject, commitChecks } from "../codeup/runtime.ts";
import { develop, type Precheck } from "../codeup/develop.ts";
import { Codeup, wasRejected } from "../codeup/api.ts";
import { remoteHead } from "../codeup/git.ts";
import { verifyCheckout } from "../codeup/flow-ci.ts";
import {
  followRelease,
  testDeploymentUrls,
  type ReleaseEvidence,
  type ReleaseProgress,
  type TestDeployment,
} from "./release.ts";

export type Config = {
  database: string;
  cli: string;
  base: string;
  table: string;
  url: string;
  project: string;
  registry: string;
  target: string;
  records: string[];
  discover?: boolean;
  testDeployment?: TestDeployment;
  notifyUsers?: string[];
};
export type Row = { record_id: string; fields: Record<string, unknown> };
type Context = {
  events?: { subject?: string; type?: string }[];
  timers?: { about?: string }[];
  answers?: { about?: string }[];
};
type Job = {
  record: string;
  event: EventInput;
  stage: "claimed" | "running" | "waiting" | "blocked" | "verifying" | "ready" | "acceptance" | "closed" | "paused";
  note: string;
  originalNote: string;
  link?: string;
  ask?: Ask[];
  reviewMR?: number;
  mrIntent?: boolean;
  evidence?: ReleaseEvidence;
  checkNote?: string;
  release?: ReleaseProgress;
  previewPage?: string;
  notified?: Record<string, { started: number; ref?: string }>;
  updatedAt: string;
};
type Ports = {
  get: (record: string) => Promise<Row>;
  list?: () => Promise<Row[]>;
  update: (record: string, fields: Record<string, unknown>) => Promise<void>;
  develop?: (ctx: Context) => Promise<string>;
  proof?: (job: Job) => Promise<{
    text: string;
    link: string;
    evidence?: ReleaseEvidence;
    checks?: { cr: string; ci: string };
  }>;
  release?: (
    evidence: ReleaseEvidence,
    progress: ReleaseProgress,
    save: () => void,
    deployment?: TestDeployment,
  ) => Promise<{ note: string; live?: boolean; page?: string; awaitingMerge?: boolean }>;
  send?: (user: string, body: string, id: string) => Promise<string>;
};
const finish = (summary: string, data: object = {}) => `${summary}\n${receiptBlock(data)}`;
const key = (c: Config, record: string) => `${c.base}:${c.table}:${record}`;
const subject = (c: Config, record: string) => `bitable-${digest(key(c, record))}`;
const now = () => new Date().toISOString();
const recordId = (v: unknown): v is string => typeof v === "string" && /^rec[a-zA-Z0-9]+$/.test(v);
const openId = (v: unknown): v is string => typeof v === "string" && /^ou_[a-zA-Z0-9_]{1,80}$/.test(v);
const requirementFields = ["Bug 标题", "所属项目", "模块", "优先级", "复现步骤", "期望结果", "实际结果", "环境与版本"];
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : (v?.text ?? ""))).join("");
  return "";
}
function eligible(c: Config, row: Row) {
  return (
    recordId(row.record_id) &&
    (c.discover || c.records.includes(row.record_id)) &&
    text(row.fields["所属项目"]) === c.project
  );
}
function fields(job: Job, row?: Row) {
  return {
    ...(job.stage === "claimed" && { 状态: "修复中" }),
    ...(job.stage === "acceptance" && text(row?.fields["状态"]) === "修复中" && { 状态: "待验收" }),
    修复说明: [
      job.originalNote,
      `[Autoloop 试点] ${job.note}`,
      job.checkNote,
      `任务：${job.event.subject}`,
      `更新：${job.updatedAt}`,
      job.evidence
        ? "合并由本人确认。领取后的需求已冻结；新一轮修复请新建记录。"
        : "本试点不自动合并、不部署。领取后的需求已冻结；新一轮修复请新建记录。",
    ]
      .filter(Boolean)
      .join("\n"),
    ...(job.link && { "代码或 MR 链接": job.link }),
  };
}
function save(db: Store, c: Config, job: Job) {
  job.updatedAt = now();
  db.put(key(c, job.record), job);
}

async function sync(ports: Ports, row: Row, job: Job) {
  const patch = Object.fromEntries(
    Object.entries(fields(job, row)).filter(([name, value]) => {
      const raw = text(row.fields[name]);
      // The CLI renders URL cells as Markdown even when they were written as a plain URL.
      const current = name === "代码或 MR 链接" ? (/^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/.exec(raw)?.[1] ?? raw) : raw;
      return current !== text(value);
    }),
  );
  if (Object.keys(patch).length) await ports.update(job.record, patch);
}

export function tablePorts(c: Config): Ports {
  const call = async (args: string[]) => {
    const { stdout } = await promisify(execFile)(c.cli, [...args, "--as", "bot", "--format", "json"], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }).catch(() => {
      throw new Error("飞书 CLI 未确认操作，请检查连接和应用权限");
    });
    const result = JSON.parse(stdout);
    if (result.ok !== true) throw new Error(`飞书记录操作失败：${result.error?.code ?? "unknown"}`);
    return result.data;
  };
  const table = ["--base-token", c.base, "--table-id", c.table];
  const matrix = (data: any): Row[] => {
    if (
      !Array.isArray(data?.record_id_list) ||
      !data.record_id_list.every(recordId) ||
      !Array.isArray(data.fields) ||
      !data.fields.every((f: unknown) => typeof f === "string") ||
      !Array.isArray(data.data) ||
      data.record_id_list.length !== data.data.length ||
      !data.data.every((row: unknown) => Array.isArray(row) && row.length === data.fields.length)
    )
      throw new Error("飞书没有返回可核对的记录");
    return data.record_id_list.map((id: string, i: number) => ({
      record_id: id,
      fields: Object.fromEntries(data.fields.map((name: string, j: number) => [name, data.data[i][j]])),
    }));
  };
  const recordArgs = (record: string) => {
    if (!recordId(record) || (!c.discover && !c.records.includes(record))) throw new Error("记录不在试点范围");
    return [...table, "--record-id", record];
  };
  return {
    list: async () => {
      const filter = JSON.stringify({ logic: "and", conditions: [["所属项目", "==", c.project]] });
      const selected = [...requirementFields, "状态", "修复说明", "代码或 MR 链接", "验收人", "提交人", "负责人"];
      const rows = new Map<string, Row>();
      let offset = 0;
      for (;;) {
        const data = await call([
          "base",
          "+record-list",
          ...table,
          "--limit",
          "100",
          "--offset",
          String(offset),
          "--filter-json",
          filter,
          ...selected.flatMap((f) => ["--field-id", f]),
        ]);
        const page = matrix(data);
        for (const row of page) {
          if (eligible(c, row)) rows.set(row.record_id, row);
        }
        if (data.has_more !== true) return [...rows.values()];
        // Current CLI can return has_more without next_offset.
        const next = data.next_offset ?? offset + page.length;
        if (!Number.isSafeInteger(next) || next <= offset) throw new Error("飞书记录分页没有前进");
        offset = next;
      }
    },
    get: async (record) => {
      const rows = matrix(await call(["base", "+record-get", ...recordArgs(record)]));
      if (rows.length !== 1 || rows[0].record_id !== record) throw new Error("飞书未返回指定记录");
      return rows[0];
    },
    update: async (record, values) => {
      const typed = { ...values, ...(typeof values["状态"] === "string" && { 状态: [values["状态"]] }) };
      await call(["base", "+record-upsert", ...recordArgs(record), "--json", JSON.stringify(typed)]);
    },
    release: (evidence, progress, save, deployment) =>
      followRelease(loadProject(c.registry, c.project), deployment, evidence, progress, save),
    send: async (user, body, id) => {
      if (!openId(user) || !c.notifyUsers?.includes(user)) throw new Error("收件人未授权");
      const data = await call(["im", "+messages-send", "--user-id", user, "--text", body, "--idempotency-key", id]);
      if (typeof data?.message_id !== "string" || !data.message_id.startsWith("om_"))
        throw new Error("飞书未返回消息编号");
      return data.message_id;
    },
  };
}

async function notify(c: Config, ports: Ports, db: Store, job: Job, row: Row, kind: boolean | "merge") {
  if (!c.notifyUsers?.length) return;
  const merging = kind === "merge";
  const closed = kind === true;
  const notificationId = (user: string) =>
    `bug-${digest(
      JSON.stringify(
        merging
          ? [key(c, job.record), "merge", job.evidence?.mr, job.evidence?.head, job.evidence?.base, user]
          : [key(c, job.record), closed, user],
      ),
    )}`;
  let mergeLines: string[] = [];
  if (merging) {
    // A saved successful check is not authority to request a merge after a branch or check changes.
    const proof = await (ports.proof ?? ((j) => verify(c, j)))(job);
    const original = job.evidence;
    if (
      !original ||
      !proof.evidence ||
      !proof.checks ||
      (["mr", "head", "base", "branch"] as const).some((name) => proof.evidence![name] !== original[name])
    )
      throw new Error("合并提醒的 MR 或检查证明与原修复不匹配");
    row = await ports.get(job.record);
    if (row.record_id !== job.record || !eligible(c, row) || text(row.fields["状态"]) !== "修复中") return;
    mergeLines = [
      `MR：${proof.link}`,
      `CR：通过；检查结果：${proof.checks.cr}`,
      `CI：通过；检查结果：${proof.checks.ci}`,
      `已核实提交：${original.head}`,
      `目标分支：${c.target}`,
      "请在 MR 页面确认后手动合并；系统不会代为合并或部署生产。",
    ];
  }
  const roles = merging ? ["负责人"] : closed ? ["提交人", "负责人", "验收人"] : ["验收人"];
  const recipients = new Set<string>();
  for (const role of roles) {
    const people = row.fields[role];
    if (!Array.isArray(people)) continue;
    for (const person of people) {
      const id = typeof person === "string" ? person : (person?.id ?? person?.open_id);
      if (openId(id) && c.notifyUsers.includes(id)) recipients.add(id);
    }
  }
  if (!recipients.size)
    throw new Error(
      merging ? "待合并记录没有已授权的负责人" : closed ? "关单没有已授权的相关人" : "待验收记录没有已授权的验收人",
    );
  const link = new URL(c.url);
  link.searchParams.set("record", job.record);
  const body = [
    merging
      ? "Bug 修复的 CR、CI 均已通过，请负责人确认合并。"
      : closed
        ? "Bug 已关闭。"
        : "Bug 已部署到测试环境，状态为待验收。",
    job.event.summary,
    ...mergeLines,
    ...(!merging && !closed && job.previewPage ? [`验收页面：${job.previewPage}`] : []),
    link.href,
  ].join("\n");
  let incomplete = false;
  for (const user of recipients) {
    const id = notificationId(user);
    job.notified ??= {};
    const state = (job.notified[id] ??= { started: Date.now() });
    if (state.ref) continue;
    // Feishu only guarantees send deduplication for one hour.
    if (Date.now() - state.started >= 55 * 60_000) {
      incomplete = true;
      continue;
    }
    db.put(key(c, job.record), job);
    try {
      state.ref = await ports.send!(user, body, id);
      db.put(key(c, job.record), job);
    } catch {
      incomplete = true;
    }
  }
  if (incomplete) throw new Error("有飞书通知未确认，请核对应用权限或发送记录");
}

async function follow(c: Config, ports: Ports, db: Store, job: Job, row: Row) {
  const status = text(row.fields["状态"]);
  if (job.stage === "ready" && job.evidence && status === "修复中") {
    job.release ??= {};
    const preset = c.testDeployment;
    const module = text(JSON.parse(job.event.detail ?? "{}").模块)
      .split("·", 1)[0]
      .trim();
    const deployment = preset?.module && module !== preset.module ? undefined : preset;
    const result = await ports.release!(job.evidence, job.release, () => db.put(key(c, job.record), job), deployment);
    if (result.live) {
      job.stage = "acceptance";
      job.note = result.note;
      job.previewPage = result.page;
      save(db, c, job);
      row = await ports.get(job.record);
      if (row.record_id !== job.record || !eligible(c, row)) return;
    } else if (job.note !== result.note) {
      job.note = result.note;
      save(db, c, job);
    }
    if (result.awaitingMerge) {
      await sync(ports, row, job);
      await notify(c, ports, db, job, row, "merge");
      return;
    }
  }
  if (job.stage !== "acceptance" && job.stage !== "closed") {
    if (["待修复", "修复中"].includes(status)) await sync(ports, row, job);
    return;
  }
  const current = text(row.fields["状态"]);
  if (job.stage === "closed" && current !== "已关闭") return;
  if (!["修复中", "待验收", "已关闭"].includes(current)) return;
  if (current === "已关闭" && job.stage !== "closed") {
    job.stage = "closed";
    save(db, c, job);
  }
  await sync(ports, row, job);
  if (current === "修复中") {
    row = await ports.get(job.record);
    if (row.record_id !== job.record || !eligible(c, row) || text(row.fields["状态"]) !== "待验收") return;
  }
  await notify(c, ports, db, job, row, current === "已关闭");
}

export async function poll(c: Config, ports: Ports = tablePorts(c)) {
  const db = new Store(c.database);
  const events: EventInput[] = [];
  const notice: Notice[] = [];
  try {
    const rows = c.discover ? await ports.list!() : await Promise.all(c.records.map((record) => ports.get(record)));
    for (const candidate of rows) {
      const record = candidate.record_id;
      if (!eligible(c, candidate)) continue;
      let job = db.get<Job | null>(key(c, record), null);
      let row = candidate;
      if (
        c.discover &&
        ((!job && text(row.fields["状态"]) === "待修复") ||
          job?.stage === "claimed" ||
          job?.stage === "acceptance" ||
          job?.stage === "closed" ||
          (job?.stage === "ready" && job.evidence))
      ) {
        try {
          row = await ports.get(record);
        } catch {
          notice.push({
            key: `read-${subject(c, record)}`,
            title: "Bug 记录暂时无法读取",
            text: `${record}：等待下一轮重新核对。`,
            fyi: true,
          });
          continue;
        }
        if (row.record_id !== record || !eligible(c, row)) continue;
      }
      if (!job && text(row.fields["状态"]) === "待修复") {
        const detail = JSON.stringify(
          Object.fromEntries(requirementFields.map((name) => [name, text(row.fields[name])])),
        );
        // Oversize requirements must be clarified, never silently truncated into a different task.
        let event: EventInput;
        try {
          event = parseEvent({
            id: `bug:${key(c, record)}`,
            type: "bitable.bug.ready",
            subject: subject(c, record),
            summary: text(row.fields["Bug 标题"]),
            detail,
            link: c.url,
          });
        } catch (error) {
          notice.push({
            key: `invalid-${subject(c, record)}`,
            title: "Bug 资料需要调整",
            text: `${record}：${(error as Error).message}。请调整记录后等待下次领取；未截断需求、未启动开发。`,
            fyi: true,
          });
          continue;
        }
        db.putIfAbsent(key(c, record), {
          record,
          event,
          stage: "claimed",
          note: "已领取，等待自动修复",
          originalNote: text(row.fields["修复说明"]),
          updatedAt: now(),
        } satisfies Job);
        job = db.get<Job>(key(c, record), null!);
      }
      if (!job) continue;
      try {
        await follow(c, ports, db, job, row);
        // The persisted event is retried until the worker starts, with the original event ID.
        if (job.stage === "claimed" && ["待修复", "修复中"].includes(text(row.fields["状态"])) && events.length < 100)
          events.push(job.event);
      } catch (error) {
        notice.push({
          key: `follow-${job.event.subject}`,
          title: "Bug 流程需要检查",
          text: `${record}：${String((error as Error).message).slice(0, 350)}`,
          fyi: true,
        });
      }
    }
    return finish(`检查 ${rows.length} 条试点记录`, { events, ...(notice.length && { notice: notice.slice(0, 10) }) });
  } finally {
    db.close();
  }
}

function findJob(c: Config, ctx: Context, db: Store): Job {
  if (
    ctx.events?.some((e) => !["timer.due", "bitable.bug.ready", "card.answered", "run.manual"].includes(e.type ?? ""))
  )
    throw new Error("事件类型不属于试点原领取记录");
  const subjects = (ctx.events ?? []).filter((e) => e.type !== "timer.due").map((e) => e.subject);
  for (const item of [...(ctx.timers ?? []), ...(ctx.answers ?? [])]) {
    try {
      const value = JSON.parse(item.about ?? "");
      if (value.project === c.project && typeof value.work === "string" && value.work.startsWith(c.project + ":"))
        subjects.push(value.work.slice(c.project.length + 1));
    } catch {
      /* Unrelated timer. */
    }
  }
  const unique = [...new Set(subjects)];
  if (unique.length !== 1) throw new Error("没有找到唯一的原领取记录");
  if (c.discover && typeof unique[0] === "string" && /^bitable-[a-f0-9]{20}$/.test(unique[0])) {
    const matches = db.db
      .prepare("SELECT data FROM codeup_items WHERE key GLOB ? AND json_extract(data, '$.event.subject') = ? LIMIT 2")
      .all(key(c, "rec*"), unique[0]);
    if (matches.length === 1) {
      const job = JSON.parse(String(matches[0].data)) as Job;
      if (recordId(job.record) && subject(c, job.record) === unique[0]) return job;
    }
  }
  for (const record of c.records) {
    const job = db.get<Job | null>(key(c, record), null);
    if (job && job.event.subject === unique[0]) return job;
  }
  throw new Error("没有找到原领取记录");
}

export async function ensureReviewMR(
  state: { reviewMR?: number; mrIntent?: boolean },
  io: {
    find: () => Promise<{ localId: number } | undefined>;
    create: () => Promise<{ localId: number }>;
    save: () => void;
  },
) {
  let mr = await io.find();
  if (!mr) {
    if (state.mrIntent || state.reviewMR) throw new Error("MR 创建结果待核实，不自动重复提交");
    state.mrIntent = true;
    io.save();
    try {
      mr = await io.create();
    } catch (error) {
      if (wasRejected(error)) {
        state.mrIntent = false;
        io.save();
      }
      throw error;
    }
  }
  if (!Number.isSafeInteger(mr.localId) || mr.localId < 1) throw new Error("MR 编号待核实");
  state.reviewMR = mr.localId;
  state.mrIntent = false;
  io.save();
}

export function assertUnmergedMR(mr: any, branch: string, target: string) {
  if (
    !mr ||
    !["UNDER_REVIEW", "TO_BE_MERGED"].includes(mr.status) ||
    mr.workInProgress === true ||
    mr.sourceBranch !== branch ||
    mr.targetBranch !== target ||
    !mr.sourceProjectId ||
    mr.sourceProjectId !== mr.targetProjectId
  )
    throw new Error("MR 状态或分支不符");
}

function prepareReviewMR(c: Config, job: Job, db: Store): (proof: Precheck) => Promise<void> {
  return async (current) => {
    const p = current.project;
    if (p.id !== c.project || p.branch !== c.target) throw new Error("预检项目与可信登记不一致");
    const api = new Codeup(p, process.env[p.tokenEnv] ?? "");
    // Codeup requires a source MR before accepting checks (real HTTP 400, 2026-11-24).
    const gate = current.gate;
    if (
      !gate?.reviewed ||
      gate.findings?.length ||
      gate.head !== current.head ||
      current.pushed !== gate.head ||
      remoteHead(p, current.branch) !== gate.head ||
      remoteHead(p, c.target) !== gate.base
    )
      throw new Error("尚未核实当前提交通过独立 CR，不能创建预检 MR");
    const validate = (mr: any) => {
      assertUnmergedMR(mr, current.branch, c.target);
      return mr;
    };
    await ensureReviewMR(job, {
      find: async () => {
        const mr = job.reviewMR
          ? await api.mr(job.reviewMR)
          : (await api.mrs()).find((m) => m.sourceBranch === current.branch && m.targetBranch === c.target);
        return mr ? validate(mr) : undefined;
      },
      create: async () => {
        const repository = await api.call(api.repo());
        if (!Number.isSafeInteger(repository?.id) || repository.id < 1) throw new Error("仓库 ID 待核实");
        return validate(
          await api.call(api.repo() + "/changeRequests", {
            sourceBranch: current.branch,
            targetBranch: c.target,
            sourceProjectId: repository.id,
            targetProjectId: repository.id,
            title: current.title,
            description: `Bug 表自动修复试点。\n任务：${job.event.subject}\n提交：${gate.head}\n请核对同一提交的 autoloop-cr / autoloop-ci，再由本人确认合并到验收分支。`,
            triggerAIReviewRun: false,
          }),
        );
      },
      save: () => save(db, c, job),
    });
  };
}

export async function verify(c: Config, job: Job) {
  const p = loadProject(c.registry, c.project);
  if (p.branch !== c.target || c.target !== "autoloop/acceptance") throw new Error("试点只允许已登记的验收分支");
  const work = deliveryRecord(HOME, c.project, job.event.subject)?.work;
  if (!work?.mr) throw new Error("MR 绑定待核实");
  const gate = work.gate;
  if (!gate?.head || !gate.reviewed || gate.findings?.length || !gate.ciPipeline || !gate.ciRun)
    throw new Error("CR 或 CI 证明不完整");
  const api = new Codeup(p, process.env[p.tokenEnv] ?? "");
  const mr = await api.mr(work.mr);
  assertUnmergedMR(mr, work.branch, c.target);
  const checks = await commitChecks(api, gate.head);
  for (const name of ["autoloop-cr", "autoloop-ci"]) {
    const check = checks.find((r) => r.name === name && r.writer === p.serviceUserId && r.head === gate.head);
    if (check?.status !== "completed" || check.conclusion !== "success") throw new Error(`${name} 尚未通过`);
  }
  const run = await api.call(api.flow(gate.ciPipeline, gate.ciRun));
  verifyCheckout(run, gate.ciPipeline, gate.ciRun, p.git, work.branch, gate.head);
  if (run.status !== "SUCCESS" || remoteHead(p, work.branch) !== gate.head || remoteHead(p, c.target) !== gate.base)
    throw new Error("远端提交已变化或 CI 未成功");
  const link = p.git.replace(/\.git$/, "") + "/change/" + work.mr;
  return {
    text: `独立 CR：通过；CI：通过（流水线 ${gate.ciPipeline}，运行 ${gate.ciRun}）\n提交：${gate.head}\n目标：${c.target}\n核实时间：${now()}`,
    link,
    checks: { cr: `${link}/checks`, ci: `https://flow.aliyun.com/pipelines/${gate.ciPipeline}/builds/${gate.ciRun}` },
    evidence: { mr: work.mr, branch: work.branch, head: gate.head, base: gate.base },
  };
}

export async function work(c: Config, ctx: Context, ports: Ports = tablePorts(c)) {
  const db = new Store(c.database);
  try {
    const job = findJob(c, ctx, db);
    if (job.stage === "acceptance" || job.stage === "closed") return finish(job.note);
    const row = await ports.get(job.record);
    if (!eligible(c, row) || !["待修复", "修复中"].includes(text(row.fields["状态"]))) {
      job.stage = "paused";
      job.note = "已停止本条试点：记录项目或状态已改变；如需新一轮修复，请新建记录";
      save(db, c, job);
      return finish(job.note, { later: [{ key: "codeup-preflight", cancel: true }] });
    }
    if (
      ["ready", "paused"].includes(job.stage) ||
      (job.stage === "blocked" &&
        !(job.ask?.length && ctx.answers?.length) &&
        !ctx.events?.some((e) => e.type === "run.manual"))
    ) {
      await sync(ports, row, job);
      return finish(job.note, { ...(job.ask?.length && { ask: job.ask }) });
    }
    const complete = async () => {
      const proof = await (ports.proof ?? ((j) => verify(c, j)))(job);
      job.stage = "ready";
      job.note = "待合并确认（尚未合并）";
      job.checkNote = proof.text;
      job.link = proof.link;
      job.evidence = proof.evidence;
      job.ask = undefined;
      save(db, c, job);
      try {
        await ports.update(job.record, fields(job));
      } catch {
        /* Poll retries the saved result. */
      }
      return finish(job.note, { later: [{ key: "codeup-preflight", cancel: true }] });
    };
    if (job.stage === "verifying") return await complete();
    job.stage = "running";
    job.ask = undefined;
    job.note = "自动修复 / 独立 CR / CI 执行中";
    save(db, c, job);
    await ports.update(job.record, fields(job));
    const frozen = { ...ctx, events: ctx.events?.some((e) => e.type !== "timer.due") ? [job.event] : [] };
    const invoke = async () => {
      const folder = c.database + ".contexts";
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const file = join(folder, job.event.subject + ".json");
      writeFileSync(file, JSON.stringify(frozen), { mode: 0o600 });
      const previous = process.env.AGENT_AUTOLOOP_CONTEXT;
      process.env.AGENT_AUTOLOOP_CONTEXT = file;
      try {
        return await develop(c.registry, c.project, { beforeCheck: prepareReviewMR(c, job, db) });
      } finally {
        if (previous === undefined) delete process.env.AGENT_AUTOLOOP_CONTEXT;
        else process.env.AGENT_AUTOLOOP_CONTEXT = previous;
      }
    };
    const result = readMessage(await (ports.develop ?? invoke)(frozen));
    if (result.problem) throw new Error("开发回执无效");
    const receipt = parseResult({ outcome: result.outcome ?? "done", ...result.receipt });
    const ready = receipt.outcome === "done" && receipt.events?.some((e) => e.type === "delivery.requested");
    let later: Later[] = (receipt.later ?? [])
      .filter((l) => l.key === "codeup-preflight")
      .map((l) =>
        l.cancel
          ? { key: l.key, cancel: true }
          : {
              key: l.key,
              at: l.at,
              about: JSON.stringify({
                kind: "codeup-preflight",
                project: c.project,
                work: c.project + ":" + job.event.subject,
              }),
            },
      );
    if (ready) {
      job.stage = "verifying";
      job.note = "修复已完成，正在核实 MR 与 CR / CI 结果";
      save(db, c, job);
      return await complete();
    } else if (receipt.ask?.length || !later.some((l) => !l.cancel)) {
      job.stage = "blocked";
      job.ask = receipt.ask;
      job.note = `待本人处理：${result.summary ?? "本轮未产生可核实的 MR"}`;
      later = [{ key: "codeup-preflight", cancel: true }];
    } else {
      job.stage = "waiting";
      job.note = result.summary ?? "等待 CR / CI 复查";
    }
    save(db, c, job);
    // A failed writeback cannot turn a finished development into a new development request.
    try {
      await ports.update(job.record, fields(job));
    } catch {
      /* The scheduled poll retries only the writeback. */
    }
    return finish(job.note, { later, ...(job.ask?.length && { ask: job.ask }) });
  } finally {
    db.close();
  }
}

export function load(file: string): Config {
  const c: Config = JSON.parse(readFileSync(file, "utf8"));
  if (
    ![c.database, c.cli, c.registry].every(isAbsolute) ||
    ![c.base, c.table].every((v) => /^[a-zA-Z0-9]+$/.test(v)) ||
    !Array.isArray(c.records) ||
    c.records.length > 10 ||
    c.records.some((v) => !recordId(v)) ||
    new Set(c.records).size !== c.records.length ||
    (c.discover !== undefined && typeof c.discover !== "boolean") ||
    (c.notifyUsers !== undefined && (!Array.isArray(c.notifyUsers) || !c.notifyUsers.every(openId)))
  )
    throw new Error("试点配置无效");
  const p = loadProject(c.registry, c.project);
  if (c.target !== "autoloop/acceptance" || p.branch !== c.target) throw new Error("试点只允许验收分支");
  if (c.testDeployment) testDeploymentUrls(c.testDeployment);
  return c;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const c = load(process.argv[2]);
  const operation = process.argv[3];
  if (operation === "poll") console.log(await poll(c));
  else if (operation === "work") console.log(await work(c, context()));
  else throw new Error("只支持 poll / work");
}
