import { mkdirSync, readFileSync, openSync, closeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Memory, localVector, type Entry } from "./memory.ts";
import { care, collectBugs, deliberate, hash, type BugProvider, type Care, type Model } from "./workflow.ts";
import { modelRunner, personalCandidates, type ModelConfig } from "./model.ts";
import { hubClient } from "../../protocol/client.ts";
import { receiptBlock } from "../delivery/input.ts";
import { fitJson } from "../command/json.ts";

export type Config = {
  database: string;
  scope: string;
  timezone: string;
  models?: Record<string, ModelConfig>;
  fallbackModels?: string[];
  roles?: Record<string, string>;
  care?: Care & { proactive: boolean };
  bugProvider?: string;
  bugFeed?: string;
  embedding?: string;
  recordChats?: boolean;
  evaluation?: ModelConfig;
  bugHub?: { url: string; keyEnv: string };
};
type Event = { id: number | string; type: string; subject: string; summary: string; detail?: string; link?: string };
type Context = {
  conversation?: { message: string; reply: string }[];
  events?: Event[];
  answers?: { about?: string; choice?: number | null; text?: string }[];
};
const parse = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const json = (output: unknown) => JSON.stringify(output, null, 2);
function asText(value: unknown) {
  const item = value as { text?: string };
  if (typeof item?.text !== "string" || !item.text.trim() || item.text.length > 8000)
    throw new Error("模型未返回有效文本");
  return item.text;
}
const finish = (text: string, data: object) => `${text}\n${receiptBlock(data)}`;
function key(config: Config, now: string) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
}
async function extension(file: string) {
  if (!isAbsolute(file)) throw new Error("扩展必须登记本机绝对路径");
  return (await import(pathToFileURL(file).href)).default;
}
export async function run(
  config: Config,
  operation: string,
  args: string[],
  context: Context,
  now: string,
  invoke?: Model,
  signal?: AbortSignal,
) {
  if (!isAbsolute(config.database) || !/^[\w.-]{1,90}$/.test(config.scope))
    throw new Error("须登记绝对数据库路径和记忆范围");
  mkdirSync(dirname(config.database), { recursive: true, mode: 0o700 });
  closeSync(openSync(config.database, "a", 0o600));
  using db = new Memory(config.database);
  const scope = config.scope,
    day = key(config, now);
  const models = config.models ?? { codex: { use: "codex" } };
  const fallbackModels = personalCandidates(models, config.fallbackModels);
  const call = invoke ?? modelRunner(models, fallbackModels, signal);
  const role = (name: string, fallback: string) => config.roles?.[name] ?? fallback;
  const failover = !!fallbackModels.length;
  const evaluate = (data: NonNullable<ReturnType<Memory["graph"]>>) => {
    const exclude = data.item.authorModel ?? (failover ? role("experience", "dsh") : undefined);
    return config.evaluation
      ? modelRunner({ ...models, 独立评估: config.evaluation }, fallbackModels, signal)("独立评估", "evaluate", data, {
          exclude,
        })
      : call(role("evaluate", "gemini"), "evaluate", data, { exclude });
  };
  const embed = async (input: string): Promise<number[] | undefined> =>
    config.embedding ? (await extension(config.embedding))(input) : localVector(input);
  const ask = (title: string, text: string, about: object) =>
    finish(title, {
      ask: [
        {
          key: `personal-${hash(about)}`,
          title,
          text: text.slice(0, 1350) + "\n请用文字回答，或取消本次论证。",
          options: ["重新显示问题", "取消论证"],
          about: JSON.stringify(about),
        },
      ],
    });
  const notice = (title: string, text: string, id: string) =>
    finish(title, { notice: [{ key: id, title, text: text.slice(0, 1500), fyi: true }] });
  const recall = async (q: string) => {
    const hits = db.search(scope, q, now, await embed(q), 8);
    const origins = new Set(hits.flatMap((row) => row.parents ?? []));
    for (const id of origins) {
      const row = db.get(scope, id, now);
      if (
        row &&
        ["raw", "feedback", "concept"].includes(row.kind) &&
        !hits.some((x) => x.id === id) &&
        hits.length < 12
      )
        hits.push(row);
    }
    return hits.map(({ id, kind, text, at, parents }) => ({ id, kind, text: text.slice(0, 3000), at, parents }));
  };
  const generate = async (op: string, kind: Entry["kind"], entries: Entry[], id?: string) => {
    if (!entries.length) return undefined;
    if (id && db.get(scope, id, now)) return id;
    let authorModel: string | undefined;
    const value = (await call(
      role(op, "dsh"),
      op,
      entries.map(({ id, text, kind, at }) => ({ id, text: text.slice(0, 3500), kind, at })),
      op === "experience" && failover ? { selected: (name) => (authorModel = name) } : undefined,
    )) as { text: string; tags?: unknown; relations?: unknown };
    const text = asText(value);
    const ids = entries.map((row) => row.id!);
    const tags = Array.isArray(value.tags) ? value.tags.filter((x) => typeof x === "string").slice(0, 30) : [];
    const relations = Array.isArray(value.relations)
      ? value.relations.filter((r) => r && ids.includes(r.target) && typeof r.type === "string").slice(0, 30)
      : [];
    return db.add({
      scope,
      kind,
      text,
      id,
      tags,
      relations,
      authorModel,
      at: now,
      parents: ids,
      vector: await embed(text),
    });
  };
  switch (operation) {
    case "record": {
      const { kind, text, expires, parents, tags, relations, id } = parse(args[0]) as Entry;
      if (!["raw", "decision", "preference", "study", "todo", "care", "feedback", "concept"].includes(kind))
        throw new Error("请通过复盘和评估生成经验候选");
      return db.add({
        scope,
        kind,
        text,
        expires,
        parents,
        tags,
        relations,
        id,
        at: now,
        approved: ["decision", "preference"].includes(kind),
        vector: await embed(text),
      });
    }
    case "recall":
      return json(await recall(args.join(" ")));
    case "graph":
      return json(db.graph(scope, args[0], now) ?? null);
    case "list":
      return json(db.list(scope, now).map(({ vector: _, ...row }) => row));
    case "forget":
      db.forget(scope, args[0]);
      return "已删除原记录及依赖它的派生记忆";
    case "prune":
      db.prune(scope, now);
      return "已清理到期记忆";
    case "correct": {
      const text = args.slice(1).join(" ");
      return db.correct(scope, args[0], text, now, await embed(text));
    }
    case "revise":
      db.revise(scope, args[0], args[1] === "remembered", now);
      return "已安排下次复习";
    case "done":
      db.finish(scope, args[0], now);
      return "已完成待办";
    case "approve":
      db.approve(scope, args[0], now);
      return "已采用这条经过评估的经验";
    case "improve": {
      const answer = context.answers
        ?.flatMap((a) => {
          try {
            const binding = JSON.parse(a.about ?? "");
            return binding.kind === "personal-experience" && binding.scope === scope
              ? [{ ...binding, choice: a.choice }]
              : [];
          } catch {
            return [];
          }
        })
        .at(-1);
      if (answer) {
        if (answer.choice === 0) {
          db.approve(scope, answer.id, now);
          return "已采用经过评估的经验";
        }
        db.decline(scope, answer.id, now);
        return "已丢弃本次经验";
      }
      const entries = db.list(scope, now, "feedback").slice(0, 12).reverse();
      if (!entries.length) return "没事可做：没有任务反馈";
      const id = hash(["improve", scope, entries.map((e) => e.id)]);
      const saved = await generate("experience", "procedure", entries, id);
      const graph = db.graph(scope, saved!, now)!;
      if (graph.item.declined) return "没事可做：这条经验已被拒绝";
      if (graph.item.approved) return "没事可做：已采用本条经验";
      const result = graph.item.evaluation
        ? { passed: true, evidence: graph.item.evaluation }
        : ((await evaluate(graph)) as { passed: boolean; evidence: string });
      if (typeof result?.passed !== "boolean" || typeof result.evidence !== "string") throw new Error("评估结果无效");
      if (!result.passed) return "没事可做：复盘候选未通过独立评估";
      if (!graph.item.evaluation) db.evaluate(scope, id, true, result.evidence, now);
      return finish("有一条经验待采用", {
        ask: [
          {
            key: `experience-${id}`,
            title: "是否采用这条经验？",
            text: `${graph.item.text}\n评估：${result.evidence}`.slice(0, 1500),
            options: ["采用", "丢弃"],
            about: JSON.stringify({ kind: "personal-experience", scope, id }),
          },
        ],
      });
    }
    case "evaluate": {
      const row = db.graph(scope, args[0], now);
      if (!row || !["experience", "procedure"].includes(row.item.kind)) throw new Error("找不到经验候选");
      const result = (await evaluate(row)) as { passed: boolean; evidence: string };
      if (typeof result?.passed !== "boolean" || typeof result.evidence !== "string") throw new Error("评估结果无效");
      db.evaluate(scope, args[0], result.passed, result.evidence, now);
      return json(result);
    }
    case "day":
    case "month":
    case "dream":
    case "concepts":
    case "learn": {
      const from = operation === "month" ? "daily" : operation === "learn" ? "feedback" : "raw";
      const kind = { day: "daily", month: "monthly", dream: "dream", concepts: "concept", learn: "experience" }[
        operation
      ] as Entry["kind"];
      const previousMonth = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 2, 1))
        .toISOString()
        .slice(0, 7);
      const monthKey =
        args[0] ??
        ((context.events ?? []).some((event) => event.type === "schedule.tick") ? previousMonth : day.slice(0, 7));
      const entries = db
        .list(scope, now, from)
        .filter((row) =>
          operation === "day"
            ? key(config, row.at) === (args[0] ?? day)
            : operation === "month"
              ? key(config, row.at).startsWith(monthKey)
              : Date.parse(now) - Date.parse(row.at) <= 7 * 86_400_000,
        )
        .slice(0, 30)
        .reverse();
      const id = await generate(
        operation === "day"
          ? "daily"
          : operation === "month"
            ? "monthly"
            : operation === "learn"
              ? "experience"
              : operation,
        kind,
        entries,
        hash([operation, scope, operation === "month" ? monthKey : entries.map((e) => e.id)]),
      );
      return id ? `已保存${kind === "experience" ? "候选经验" : "记忆"} ${id}` : "没事可做：没有新资料";
    }
    case "feedback": {
      for (const e of context.events ?? []) {
        if (!e.summary) continue;
        db.add({
          scope,
          kind: "feedback",
          text: [e.summary, e.detail, e.link].filter(Boolean).join("\n"),
          at: now,
          id: hash(["feedback", scope, e.id]),
        });
      }
      return "已归档交付反馈";
    }
    case "extract-failures":
      return JSON.stringify(db.failedExtractions(scope));
    case "extract-retry":
      return `已重新排入 ${db.retryExtractions(scope)} 条记忆提取任务`;
    case "extract": {
      if (config.recordChats === false) return "没事可做：自动聊天记录与提取已关闭";
      const failures: unknown[] = [];
      for (const input of db.pending(scope, now)) {
        try {
          const result = (await call(role("extract", "dsh"), "extract", {
            text: input.text,
            now,
            known: db
              .list(scope, now)
              .filter((row) => ["preference", "decision", "care"].includes(row.kind))
              .slice(0, 30)
              .map((row) => ({ id: row.id, kind: row.kind, text: row.text })),
          })) as {
            entries?: { kind: string; text: string; expires?: string; replaces?: string; resolved?: boolean }[];
          };
          if (!Array.isArray(result?.entries) || result.entries.length > 8) throw new Error("记忆提取格式无效");
          for (const entry of result.entries) {
            if (
              !["preference", "decision", "care"].includes(entry.kind) ||
              typeof entry.text !== "string" ||
              !entry.text.trim() ||
              entry.text.length > 1000
            )
              throw new Error("记忆提取条目无效");
            if (entry.replaces && entry.resolved === true) {
              const old = db.get(scope, entry.replaces, now);
              if (old?.kind === "care") db.forget(scope, old.id);
              continue;
            }
            if (
              entry.kind === "care" &&
              (!entry.expires ||
                !Number.isFinite(Date.parse(entry.expires)) ||
                Date.parse(entry.expires) <= Date.parse(now) ||
                Date.parse(entry.expires) - Date.parse(now) > 30 * 86400_000)
            )
              throw new Error("关怀近况须在 30 天内到期");
            if (
              db
                .list(scope, now)
                .some(
                  (row) =>
                    row.kind === entry.kind &&
                    row.text.normalize("NFKC").trim() === entry.text.normalize("NFKC").trim(),
                )
            )
              continue;
            const value: Entry = {
              scope,
              kind: entry.kind as Entry["kind"],
              text: entry.text.trim(),
              at: now,
              expires: entry.expires,
              approved: true,
              parents: [input.id],
              vector: await embed(entry.text),
              id: hash(["extract", input.id, entry.kind, entry.text]),
            };
            if (entry.replaces) db.replace(scope, entry.replaces, value);
            else db.add(value);
          }
          db.extracted(scope, input.id);
        } catch (error) {
          signal?.throwIfAborted();
          db.deferExtraction(scope, input.id);
          failures.push(error);
        }
      }
      if (failures.length) throw failures[0];
      return "记忆提取已完成";
    }
    case "chat": {
      const query = context.events?.[0]?.detail ?? readFileSync(args[0], "utf8");
      const extra = args.slice(1).join(" ");
      const reviewer = role(extra || "chat", "claude");
      const event = context.events?.[0];
      const inputId = event ? hash(["chat", event.id]) : undefined;
      const outputId = inputId ? hash(["chat-reply", inputId]) : undefined;
      const cached = outputId && config.recordChats !== false ? db.get(scope, outputId, now) : undefined;
      if (cached && inputId && db.get(scope, inputId, now)) db.enqueue(scope, inputId);
      const memories = cached ? [] : await recall(query);
      const preferences = db
        .list(scope, now)
        .filter((row) => row.approved && ["preference", "decision"].includes(row.kind))
        .slice(0, 12)
        .map((row) => ({ kind: row.kind, text: row.text }));
      const raw = db.list(scope, now, "raw");
      const history =
        context.conversation?.flatMap((turn) => [
          ...(turn.message ? [{ role: "user", text: turn.message }] : []),
          { role: "assistant", text: turn.reply },
        ]) ??
        raw
          .filter((row) => row.tags?.includes("chat-input"))
          .slice(0, 8)
          .reverse()
          .flatMap((input) => {
            const reply = raw.find((row) => row.tags?.includes("chat-reply") && row.parents?.[0] === input.id);
            return [{ role: "user", text: input.text }, ...(reply ? [{ role: "assistant", text: reply.text }] : [])];
          });
      const text = cached?.text ?? asText(await call(reviewer, "chat", { query, memories, preferences, history }));
      if (!cached && config.recordChats !== false) {
        const parent = db.add({ scope, kind: "raw", text: query, at: now, id: inputId, tags: ["chat-input"] });
        db.add({
          scope,
          kind: "raw",
          text,
          at: now,
          id: outputId,
          tags: ["chat-reply"],
          parents: [...new Set([parent, ...memories.map((row) => row.id)])],
        });
        db.enqueue(scope, parent);
      }
      return text.replaceAll("\x60\x60\x60", "\x60 \x60 \x60");
    }
    case "morning": {
      const entries = db
        .list(scope, now)
        .filter((row) => row.approved && ["decision", "preference", "experience", "procedure"].includes(row.kind))
        .slice(0, 6);
      const month = db.list(scope, now, "monthly")[0];
      const text = [
        ...entries.map((row) => row.text),
        ...(month ? [month.text.split("\n").slice(-12).join("\n")] : []),
      ].join("\n");
      return text ? notice("做对的本本", text, `morning-${scope}-${day}`) : "没事可做：没有已确认的经验或月志";
    }
    case "巡检": {
      const due = db.due(scope, now);
      return due.length
        ? notice(
            "待办与复习",
            due
              .slice(0, 12)
              .map((row) => `${row.kind === "study" ? "复习" : "待办"} ${row.text}（${row.id}）`)
              .join("\n"),
            `check-${scope}-${day}`,
          )
        : "没事可做：没有到期待办";
    }
    case "care": {
      const recent = db.list(scope, now, "care");
      if (!config.care?.proactive || !care(config.care, now) || !recent.length) return "没事可做：此时没有关怀通知";
      const id = `care-${hash([scope, day])}`;
      let row = db.get(scope, id, now);
      if (!row) {
        const prefs = db
          .list(scope, now, "preference")
          .filter((e) => e.approved)
          .slice(0, 5);
        const response = (await call(role("care", "claude"), "care", {
          recent: recent.slice(0, 3),
          preferences: prefs,
          previous: db.list(scope, now, "care-message").slice(0, 3),
          today: db
            .list(scope, now, "raw")
            .filter((row) => key(config, row.at) === day)
            .slice(0, 16),
        })) as { text?: string; skip?: boolean };
        if (response.skip === true) {
          db.add({ scope, id, kind: "care-message", text: "今日无需主动问候", at: now, tags: ["skip"] });
          return "没事可做：本次无需主动问候";
        }
        const text = asText(response);
        db.add({
          scope,
          id,
          kind: "care-message",
          text,
          at: now,
          parents: [...recent.slice(0, 3), ...prefs].map((e) => e.id),
          expires: recent[0].expires,
        });
        row = db.get(scope, id, now);
      }
      return row?.tags?.includes("skip") ? "没事可做：本次无需主动问候" : notice("给你的简短问候", row!.text, id);
    }
    case "bugs": {
      const [project] = args;
      const source = config.bugProvider ?? config.bugFeed;
      if (!source) throw new Error("请登记 Bug 接入模块或本地 JSON 文件");
      const provider: BugProvider = config.bugProvider
        ? await extension(source)
        : { list: async () => parse(source), claim: async () => true };
      if (provider.ack && !config.bugHub) throw new Error("回写 Bug 领取结果需要登记 Bug 来源接口");
      const target = config.bugHub;
      const token = target && process.env[target.keyEnv];
      if (target && !token) throw new Error("缺少 Bug 来源凭据");
      const events = await collectBugs(provider, project, source);
      if (target && token) {
        const client = hubClient(target.url, token);
        for (const event of events) {
          const result = await client.event(event);
          if (!result.routed.length) throw new Error("Bug 来源没有匹配规则，尚未确认领取");
          await provider.ack?.(event.id, result.event);
        }
        return `已提交 ${events.length} 条 Bug 事件`;
      }
      if (events.length > 100) throw new Error("本次超过回执上限，请启用 Bug 来源直连模式");
      return finish(`发现 ${events.length} 条待修复 Bug`, { events });
    }
    case "plan": {
      const [project] = args;
      if (!/^[a-z][a-z0-9-]{0,30}$/.test(project)) throw new Error("缺少项目登记");
      const snapshot = (row: { text: string }) => JSON.parse(row.text) as { events: Event[]; answers: string[] };
      const reply = context.answers
        ?.flatMap((a) => {
          try {
            const about = JSON.parse(a.about ?? "");
            if (about.kind !== "personal-plan" || about.project !== project) return [];
            const saved = db.get(scope, about.id, now);
            return saved?.kind === "plan-input" && (a.text?.trim() || a.choice === 0 || a.choice === 1)
              ? [{ saved, choice: a.choice, text: a.choice == null ? (a.text ?? "") : "" }]
              : [];
          } catch {
            return [];
          }
        })
        .at(-1);
      const incoming = (context.events ?? []).filter((e) => e.type.startsWith(`${project}.`) && e.subject);
      const subject = incoming[0]?.subject ?? (reply && snapshot(reply.saved).events[0]?.subject);
      if (!subject && context.answers?.length) return "没事可做：等待文字补充";
      if (!subject) throw new Error("一次论证需要一个事项");
      const subjectKey = hash([project, subject]);
      const active = db.plan(scope, subjectKey, now);
      const turn = hash([incoming.map((e) => e.id), reply?.saved.id, reply?.choice, reply?.text]);
      const replay = active?.turn === turn;
      const applies = active?.waiting && reply?.saved.id === active.input.id;
      const cancelled = applies && reply?.choice === 1;
      if (!incoming.length && !replay && !applies) return "没事可做：论证问题已更新或结案";
      if (cancelled && !incoming.length) {
        db.savePlan(scope, subjectKey, active.input.id, turn, false);
        return "没事可做：本次论证已取消";
      }
      if (replay && !incoming.length && reply?.choice === 1) return "没事可做：本次论证已取消";
      const previous = replay || (active?.waiting && !cancelled) ? active.input : undefined;
      const prior = previous && snapshot(previous);
      const events = [...new Map([...(prior?.events ?? []), ...incoming].map((e) => [e.id, e])).values()];
      const answers = [...(prior?.answers ?? []), ...(!replay && applies && reply.text ? [reply.text] : [])];
      if (!events.length && context.answers?.length) return "没事可做：等待文字补充";
      if (!events.length || new Set(events.map((e) => e.subject)).size !== 1)
        throw new Error("一次论证只能处理同一事项");
      const stamp = hash([project, events.map((e) => e.id), answers]);
      const original = db.add({
        scope,
        kind: "plan-input",
        text: JSON.stringify({ events, answers }),
        at: now,
        id: stamp,
        parents: previous && previous.id !== stamp ? [previous.id] : [],
      });
      const cached = db.get(scope, `plan-${stamp}`, now);
      const task = {
        events,
        clarification: answers.join("\n"),
        memories: await recall(events.map((e) => e.summary).join(" ")),
      };
      const result = cached
        ? JSON.parse(cached.text)
        : await deliberate(task, call, role("review", "gemini"), failover);
      if (!cached)
        db.add({
          scope,
          kind: "plan-output",
          text: JSON.stringify(result),
          at: now,
          id: `plan-${stamp}`,
          parents: [...new Set([original, ...task.memories.map((row) => row.id)])],
        });
      db.savePlan(scope, subjectKey, original, turn, !!result.questions.length);
      if (result.questions.length)
        return ask("任务需要补充", result.questions.join("\n"), { kind: "personal-plan", project, id: original });
      return finish(result.singleReviewer ? "仅一位模型可用，已按单一模型论证交给 Codex" : "论证完成，已交给 Codex", {
        events: [
          ...events.slice(-8).map((e) => ({
            id: hash([stamp, e.id]),
            type: `${project}.ready`,
            subject,
            summary: e.summary,
            detail: e.detail,
            link: e.link,
          })),
          {
            id: hash([stamp, "plan"]),
            type: `${project}.ready`,
            subject,
            summary: "实施计划与验收",
            detail: fitJson({
              ...(result.singleReviewer && { review: "本轮仅有一份模型审查意见" }),
              plan: result.plan,
              risks: result.risks,
              clarification: answers.join("\n"),
            }),
          },
        ],
      });
    }
    default:
      throw new Error("未知个人 Agent 命令");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const [file, operation, ...args] = process.argv.slice(2);
    const context = process.env.AGENT_AUTOLOOP_CONTEXT ? parse(process.env.AGENT_AUTOLOOP_CONTEXT) : {};
    console.log(await run(parse(file), operation, args, context, new Date().toISOString()));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
