// Each MR has its own hub lane. The issue status is shared by the card and the native project UI.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../codeup/store.ts";
import { loadProject, context, numberFor, subjectFor, commitChecks } from "../codeup/runtime.ts";
import { Codeup } from "../codeup/api.ts";
import {
  followRelease,
  testDeploymentUrls,
  type TestDeployment,
  type ReleaseProgress,
} from "../feishu-bugs/release.ts";
import { parseEvent, parseResult, type Result, type EventInput } from "../../protocol/validate.ts";
import { receiptBlock } from "../delivery/input.ts";
import { fitJson } from "../command/json.ts";
import { meegle, pollReceipt } from "./run.ts";
import { acceptanceWork, acceptanceAction, type AcceptedWork, type Answer } from "./acceptance.ts";
import { passedRetest, type Retest } from "./retest.ts";
import { projectIssue } from "./workflow.ts";

type Config = {
  space: string;
  project: string;
  source: string;
  fromMR: number;
  registry: string;
  database: string;
  cli?: string;
  retestDirectory?: string;
  userKey: string;
  ownerOpenId: string;
  deployment: TestDeployment;
  resolvedFields?: Record<string, string | string[]>;
  instructions?: Record<
    string,
    { steps: string; expected: string; resolvedFields?: Record<string, string | string[]> }
  >;
};
type Progress = {
  release: ReleaseProgress;
  live?: string;
  resolvingFrom?: string;
  ready?: boolean;
  decision?: Answer;
  notes: Record<string, "pending" | "saved">;
  repair?: boolean;
  repairAt?: number;
  retest?: Retest;
  closed?: boolean;
  readyAt?: number;
  notified?: string[];
  repairEvent?: EventInput;
};
function verifiedPage(state: Progress, work: AcceptedWork) {
  if (!state.live) return;
  const intent = state.release.intent;
  if (!intent || testDeploymentUrls(intent.config, intent.sha).page !== state.live)
    throw new Error("验收页面与原部署记录不一致，请核对该次部署");
  return { testPage: state.live, testedCommit: intent.sha, issueLink: work.link };
}

export async function follow(
  c: Config,
  command: string,
  ports: {
    context?: typeof context;
    client?: ReturnType<typeof meegle>;
    checks?: typeof commitChecks;
    release?: typeof followRelease;
  } = {},
) {
  if (
    !Number.isSafeInteger(c.fromMR) ||
    c.fromMR < 1 ||
    !c.deployment?.page ||
    !c.userKey ||
    !/^ou_[a-zA-Z0-9]+$/.test(c.ownerOpenId)
  )
    throw new Error("缺少测试部署、验收账号或接入起点");
  const store = new Store(c.database);
  try {
    const p = loadProject(c.registry, c.project);
    const ctx = (ports.context ?? context)();
    const registered = new Map<number, AcceptedWork>();
    const jobs = new Map<string, AcceptedWork>();
    for (const row of store.db
      .prepare("SELECT key,data FROM codeup_items WHERE key GLOB ?")
      .iterate("work:" + c.project + ":fp-*")) {
      const w = acceptanceWork(c, String(row.key), JSON.parse(String(row.data)));
      if (w) registered.set(w.mr, w);
      if (w && w.mr > (jobs.get(w.issue)?.mr ?? 0)) jobs.set(w.issue, w);
    }
    const recordKey = (w: AcceptedWork) => "feishu-project-acceptance:" + c.space + ":" + w.issue + ":" + w.mr;
    const nextRetest = (w: AcceptedWork, state: Progress) => {
      if (!state.repairEvent || !c.retestDirectory) return;
      if (!state.repair && (!state.retest || state.ready || state.closed)) return;
      const proof = verifiedPage(state, w);
      if (!proof) return;
      return passedRetest(c.retestDirectory, {
        issue: w.issue,
        mr: w.mr,
        round: (state.retest?.round ?? 0) + 1,
        page: proof.testPage,
        sha: proof.testedCommit,
        repairId: state.repairEvent.id,
        legacy: !state.repairAt && !state.retest,
        since: Math.max(state.repairAt ?? state.readyAt ?? 0, (state.retest?.testedAt ?? -1) + 1),
      });
    };
    if (command === "discover") {
      const events: EventInput[] = [];
      for (const w of jobs.values()) {
        const event = parseEvent({
          id: `acceptance-${w.mr}-${w.head}`,
          type: c.project + ".acceptance",
          subject: subjectFor(p, w.mr),
          summary: "跟进已登记修复的测试验收",
        });
        events.push(event);
        const state = store.get<Progress | null>(recordKey(w), null);
        if (!state?.repairEvent) continue;
        try {
          const key = `verification:${c.project}:${state.repairEvent.subject}`;
          if (!store.get(key, null)) {
            const proof = verifiedPage(state, w);
            if (proof) store.putIfAbsent(key, { ...proof, repairId: state.repairEvent.id });
          }
          const report = nextRetest(w, state);
          if (report)
            events.push(
              parseEvent({
                ...event,
                id: event.id + "-retest-" + report.round + "-" + report.testedAt,
                summary: "跟进网页复验结果",
              }),
            );
        } catch (error) {
          console.error(`MR #${w.mr} 未读取复验资料：${(error as Error).message}`);
        }
      }
      return pollReceipt(events, ctx);
    }
    if (command !== "track") throw new Error("选择 discover 或 track");
    const mr = numberFor(p, ctx);
    const work = [...jobs.values()].find((w) => w.mr === mr);
    const timer = "acceptance-check";
    const cancel = [{ key: timer, cancel: true }];
    // A group can expose open cards from other MRs. Settle only the titles owned by this issue and MR.
    const original = registered.get(mr);
    const belongs = (title: string) =>
      original &&
      (title === `请验收缺陷 ${original.issue}（MR #${mr}）` ||
        (/^请确认第 [1-9]\d* 次网页复验/.test(title) &&
          title.replace(/^请确认第 [1-9]\d* 次网页复验/, "") === `（缺陷 ${original.issue}，MR #${mr}）`));
    const closeCards = (reason: string, keep?: string) =>
      (ctx.open ?? [])
        .filter((v: { title: string }) => v.title !== keep && belongs(v.title))
        .map((v: { card: number }) => ({ card: v.card, reason }));
    if (!work)
      return (
        "该轮已由新修复接替\n" +
        receiptBlock({
          later: cancel,
          resolve: closeCards("已有新一轮验收"),
        })
      );
    const id = recordKey(work);
    const state = store.get<Progress>(id, { release: {}, notes: {} });
    const save = () => store.put(id, state);
    const api = new Codeup(p, process.env[p.tokenEnv] ?? "");
    const client = ports.client ?? meegle(c.cli);
    if ((await client("user", "me", {})).user_key !== c.userKey) throw new Error("飞书登录身份已变化");
    const issue = projectIssue(client, c.space, work.issue);
    const snapshot = await issue.read();
    const report = nextRetest(work, state);
    if (
      report &&
      snapshot.operators.includes(c.userKey) &&
      snapshot.platforms.includes("前端") &&
      (snapshot.status === "CLOSED" ||
        snapshot.status === "RESOLVED" ||
        (snapshot.status === "REOPENED" && snapshot.updatedAt <= report.testedAt))
    ) {
      // Commit the new generation before returning its receipt. A lost receipt can re-create the same question.
      state.retest = report;
      state.repair = false;
      delete state.decision;
      delete state.notified;
      state.closed = snapshot.status === "CLOSED";
      state.ready = false;
      state.resolvingFrom = snapshot.status;
      save();
    }
    const round = state.retest?.round;
    const suffix = round ? "-v" + round : "";
    const about = JSON.stringify({ project: c.project, mr, head: work.head, ...(round && { round }) });
    const later = (minutes: number) => [
      { key: timer, about, at: new Date(Date.now() + minutes * 60000).toISOString() },
    ];
    const finish = (summary: string, extra: Partial<Result> = {}, minutes = 2) => {
      const r = { later: later(minutes), ...extra };
      parseResult({ outcome: "done", ...r });
      return summary + "\n" + receiptBlock(r);
    };
    const choice = (ctx.answers ?? []).find((a: Answer) =>
      acceptanceAction(snapshot.status, about, snapshot.people, c.userKey, c.ownerOpenId, a),
    );
    if (choice) {
      state.decision = { about, by: choice.by, choice: choice.choice };
      save();
    }
    async function note(stage: string, content: string, notify: string[] = []) {
      stage += suffix;
      if (state.notes[stage] === "saved") return;
      const marker = `跟进记录 ${work!.issue}/MR${mr}/${stage}`;
      if (state.notes[stage] === "pending") {
        if (!(await issue.commentExists(marker, c.userKey)))
          throw new Error("详情记录的发送结果未知，请核对后再重试：" + marker);
      } else {
        state.notes[stage] = "pending";
        save();
        await issue.addComment(content + "\n\n" + marker, notify);
      }
      state.notes[stage] = "saved";
      save();
    }
    const details = c.instructions?.[work.issue];
    const steps = details?.steps ?? snapshot.description.slice(0, 1700);
    const expected = details?.expected ?? "按缺陷描述重试，核对其中的期望表现，确认原问题已消失。";
    const mrUrl = p.git.replace(/\.git$/, "") + "/change/" + mr;

    if (
      state.repair ||
      ((state.ready || state.closed || (state.resolvingFrom && state.resolvingFrom !== "REOPENED")) &&
        snapshot.status === "REOPENED")
    ) {
      if (!state.repair && snapshot.status === "REOPENED") {
        state.repair = true;
        state.repairAt = Date.now();
        save();
      }
      if (snapshot.status === "CLOSED")
        return finish("缺陷已关闭，停止返修派发", { resolve: closeCards("已在项目关闭") }, 5);
      if (snapshot.status === "RESOLVED" && c.retestDirectory)
        return finish("已登记返修，等待网页复验报告或新 MR", { resolve: closeCards("上轮验收已结束") }, 5);
      if (
        snapshot.status !== "REOPENED" ||
        !snapshot.operators.includes(c.userKey) ||
        !snapshot.platforms.includes("前端")
      )
        return finish("等待飞书确认缺陷仍需由本人前端返修", { resolve: closeCards("请在项目详情跟进") }, 5);
      const proof = verifiedPage(state, work);

      const eventId = work.root + "-r" + mr + suffix;
      const evidence = proof && { ...proof, repairId: eventId };
      const fixed = { previousMR: mrUrl, ...evidence };
      if (evidence) store.putIfAbsent(`verification:${c.project}:fp-${eventId}`, evidence);
      const event =
        state.repairEvent?.id === eventId
          ? state.repairEvent
          : parseEvent({
              id: eventId,
              subject: "fp-" + eventId,
              type: c.project + ".bug",
              summary: work.title,
              link: work.link,
              detail: JSON.stringify({
                ...fixed,
                ...JSON.parse(
                  fitJson(
                    {
                      description: snapshot.description,
                      feedback:
                        (await issue.feedback(snapshot.people, state.readyAt ?? 0)) ||
                        "验收未通过，请复查原复现步骤并修复。",
                      steps,
                      expected,
                    },
                    4000 - JSON.stringify(fixed).length,
                  ),
                ),
              }),
            });
      const confirmed = await issue.read();
      if (
        confirmed.status !== "REOPENED" ||
        !confirmed.operators.includes(c.userKey) ||
        !confirmed.platforms.includes("前端")
      )
        return finish("派发前缺陷状态或经办人已变化，重新核对", {}, 0.1);
      await note("返修", `验收仍有问题，已重新打开，将从最新测试分支开始下一轮修复。原 MR：${mrUrl}`);
      state.repairEvent = event;
      save();
      return finish("已交回修复", { events: [event], resolve: closeCards("缺陷已重新打开"), later: cancel });
    }
    if (snapshot.status === "CLOSED") {
      if (!state.closed) {
        await note(
          "关单",
          `缺陷已在飞书关闭。关联 MR：${mrUrl}`,
          state.retest ? [] : snapshot.people.filter((x) => x !== c.userKey),
        );
        state.closed = true;
        save();
      }
      return finish("飞书已关闭缺陷", { resolve: closeCards("已验收通过，飞书缺陷已关闭") }, 5);
    }
    if (
      state.retest &&
      (state.closed ||
        !snapshot.people.includes(c.userKey) ||
        (!state.ready &&
          snapshot.status !== "RESOLVED" &&
          (snapshot.status !== "REOPENED" ||
            !snapshot.operators.includes(c.userKey) ||
            !snapshot.platforms.includes("前端") ||
            !(snapshot.updatedAt <= state.retest.testedAt))))
    ) {
      return finish("等待本轮飞书复验状态匹配", { resolve: closeCards("本轮验收条件已变化") }, 5);
    }
    if (!state.live || (!state.ready && !state.retest) || state.decision) {
      const checks = await (ports.checks ?? commitChecks)(api, work.head);
      if (
        !["autoloop-cr", "autoloop-ci"].every((name) => {
          const latest = checks.find((x) => x.head === work.head && x.writer === p.serviceUserId && x.name === name);
          return latest?.status === "completed" && latest.conclusion === "success";
        })
      )
        throw new Error("未核实本轮提交的 CR 和 CI");
      const d = await (ports.release ?? followRelease)(p, c.deployment, work, state.release, save);
      if (!d.live || !d.page) {
        if (state.release.run)
          await note(
            "部署",
            `MR #${mr} 已合并，测试部署运行 #${state.release.run}。页面和版本核实后会通知验收。\n${mrUrl}`,
          );
        return finish(d.note, d.note.startsWith("MR 已关闭") ? { later: cancel } : {});
      }
      state.live = d.page;
      save();
    }
    const current = state.decision ? await issue.read() : snapshot;
    const action = acceptanceAction(current.status, about, current.people, c.userKey, c.ownerOpenId, state.decision);
    if (state.decision && !action) {
      delete state.decision;
      save();
    }
    if (action && state.ready) {
      await issue.transition("RESOLVED", action);
      delete state.decision;
      save();
      return finish(action === "CLOSED" ? "验收通过，已核实飞书关单" : "已重新打开，安排返修", {}, 0.1);
    }
    if (!state.ready) {
      if (snapshot.status !== "RESOLVED") {
        if (!["OPEN", "IN PROGRESS", "REOPENED"].includes(snapshot.status)) throw new Error("缺陷状态不适合进入验收");
        state.resolvingFrom = snapshot.status;
        save();
        await issue.fillResolution({ ...c.resolvedFields, ...details?.resolvedFields });
        await issue.transition(snapshot.status, "RESOLVED");
      }
      state.ready = true;
      state.readyAt = Date.now();
      save();
    }
    const latest = await issue.read();
    if (latest.status !== "RESOLVED") return finish("缺陷状态已变化，将按飞书最新状态处理", {}, 0.1);
    if (!latest.people.length) throw new Error("缺陷缺少报告人和经办人");
    const body =
      (state.retest ? state.retest.summary + "\n" : "") +
      `测试页面：${state.live}\n缺陷详情（推荐在此操作）：${work.link}\n复现步骤：${steps}\n预期结果：${expected}\nMR：${mrUrl}\n测试版本：${state.release.intent!.sha}\n通过请选择 CLOSED，仍有问题请选择 REOPENED，并在详情写明现象。`;
    const others = latest.people.filter((x) => x !== c.userKey);
    // The project notifies collaborators by their project identities; the bound owner receives one interactive bot card.
    if (!state.notified) {
      state.notified = [...others];
      save();
    }
    await note(
      "待验收",
      `已部署并核实测试版本，缺陷已解决，等你验收。\n\n${body}`,
      state.notified.filter((u) => others.includes(u)),
    );
    for (const user of others.filter((u) => !state.notified!.includes(u))) {
      const label = createHash("sha256").update(user).digest("hex").slice(0, 16);
      await note("验收交接-" + label, body, [user]);
      state.notified.push(user);
      save();
    }
    const title = state.retest
      ? `请确认第 ${round} 次网页复验（缺陷 ${work.issue}，MR #${mr}）`
      : `请验收缺陷 ${work.issue}（MR #${mr}）`;
    const alreadyOpen = (ctx.open ?? []).some((x: { title: string }) => x.title === title);
    if (
      state.retest &&
      !state.retest.cardSeen &&
      (alreadyOpen || (ctx.answers ?? []).some((a: Answer) => a.about === about))
    ) {
      state.retest.cardSeen = true;
      save();
    }
    const ask =
      latest.people.includes(c.userKey) && !alreadyOpen && !state.retest?.cardSeen
        ? [
            {
              key: "accept-" + mr + "-" + work.head + suffix,
              title,
              text: body,
              options: ["验收通过，关闭缺陷", "仍有问题，重新打开并返修"],
              about,
            },
          ]
        : [];
    const resolve = latest.people.includes(c.userKey)
      ? closeCards("已由新一轮验收接替", title)
      : closeCards("当前已不负责该缺陷");
    return finish("等待验收人确认", { ask, ...(resolve.length && { resolve }) }, 2);
  } finally {
    store.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    console.log(await follow(JSON.parse(readFileSync(process.argv[2], "utf8")), process.argv[3]));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
