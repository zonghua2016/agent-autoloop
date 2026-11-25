import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Envelope, Task } from "./inbox.ts";

type Scope = { senderId: string; chatId?: string; privateOnly?: boolean };
export type ReminderRecord = Envelope & { reminder: NonNullable<Envelope["reminder"]> };
export type RunStatus = {
  id?: number;
  run?: number;
  state: string;
  stopping?: boolean;
  error?: string;
  summary?: string;
  attempts?: number;
};
type HubRun = RunStatus & { events?: { source: string; subject: string }[] };
export type WorkItem = {
  id: string;
  kind: "task" | "reminder";
  title: string;
  state: string;
  reason?: string;
  active: boolean;
  project?: string;
  scheduledAt?: string;
  run?: number;
  cancellable?: boolean;
  activity?: { label: string; at: string }[];
};

const taskLabels = {
  clarify: "等待补充",
  draft: "等待确认",
  queued: "已派发",
  finished: "本轮已结束",
  cancelled: "已取消",
};
const title = (value: string) => value.trim().split(/\r?\n/, 1)[0].slice(0, 160);
export const reminderId = (id: string) => "r-" + createHash("sha256").update(id).digest("hex").slice(0, 12);

function scopeFilter(field: "origin" | "message") {
  return `json_extract(data, '$.${field}.sender_id') = ?
    AND (? IS NULL OR json_extract(data, '$.${field}.chat_id') = ?)
    AND (? = 0 OR json_extract(data, '$.${field}.chat_type') = 'p2p')`;
}

function scopeParams(scope: Scope) {
  return [scope.senderId, scope.chatId ?? null, scope.chatId ?? null, scope.privateOnly ? 1 : 0] as const;
}

export function scopedTasks(db: DatabaseSync, scope: Scope): Task[] {
  return db
    .prepare(`SELECT data FROM tasks WHERE ${scopeFilter("origin")} ORDER BY rowid DESC`)
    .all(...scopeParams(scope))
    .map((row) => JSON.parse(String(row.data)));
}

export function scopedReminders(db: DatabaseSync, scope: Scope): ReminderRecord[] {
  return db
    .prepare(
      `SELECT data FROM messages WHERE ${scopeFilter("message")}
    AND json_extract(data, '$.reminder.at') IS NOT NULL AND json_extract(data, '$.reminder.supersededBy') IS NULL
    ORDER BY rowid DESC`,
    )
    .all(...scopeParams(scope))
    .map((row) => JSON.parse(String(row.data)));
}

export function describeTask(task: Task, current = task.lastRun): WorkItem {
  const result: WorkItem = {
    id: task.id,
    kind: "task",
    title: title(task.plan?.summary || task.origin.content) || "项目任务",
    state: taskLabels[task.state],
    active: ["clarify", "draft", "queued"].includes(task.state),
    cancellable: ["clarify", "draft"].includes(task.state),
    ...(task.plan?.project && { project: task.plan.project }),
  };
  if (task.state === "clarify") result.reason = task.plan?.questions[0];
  if (task.state === "draft") result.reason = "等发起人确认当前需求卡片";
  const run = current?.id ?? current?.run;
  if (run && Number.isSafeInteger(run)) result.run = run;
  if (task.state === "queued" && current) {
    if (current.state === "queued") result.state = current.error || current.attempts ? "等待重试" : "排队中";
    if (current.state === "claimed") result.state = current.stopping ? "正在停止" : "执行中";
    if (current.state === "unknown") result.state = "接单状态待确认";
    if (["done", "nothing", "cancelled"].includes(current.state)) result.state = "等执行回执";
  }
  const delivery = task.delivery;
  if (delivery?.stage || (delivery && task.state === "finished")) {
    result.state = delivery.title;
    result.reason = delivery.text.slice(0, 900);
    if (delivery.stage) result.active = delivery.stage !== "complete";
  } else if (task.report) result.reason = task.report.text.slice(0, 900);
  return result;
}

export function describeReminder(record: ReminderRecord): WorkItem {
  const reminder = record.reminder;
  return {
    id: reminderId(record.message.message_id),
    kind: "reminder",
    title: title(reminder.text),
    state: reminder.sent ? "已提醒" : record.state === "ready" ? "待发送排程回执" : "待提醒",
    active: !reminder.sent,
    scheduledAt: new Date(reminder.at).toISOString(),
  };
}

export function sortWorkItems(items: WorkItem[]) {
  return items.sort((a, b) => Number(b.active) - Number(a.active));
}

export function readWorkItems(file: string, scope: Scope, options: { source?: string; runs?: HubRun[] } = {}) {
  if (!existsSync(file)) return { items: [], intake: undefined };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const tasks = scopedTasks(db, scope).filter((task) => !task.archived);
    const reminders = scopedReminders(db, scope);
    const items = sortWorkItems([
      ...tasks.map((task) =>
        describeTask(
          task,
          options.runs?.find((run) =>
            run.events?.some(
              (event) => event.source === options.source && event.subject === `feishu-${task.origin.message_id}`,
            ),
          ) ?? task.lastRun,
        ),
      ),
      ...reminders.map(describeReminder),
    ]).slice(0, 36);
    for (const record of reminders) {
      const item = items.find((entry) => entry.id === reminderId(record.message.message_id));
      if (!item) continue;
      item.activity = db
        .prepare(
          `SELECT json_extract(data, '$.change.at') AS at, json_extract(data, '$.change.scheduledAt') AS scheduled
        FROM messages WHERE ${scopeFilter("message")} AND json_extract(data,'$.reminderOf') = ?
        AND json_extract(data,'$.change.at') IS NOT NULL ORDER BY rowid DESC LIMIT 12`,
        )
        .all(...scopeParams(scope), record.message.message_id)
        .reverse()
        .map((row) => ({ at: String(row.at), label: "改期 · " + localTime(String(row.scheduled)) }));
    }
    const record = db
      .prepare(
        `SELECT json_extract(data, '$.understanding') AS value FROM messages
      WHERE ${scopeFilter("message")} AND json_extract(data, '$.understanding') IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
      )
      .get(...scopeParams(scope));
    const intake = record?.value
      ? (JSON.parse(String(record.value)) as NonNullable<Envelope["understanding"]>)
      : undefined;
    return { items, intake };
  } finally {
    db.close();
  }
}

export function localTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", hourCycle: "h23" }).format(
    new Date(value),
  );
}

export function workItemText(item: WorkItem) {
  return [
    `${item.title}（${item.state} · ${item.id}）`,
    item.scheduledAt && `提醒时间 ${localTime(item.scheduledAt)}`,
    item.run && `中台轮次 #${item.run}`,
    item.reason,
  ]
    .filter(Boolean)
    .join("\n");
}

// The bridge refreshes the existing proposal; a cancelled task can never be revived by a stale model result.
export function cancelDraft(file: string, scope: Scope, id: string) {
  if (!existsSync(file)) throw Object.assign(new Error("没有此事项"), { status: 404 });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    const task = scopedTasks(db, scope).find((task) => task.id === id && !task.archived);
    if (!task) throw Object.assign(new Error("没有获准的本人事项"), { status: 404 });
    if (task.managementCancelled) {
      db.exec("COMMIT");
      return { changed: false };
    }
    if (
      !["draft", "clarify"].includes(task.state) ||
      db
        .prepare("SELECT 1 FROM messages WHERE json_extract(data,'$.task')=? AND json_type(data,'$.dispatch')='object'")
        .get(id)
    )
      throw Object.assign(new Error("该事项已开始派发，请刷新后通过中台停止轮次"), { status: 409 });
    task.state = "cancelled";
    task.managementCancelled = true;
    db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(task), id);
    db.exec("COMMIT");
    return { changed: true, cardSync: "pending" };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
