// The chat bridge owns intake and its outbox; the hub remains the authority for dispatch and execution.
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveIntent, canArchive, groundedChatReply, type ArchivePlan } from "./archive.ts";
import { reminderFor, reminderSlot, reminderTimeChange, scheduleReminder } from "./reminder.ts";
import {
  describeReminder,
  describeTask,
  reminderId,
  scopedReminders,
  scopedTasks,
  sortWorkItems,
  workItemText,
  type RunStatus,
  type WorkItem,
} from "./work-items.ts";

export type Message = {
  message_id: string;
  sender_id: string;
  sender_type: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  message_type: string;
  content: string;
  mentions?: { id: string; key: string; name?: string }[];
  reply_to?: string;
  root_id?: string;
  thread_id?: string;
};
export type Kind = "feature" | "change" | "bug" | "verify";
export type Project = {
  id: string;
  name: string;
  aliases: string[];
  verifyBranch?: string;
  events: Record<Exclude<Kind, "verify">, string> & { verify?: string };
};
export type TaskConfig = { timezone?: string; senders: string[]; bot: string; groups?: string[]; projects: Project[] };
export type Plan = { project: string | null; kind: Kind | null; summary: string; detail: string; questions: string[] };
export type DeliveryResult = {
  title: string;
  text: string;
  verified?: string;
  stage?: "review" | "ci" | "repair" | "mr" | "approval" | "blocked" | "complete";
};
export type ParsedMessage = Plan | { intent: "new"; plan: Plan } | { intent: "chat"; reply: string };
export type ModelIntent =
  | { intent: "chat"; reply: string }
  | { intent: "new"; plan: Plan }
  | { intent: "update"; plan: Plan; target?: string }
  | { intent: "reminder"; date: string; time: string | null; text: string }
  | { intent: "reschedule"; date: string | null; time: string | null; target?: string }
  | { intent: "status"; target?: string }
  | { intent: "confirm" | "cancel"; target?: string }
  | { intent: "archive" | "archive_status" | "unsupported" }
  | { intent: "restore_archive"; target?: string }
  | { intent: "help" | "personal" };
export type IntentInput = {
  message: string;
  messageType: string;
  conversation: { message: string; reply: string }[];
  projects: Pick<Project, "id" | "name" | "aliases" | "verifyBranch">[];
  task?: { plan: Plan; explicitReply: boolean };
  reminder?: { date: string; time: string; text: string };
  pendingReminders?: number;
  focus?: string;
  items?: Pick<WorkItem, "id" | "kind" | "title" | "state" | "scheduledAt" | "project">[];
  today: string;
  timezone: string;
  privateChat: boolean;
};
export type TaskMaterial = {
  messages: string[];
  previous?: Pick<Plan, "summary" | "questions"> | null;
  projects?: unknown[];
  projectAnswer?: string;
};
export type Proposal = {
  archive?: true;
  verify?: boolean;
  delivery?: DeliveryResult;
  task: string;
  revision: string;
  text: string;
  status: Task["state"] | "superseded";
  ref?: string;
};
type ProposalRecord = {
  revision: string;
  text: string;
  ref?: string;
  rendered?: Proposal["status"];
  deliveryHash?: string;
};
export type Task = {
  id: string;
  origin: Message;
  refs: string[];
  history: string[];
  state: "clarify" | "draft" | "queued" | "finished" | "cancelled";
  plan?: Plan;
  revision?: string;
  cards?: ProposalRecord[];
  event?: number;
  delivery?: DeliveryResult;
  lastRun?: RunStatus;
  report?: { key: string; text: string; sent: boolean };
  archived?: { at: string; batch: string };
  managementCancelled?: boolean;
};
type Decision = { task: string; revision: string; ref: string };
type ArchiveDecision = Decision & { action: "confirm" | "cancel" };
export type Envelope = {
  message: Message;
  state: "new" | "ready" | "done";
  task?: string;
  text?: string;
  dispatch?: object;
  proposal?: string;
  decision?: Decision;
  archiveDecision?: ArchiveDecision;
  archive?: ArchivePlan;
  replyTo?: string;
  reminder?: { at: number; text: string; sent?: boolean; deliveryKey?: string; supersededBy?: string };
  reminderOf?: string;
  replyRef?: string;
  conversation?: true;
  reaction?: string;
  change?: { at: string; scheduledAt: string };
  understanding?: { at: string; state: "understood" | "unavailable"; model?: string; intent?: ModelIntent["intent"] };
};
export type Ports = {
  reaction?: (message: string, previous?: string) => Promise<string | undefined>;
  delivery?: (
    request: { event: number; message: string; sender: string; project: string; type: string },
    previous?: DeliveryResult,
  ) => Promise<DeliveryResult | undefined>;
  parse: (input: TaskMaterial) => Promise<ParsedMessage>;
  interpret?: (
    input: IntentInput,
    message: Message,
    selected: (model: string) => void,
    image?: Message,
  ) => Promise<ModelIntent>;
  personal?: (message: Message, query: string) => Promise<string | undefined>;
  reply: (message: string, text: string, key: string, proposal?: Proposal) => Promise<string>;
  updateProposal?: (ref: string, proposal: Proposal) => Promise<void>;
  dispatch: (event: unknown) => Promise<{ event: number; routed: string[] }>;
  outcome: (event: number) => Promise<{ runs: RunStatus[] }>;
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const pending = (task: Task) => task.state === "draft" || task.state === "clarify";

// Async callers own their changes, not the entire snapshot they read before awaiting a port.
function changedFields<T extends object>(local: T, baseline: T, stored: T): T {
  const result = { ...stored };
  for (const key of new Set([...Object.keys(baseline), ...Object.keys(local)]) as Set<keyof T>) {
    if (JSON.stringify(local[key]) === JSON.stringify(baseline[key])) continue;
    if (local[key] === undefined) delete result[key];
    else result[key] = local[key];
  }
  return result;
}

export class TaskStore {
  db: DatabaseSync;
  private snapshots = new WeakMap<Task, Task>();
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_state ON messages(json_extract(data, '$.state'));
      CREATE INDEX IF NOT EXISTS message_scope ON messages(json_extract(data, '$.message.chat_id'), json_extract(data, '$.message.sender_id'));
      CREATE INDEX IF NOT EXISTS task_scope ON tasks(json_extract(data, '$.origin.sender_id'), json_extract(data, '$.origin.chat_id'));`);
  }
  close() {
    this.db.close();
  }
  receive(message: Message, decision?: Decision, archiveDecision?: ArchiveDecision) {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO messages VALUES (?,?)")
        .run(message.message_id, JSON.stringify({ message, state: "new", decision, archiveDecision })).changes === 1
    );
  }
  archives(): (Envelope & { archive: ArchivePlan })[] {
    return this.db
      .prepare("SELECT data FROM messages WHERE json_type(data, '$.archive') = 'object' ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  messages(): Envelope[] {
    return this.db
      .prepare("SELECT data FROM messages WHERE json_extract(data, '$.state') <> 'done' ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  reactions(): Envelope[] {
    return this.db
      .prepare(
        "SELECT data FROM messages WHERE json_extract(data,'$.state')='done' AND json_type(data,'$.reaction')='text'",
      )
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  outbound(message: Message, ref: string, text: string) {
    this.db.prepare("INSERT OR IGNORE INTO messages VALUES (?,?)").run(
      "outbound:" + ref,
      JSON.stringify({
        message: { ...message, message_id: "outbound:" + ref, content: "" },
        state: "done",
        text,
        replyRef: ref,
        conversation: true,
      }),
    );
  }
  ownerMessage(owner: string): Message | undefined {
    const row = this.db
      .prepare(
        "SELECT json_extract(data,'$.message') AS message FROM messages WHERE json_extract(data,'$.message.sender_id')=? AND json_extract(data,'$.message.chat_type')='p2p' ORDER BY rowid DESC LIMIT 1",
      )
      .get(owner);
    return row ? JSON.parse(String(row.message)) : undefined;
  }
  quotedImage(message: Message): Message | undefined {
    for (const ref of new Set([message.reply_to, message.root_id])) {
      if (!ref) continue;
      const row = this.db
        .prepare("SELECT json_extract(data, '$.message') AS message FROM messages WHERE id=?")
        .get(ref);
      if (!row?.message) continue;
      const origin: Message = JSON.parse(String(row.message));
      if (
        origin.chat_id === message.chat_id &&
        origin.chat_type === message.chat_type &&
        origin.sender_id === message.sender_id &&
        origin.message_type === "image"
      )
        return origin;
    }
  }
  rescheduleReminder(target: Envelope, at: number, response: Envelope) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed =
        this.db
          .prepare(
            "UPDATE messages SET data=json_set(data,'$.reminder.at',?,'$.reminder.deliveryKey',?) WHERE id=? AND json_extract(data,'$.reminder.at')=? AND json_extract(data,'$.reminder.sent') IS NULL",
          )
          .run(
            at,
            `ft-reminder-${hash(target.message.message_id + ":" + at)}`,
            target.message.message_id,
            target.reminder!.at,
          ).changes > 0;
      if (changed)
        this.db
          .prepare("UPDATE messages SET data=? WHERE id=?")
          .run(JSON.stringify(response), response.message.message_id);
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  reminderSent(id: string, at: number, ref: string) {
    this.db
      .prepare(
        "UPDATE messages SET data=json_set(data,'$.reminder.sent',json('true'),'$.replyRef',?) WHERE id=? AND json_extract(data,'$.reminder.at')=?",
      )
      .run(ref, id, at);
  }
  clearReaction(id: string, reaction: string) {
    this.db
      .prepare(
        "UPDATE messages SET data=json_remove(data,'$.reaction') WHERE id=? AND json_extract(data,'$.reaction')=?",
      )
      .run(id, reaction);
  }
  dueReminders(now: number): Envelope[] {
    return this.db
      .prepare(
        `SELECT data FROM messages WHERE json_extract(data, '$.state') = 'done'
          AND json_extract(data, '$.reminder.at') <= ? AND json_extract(data, '$.reminder.sent') IS NULL
          AND json_extract(data, '$.reminder.supersededBy') IS NULL ORDER BY rowid`,
      )
      .all(now)
      .map((row) => JSON.parse(String(row.data)));
  }
  reminderTarget(message: Message) {
    const candidates = scopedReminders(this.db, {
      senderId: message.sender_id,
      chatId: message.chat_id,
      privateOnly: true,
    }).filter((item) => item.state === "done" && !item.reminder.sent);
    const refs = [message.reply_to, message.root_id, message.thread_id].filter(Boolean);
    if (!refs.length) return { candidates, quoted: false, target: candidates.length === 1 ? candidates[0] : undefined };
    const linked = this.db
      .prepare(
        `SELECT json_extract(data, '$.reminderOf') AS origin FROM messages
      WHERE json_extract(data, '$.message.chat_id') = ? AND json_extract(data, '$.message.sender_id') = ?
        AND json_extract(data, '$.reminderOf') IS NOT NULL
        AND (id IN (SELECT value FROM json_each(?)) OR json_extract(data, '$.replyRef') IN (SELECT value FROM json_each(?)))`,
      )
      .all(message.chat_id, message.sender_id, JSON.stringify(refs), JSON.stringify(refs));
    const matches = candidates.filter(
      (item) =>
        refs.includes(item.message.message_id) ||
        (item.replyRef && refs.includes(item.replyRef)) ||
        linked.some((row) => row.origin === item.message.message_id),
    );
    return { candidates, quoted: true, target: matches.length === 1 ? matches[0] : undefined };
  }
  tasks(): Task[] {
    return this.db
      .prepare("SELECT data FROM tasks ORDER BY rowid DESC")
      .all()
      .map((row) => {
        const task: Task = JSON.parse(String(row.data));
        this.snapshots.set(task, structuredClone(task));
        return task;
      });
  }
  scopedTasks(scope: Parameters<typeof scopedTasks>[1]): Task[] {
    return scopedTasks(this.db, scope).map((task) => {
      this.snapshots.set(task, structuredClone(task));
      return task;
    });
  }
  conversation(message: Message): IntentInput["conversation"] {
    return this.db
      .prepare(
        `SELECT json_extract(data, '$.message.content') AS message, json_extract(data, '$.text') AS reply
        FROM messages WHERE json_extract(data, '$.message.chat_id') = ? AND json_extract(data, '$.message.sender_id') = ?
          AND json_extract(data, '$.message.chat_type') = 'p2p'
          AND json_extract(data, '$.state') = 'done' AND json_type(data, '$.text') = 'text'
        ORDER BY rowid DESC LIMIT 8`,
      )
      .all(message.chat_id, message.sender_id)
      .reverse()
      .map((row) => ({ message: String(row.message).slice(0, 1200), reply: String(row.reply).slice(0, 1600) }));
  }
  lastDiscussed(message: Message) {
    return this.db
      .prepare(
        `SELECT json_extract(data, '$.task') AS task FROM messages
        WHERE json_extract(data, '$.message.chat_id') = ? AND json_extract(data, '$.message.sender_id') = ?
          AND json_extract(data, '$.state') = 'done' AND json_extract(data, '$.task') IS NOT NULL
        ORDER BY rowid DESC LIMIT 1`,
      )
      .get(message.chat_id, message.sender_id)?.task;
  }
  save(task?: Task | Task[], ...envelopes: Envelope[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of Array.isArray(task) ? task : task ? [task] : []) {
        const existing = this.db.prepare("SELECT data FROM tasks WHERE id=?").get(row.id);
        const stored: Task | undefined = existing && JSON.parse(String(existing.data));
        const baseline = this.snapshots.get(row);
        if (baseline && stored) {
          const merged = changedFields(row, baseline, stored);
          merged.refs = [...new Set([...stored.refs, ...row.refs])];
          if (row.cards && baseline.cards && stored.cards) {
            const cards = new Map(stored.cards.map((card) => [card.revision, card]));
            for (const card of row.cards) {
              const old = baseline.cards.find((item) => item.revision === card.revision);
              const latest = cards.get(card.revision);
              if (old && latest) {
                const mergedCard = changedFields(card, old, latest);
                // The delivery loop may still hold this card across an awaited send and a save.
                for (const field of Object.keys(card) as (keyof typeof card)[]) delete card[field];
                Object.assign(card, mergedCard);
              }
              cards.set(card.revision, card);
            }
            merged.cards = [...cards.values()];
          }
          for (const field of Object.keys(row) as (keyof Task)[]) delete row[field];
          Object.assign(row, merged);
        }
        row.delivery ??= stored?.delivery;
        row.report ??= stored?.report;
        if (stored?.report?.sent && row.state === "queued") {
          row.state = stored.state;
          row.report = stored.report;
          row.delivery ??= stored.delivery;
        }
        if (stored?.managementCancelled) {
          row.state = "cancelled";
          row.managementCancelled = true;
        }
        this.db
          .prepare("INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
          .run(row.id, JSON.stringify(row));
      }
      for (const envelope of envelopes)
        this.db
          .prepare("UPDATE messages SET data=? WHERE id=?")
          .run(JSON.stringify(envelope), envelope.message.message_id);
      this.db.exec("COMMIT");
      for (const row of Array.isArray(task) ? task : task ? [task] : []) this.snapshots.set(row, structuredClone(row));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function createInbox(config: TaskConfig, store: TaskStore, ports: Ports) {
  if (!config.senders?.length || !config.bot || !config.projects?.length)
    throw new Error("飞书任务入口缺少发送人、机器人或项目配置");
  const projectIds = new Set<string>();
  const eventTypes = new Set<string>();
  for (const project of config.projects) {
    if (!/^[a-z][a-z0-9-]*$/.test(project.id) || projectIds.has(project.id))
      throw new Error("飞书任务项目编号无效或重复");
    projectIds.add(project.id);
    const types = [project.events.feature, project.events.change, project.events.bug];
    if (project.events.verify !== undefined) types.push(project.events.verify);
    for (const type of types) {
      if (typeof type !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(type) || eventTypes.has(type))
        throw new Error("飞书任务事件类型无效或重复");
      eventTypes.add(type);
    }
  }
  function authorized(input: unknown): input is Message {
    if (!input || typeof input !== "object") return false;
    const m = input as Message;
    if (m.sender_type !== "user" || !config.senders.includes(m.sender_id)) return false;
    if (!/^om_[a-zA-Z0-9_-]+$/.test(m.message_id) || !/^oc_[a-zA-Z0-9_-]+$/.test(m.chat_id)) return false;
    if (m.chat_type !== "p2p" && m.chat_type !== "group") return false;
    if (
      m.chat_type === "group" &&
      ((config.groups && !config.groups.includes(m.chat_id)) ||
        !Array.isArray(m.mentions) ||
        !m.mentions.some((mention) => mention.id === config.bot))
    )
      return false;
    if (typeof m.content !== "string") return false;
    return true;
  }
  function receive(input: unknown) {
    if (!authorized(input)) return false;
    const m = input;
    // The CLI renders text mentions as display names and post mentions as at-tags; identity was checked above.
    let content = m.content;
    for (const mention of Array.isArray(m.mentions) ? m.mentions : []) {
      if (mention.id !== config.bot) continue;
      if (typeof mention.key === "string" && mention.key) content = content.replaceAll(mention.key, "");
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const id = escape(config.bot);
      content = content.replace(new RegExp(`<at\\s+user_id=(?:"${id}"|'${id}'|${id})\\s*>[^<]*<\\/at>`, "g"), "");
      if (typeof mention.name === "string" && mention.name) {
        content = content.replace(new RegExp(`(^|\\s)@${escape(mention.name)}(?=\\s|[，,:：]|$)`, "g"), "$1");
      }
    }
    return store.receive({ ...m, content: content.trim() });
  }
  function related(m: Message, own: Task[], explicit?: string, command?: string) {
    if (explicit) return own.find((t) => t.id === explicit);
    const refs = [m.reply_to, m.root_id, m.thread_id].filter(Boolean);
    if (refs.length) {
      for (const ref of refs) {
        const target = own.find((t) => t.refs.includes(ref!));
        if (target) return target;
      }
      if (command !== "取消") return undefined;
    }
    if (m.chat_type !== "p2p") return undefined;
    const drafts = own.filter(pending);
    if (drafts.length <= 1) return drafts[0];
    // A short answer follows the last exchange. Controls still require an unambiguous target.
    if (command) return undefined;
    const last = store.lastDiscussed(m);
    return drafts.find((draft) => draft.id === last);
  }
  function proposal(task: Task, card: ProposalRecord): Proposal {
    const current = task.revision === card.revision;
    return {
      ...card,
      task: task.id,
      status: current ? task.state : "superseded",
      verify: task.plan?.kind === "verify",
      delivery: current ? task.delivery : undefined,
    };
  }
  async function refresh(task: Task) {
    if (
      task.delivery?.stage === "complete" ||
      !ports.delivery ||
      task.event === undefined ||
      !task.plan?.kind ||
      task.plan.kind === "verify" ||
      !["queued", "finished"].includes(task.state)
    )
      return;
    const project = config.projects.find((p) => p.id === task.plan?.project);
    if (!project) return;
    const result = await ports.delivery(
      {
        event: task.event,
        message: task.origin.message_id,
        sender: task.origin.sender_id,
        project: project.id,
        type: project.events[task.plan.kind],
      },
      task.delivery,
    );
    if (result && JSON.stringify(result) !== JSON.stringify(task.delivery)) {
      task.delivery = result;
      store.save(task);
    }
  }
  function proposals() {
    return [
      ...store
        .tasks()
        .filter((task) => !task.archived)
        .flatMap((task) => (task.cards ?? []).map((card) => proposal(task, card))),
      ...store.archives().map(archiveProposal),
    ];
  }
  function archiveProposal(request: Envelope & { archive: ArchivePlan }): Proposal {
    const plan = request.archive;
    return {
      archive: true,
      task: plan.id,
      revision: plan.revision,
      ref: request.replyRef,
      text: plan.result ?? plan.text,
      status: plan.status === "restored" ? "finished" : plan.status,
    };
  }
  function action(input: unknown) {
    if (!input || typeof input !== "object") return false;
    const event = input as { action_value?: unknown; operator_id?: unknown; message_id?: unknown };
    let value: any;
    try {
      value = typeof event.action_value === "string" ? JSON.parse(event.action_value) : event.action_value;
    } catch {
      return false;
    }
    if (value?.kind === "autoloop-archive") {
      const request = store.archives().find((entry) => entry.archive.id === value.task);
      if (
        !request ||
        request.archive.status !== "draft" ||
        request.archive.revision !== value.revision ||
        !request.replyRef ||
        request.replyRef !== event.message_id ||
        request.message.sender_id !== event.operator_id ||
        !authorized(request.message) ||
        !["confirm", "cancel"].includes(value.action)
      )
        return true;
      store.receive(
        {
          ...request.message,
          message_id: `om_archive_${hash(`${request.archive.id}:${request.archive.revision}:${value.action}`)}`,
        },
        undefined,
        { task: request.archive.id, revision: request.archive.revision, ref: request.replyRef, action: value.action },
      );
      return true;
    }
    if (value?.kind !== "autoloop-task") return false;
    const task = store.tasks().find((t) => t.id === value.task);
    const card = task?.cards?.find((c) => c.revision === value.revision && c.ref === event.message_id);
    if (
      !task ||
      !card?.ref ||
      task.state !== "draft" ||
      task.revision !== card.revision ||
      task.origin.sender_id !== event.operator_id ||
      !authorized(task.origin) ||
      !["confirm", "cancel"].includes(value.action)
    )
      return true;
    store.receive(
      {
        ...task.origin,
        message_id: `om_action_${hash(`${task.id}:${card.revision}:${value.action}`)}`,
        content: `${value.action === "confirm" ? "确认" : "取消"} ${task.id}`,
        message_type: "text",
        reply_to: task.origin.message_id,
      },
      { task: task.id, revision: card.revision, ref: card.ref },
    );
    return true;
  }
  function draftCard(task: Task, text: string) {
    task.revision ??= hash(`${task.origin.message_id}:${JSON.stringify(task.plan)}`);
    task.cards ??= [];
    let card = task.cards.find((c) => c.revision === task.revision);
    if (!card) {
      card = { revision: task.revision, text };
      task.cards.push(card);
    }
    return card;
  }
  async function taskStatus(task: Task) {
    try {
      await refresh(task);
      if (task.state !== "queued" || task.event === undefined) return describeTask(task);
      const run = (await ports.outcome(task.event)).runs.at(-1);
      return describeTask(task, run);
    } catch {
      return { ...describeTask(task), reason: "暂时无法核实中台最新状态" };
    }
  }
  async function archivableNow(task: Task) {
    if (task.archived) return false;
    try {
      if (task.state === "finished") await refresh(task);
      return canArchive(task);
    } catch {
      return false;
    }
  }
  async function archiveRequest(
    envelope: Envelope,
    own: Task[],
    kind: "archive" | "archive_status" | "restore_archive",
    target?: string,
  ) {
    const m = envelope.message;
    envelope.state = "ready";
    if (kind === "archive") {
      const tasks = [];
      for (const task of own) if (await archivableNow(task)) tasks.push(task);
      const held = own.filter((task) => !task.archived).length - tasks.length;
      const reminders = scopedReminders(store.db, { senderId: m.sender_id, chatId: m.chat_id }).filter(
        (row) => !row.reminder.sent,
      ).length;
      const scope = `保留 ${reminders} 条提醒和 ${held} 条未结束任务。运行中的任务如需停止，请单独通过中台确认。`;
      envelope.text = tasks.length
        ? `准备归档 ${tasks.length} 条已结束或取消的任务。\n${scope}\n\n${tasks
            .slice(0, 12)
            .map((row) => `${row.id} · ${describeTask(row).title}`)
            .join(
              "\n",
            )}${tasks.length > 12 ? `\n其余 ${tasks.length - 12} 条同样属于已结束或取消的任务。` : ""}\n\n归档后可恢复。请点「确认归档」执行。`
        : `没有可归档的已结束任务。${scope}`;
      if (tasks.length)
        envelope.archive = {
          id: hash(m.message_id).slice(0, 12),
          revision: hash(JSON.stringify(tasks.map((row) => row.id))),
          targets: tasks.map((row) => row.id),
          status: "draft",
          text: envelope.text,
        };
      store.save(undefined, envelope);
      return;
    }
    const requests = store
      .archives()
      .filter((row) => row.message.sender_id === m.sender_id && row.message.chat_id === m.chat_id);
    if (kind === "archive_status") {
      const refs = [m.reply_to, m.root_id].filter(Boolean);
      const request = refs.length
        ? requests.find((row) => refs.includes(row.message.message_id) || refs.includes(row.replyRef))
        : requests[0];
      envelope.text =
        request?.archive.status === "draft"
          ? "清理预览已生成，正在等待你确认。"
          : (request?.archive.result ?? "没有登记可跟踪的清理执行记录。");
      store.save(undefined, envelope);
      return;
    }
    const batches = new Set(own.flatMap((task) => (task.archived ? [task.archived.batch] : [])));
    const batch = target ?? requests.find((row) => batches.has(row.archive.id))?.archive.id;
    const restored = own.filter((row) => row.archived && row.archived.batch === batch);
    for (const task of restored) delete task.archived;
    envelope.text = restored.length ? `已恢复 ${restored.length} 条归档任务。` : "没有找到可恢复的归档任务。";
    const request = restored.length && requests.find((row) => row.archive.id === batch);
    if (request) {
      request.archive.status = "restored";
      request.archive.result = envelope.text;
    }
    store.save(restored, envelope, ...(request ? [request] : []));
  }
  async function applyArchive(envelope: Envelope, now: Date) {
    const choice = envelope.archiveDecision!;
    const m = envelope.message;
    const request = store
      .archives()
      .find(
        (row) =>
          row.archive.id === choice.task && row.message.sender_id === m.sender_id && row.message.chat_id === m.chat_id,
      );
    if (
      !request ||
      request.replyRef !== choice.ref ||
      request.archive.revision !== choice.revision ||
      request.archive.status !== "draft"
    ) {
      envelope.state = "done";
      store.save(undefined, envelope);
      return;
    }
    const tasks: Task[] = [];
    if (choice.action === "confirm") {
      const own = store.scopedTasks({ senderId: m.sender_id, chatId: m.chat_id });
      for (const task of own.filter((row) => request.archive.targets.includes(row.id))) {
        if (await archivableNow(task)) {
          task.archived = { at: now.toISOString(), batch: request.archive.id };
          tasks.push(task);
        }
      }
      const skipped = request.archive.targets.length - tasks.length;
      const reminders = scopedReminders(store.db, { senderId: m.sender_id, chatId: m.chat_id }).filter(
        (row) => !row.reminder.sent,
      ).length;
      const held = own.filter((row) => !row.archived && !canArchive(row)).length;
      request.archive.status = "finished";
      request.archive.result = `清理完成。已归档 ${tasks.length} 条任务，保留 ${reminders} 条提醒和 ${held} 条未结束任务。${skipped ? `有 ${skipped} 条因状态变化或暂无法核实未归档。` : ""}${tasks.length ? `可发送「恢复归档 ${request.archive.id}」撤销。` : ""}`;
    } else {
      request.archive.status = "cancelled";
      request.archive.result = "已取消本次归档。";
    }
    envelope.state = "ready";
    envelope.text = request.archive.result;
    envelope.replyTo = request.message.message_id;
    store.save(tasks, request, envelope);
  }
  async function prepare(envelope: Envelope, now: Date) {
    const m = envelope.message;
    const control =
      /^(确认|取消|状态)\s*(?:(?:这项|这个|该|此)?任务\s*)?((?:r-)?[a-f0-9]{12})?\s*(?:任务)?[。！!]?$/u.exec(
        m.content,
      );
    const command = control?.[1];
    const scope = { senderId: m.sender_id, chatId: m.chat_id };
    const own = store.scopedTasks(scope);
    let task = related(m, own, control?.[2], command);
    const privateText = m.chat_type === "p2p" && ["text", "post"].includes(m.message_type) && m.content.length <= 4000;
    const scheduled = privateText && !command ? store.reminderTarget(m) : undefined;
    const defaultReminder = scheduled?.target;
    const reminders = m.chat_type === "p2p" ? scopedReminders(store.db, scope) : [];
    const items = sortWorkItems([
      ...own.filter((row) => !row.archived).map((row) => describeTask(row)),
      ...reminders.map(describeReminder),
    ]);
    const references = [m.reply_to, m.root_id, m.thread_id].filter(Boolean);
    const quotedTask = task && references.some((ref) => task!.refs.includes(ref!)) ? task : undefined;
    const quotedReminder =
      references.length &&
      (defaultReminder ??
        reminders.find((row) => references.includes(row.message.message_id) || references.includes(row.replyRef)));
    const focus = quotedTask?.id ?? (quotedReminder ? reminderId(quotedReminder.message.message_id) : undefined);
    const projects = config.projects.map(({ id, name, aliases, verifyBranch }) => ({
      id,
      name,
      aliases,
      verifyBranch,
    }));
    let interpretation: ModelIntent | undefined;
    let material: IntentInput | undefined;
    const quotedImage = ports.interpret && ["text", "post"].includes(m.message_type) ? store.quotedImage(m) : undefined;
    const image = m.message_type === "image" ? m : quotedImage && authorized(quotedImage) ? quotedImage : undefined;
    const ownArchive = privateText && !command ? archiveIntent(m.content) : undefined;
    const ownChange = privateText && !command ? reminderTimeChange(m.content) : undefined;
    const ownReminder = privateText && !command ? reminderFor(m.content, now, config.timezone) : undefined;
    // A clarification's "确认" is still an answer to a question, not authorization to dispatch.
    const projectReply =
      task && pending(task) && config.projects.find((p) => [p.id, p.name, ...(p.aliases ?? [])].includes(m.content));
    const local =
      projectReply ||
      (command && !(command === "确认" && task?.state === "clarify")) ||
      ownArchive ||
      ownChange ||
      ownReminder ||
      m.content === "帮助" ||
      m.content === "help";
    if (ports.interpret && !envelope.decision && !local) {
      let model: string | undefined;
      try {
        material = {
          message: ["text", "post"].includes(m.message_type) ? m.content.slice(0, 4000) : "",
          messageType: m.message_type,
          conversation: m.chat_type === "p2p" ? store.conversation(m) : [],
          projects,
          focus,
          items: [
            ...items.filter((item) => item.id === focus),
            ...items.filter((item) => item.id !== focus && item.kind === "task").slice(0, 8),
            ...items.filter((item) => item.id !== focus && item.kind === "reminder").slice(0, 8),
          ].map(({ id, kind, title, state, project, scheduledAt }) => ({
            id,
            kind,
            title,
            state,
            project,
            scheduledAt,
          })),
          ...(scheduled?.candidates.length && { pendingReminders: scheduled.candidates.length }),
          ...(defaultReminder && {
            reminder: {
              ...reminderSlot(new Date(defaultReminder.reminder.at), config.timezone),
              text: defaultReminder.reminder.text,
            },
          }),
          ...(task?.plan &&
            pending(task) && {
              task: {
                plan: task.plan,
                explicitReply: [m.reply_to, m.root_id, m.thread_id].some((ref) => ref && task!.refs.includes(ref)),
              },
            }),
          today: new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeZone: config.timezone }).format(now),
          timezone: config.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
          privateChat: m.chat_type === "p2p",
        };
        interpretation = await ports.interpret(
          material,
          m,
          (selected) => {
            model = selected;
          },
          image,
        );
        envelope.understanding = { at: now.toISOString(), state: "understood", model, intent: interpretation.intent };
      } catch {
        envelope.understanding = { at: now.toISOString(), state: "unavailable" };
      }
    }
    const archive =
      ownArchive ??
      (privateText &&
      !command &&
      interpretation &&
      ["archive", "archive_status", "restore_archive"].includes(interpretation.intent)
        ? interpretation
        : undefined);
    if (
      archive &&
      (archive.intent === "archive" || archive.intent === "archive_status" || archive.intent === "restore_archive")
    ) {
      await archiveRequest(envelope, own, archive.intent, "target" in archive ? archive.target : undefined);
      return;
    }
    if (privateText && !envelope.decision && (command === "确认" || command === "取消")) {
      const id = control?.[2];
      const archiveDraft = store
        .archives()
        .some(
          (row) =>
            row.archive.status === "draft" &&
            !!row.replyRef &&
            row.message.sender_id === m.sender_id &&
            row.message.chat_id === m.chat_id &&
            (id === row.archive.id ||
              references.includes(row.message.message_id) ||
              references.includes(row.replyRef) ||
              (!id && !references.length)),
        );
      if (archiveDraft) {
        envelope.state = "ready";
        envelope.text = "请在归档卡片上选择「确认归档」或「取消」。要确认项目任务，请使用项目任务的确认卡。";
        store.save(undefined, envelope);
        return;
      }
    }
    let text: string;
    const change =
      privateText && !command ? (interpretation?.intent === "reschedule" ? interpretation : ownChange) : undefined;
    if (change) {
      envelope.state = "ready";
      const named = "target" in change ? change.target : undefined;
      const bareChange = !!reminderTimeChange(m.content);
      const target =
        named && (!bareChange || scheduled?.candidates.length === 1 || scheduled?.quoted)
          ? scheduled?.candidates.find(
              (row) =>
                reminderId(row.message.message_id) === named &&
                (!scheduled.quoted || row.message.message_id === defaultReminder?.message.message_id),
            )
          : defaultReminder;
      const slot = target && reminderSlot(new Date(target.reminder.at), config.timezone);
      if (!target || !slot) {
        envelope.text =
          (scheduled?.candidates.length ?? 0) > 1
            ? "你有多条待发送的提醒，请回复要改时间的那条提醒。"
            : "我还没找到你要改时间的那条提醒，请回复原提醒消息。";
        store.save(undefined, envelope);
        return;
      }
      const result = scheduleReminder(
        change.date ?? slot.date,
        change.time ?? slot.time,
        target.reminder.text,
        now,
        config.timezone,
      );
      if ("error" in result) {
        envelope.text = result.error;
        store.save(undefined, envelope);
        return;
      }
      envelope.reminderOf = target.message.message_id;
      envelope.change = { at: now.toISOString(), scheduledAt: new Date(result.at).toISOString() };
      envelope.text = `已改到 ${result.when} 提醒你：\n${result.text}`;
      if (!store.rescheduleReminder(target, result.at, envelope)) {
        delete envelope.reminderOf;
        delete envelope.change;
        envelope.text = "原提醒已发送或时间已改变，请重新确认要修改的提醒。";
        store.save(undefined, envelope);
      }
      return;
    }
    const reminder =
      !command && privateText && (!interpretation || interpretation.intent === "reminder")
        ? (ownReminder ??
          (interpretation?.intent === "reminder"
            ? scheduleReminder(interpretation.date, interpretation.time, interpretation.text, now, config.timezone)
            : undefined))
        : undefined;
    if (
      m.content.length > 4000 ||
      (!interpretation && !["text", "post", ...(ports.interpret ? ["image"] : [])].includes(m.message_type))
    ) {
      text = "请用不超过 4000 字的文字说明项目、要改什么和验收条件；图片或文件请附在参考链接中。";
    } else if (
      m.chat_type === "p2p" &&
      ports.personal &&
      !command &&
      (interpretation?.intent === "personal" || (!ports.interpret && /^个人\s+/.test(m.content)))
    ) {
      task = undefined;
      text = groundedChatReply(
        (await ports.personal(m, m.content.replace(/^个人\s+/, ""))) ?? "此账号没有配置个人聊天。",
      );
    } else if (reminder) {
      task = undefined;
      if ("error" in reminder) text = reminder.error;
      else {
        envelope.reminder = { at: reminder.at, text: reminder.text };
        text = `已安排 ${reminder.when} 提醒你：\n${reminder.text}`;
      }
    } else if ((!command && interpretation?.intent === "help") || m.content === "帮助" || m.content === "help") {
      task = undefined;
      text = `可用项目：${config.projects.map((p) => `${p.name}（${p.id}）`).join("、")}。\n直接描述任务，我会整理摘要；确认后才开工。回复“确认 任务号”“取消 任务号”或“状态 任务号”。群内每条消息都需要 @ 机器人。`;
    } else if (interpretation?.intent === "status" && !command) {
      task = undefined;
      const targetId = focus ?? interpretation.target;
      const selected = targetId
        ? items.filter((item) => item.id === targetId)
        : items.filter((item) => item.active).slice(0, 8);
      const details = await Promise.all(
        selected.map(async (item) => {
          const project = item.kind === "task" && own.find((row) => row.id === item.id);
          return workItemText(project ? await taskStatus(project) : item);
        }),
      );
      text = details.join("\n\n") || (targetId ? "没找到这个事项，请回复它的原消息。" : "目前没有待处理的任务或提醒。");
    } else if (command === "状态") {
      if (!task && m.content === "状态" && m.chat_type === "p2p") task = own[0];
      const item = task
        ? await taskStatus(task)
        : items.find((item) => item.kind === "reminder" && item.id === control?.[2]);
      text = item ? workItemText(item) : "没有找到这项任务，请回复原事项消息，或使用“状态 事项编号”。";
    } else if (command === "取消") {
      if (task && pending(task)) {
        task.state = "cancelled";
        text = `已取消待确认任务 ${task.id}。`;
      } else if (!task && !control?.[2] && m.chat_type === "p2p") {
        const choices = store
          .tasks()
          .filter((t) => pending(t) && t.origin.sender_id === m.sender_id && t.origin.chat_id === m.chat_id);
        text =
          choices.length > 1
            ? "要取消哪一项？回复对应的卡片，或发送“取消 任务号”。\n" +
              choices.map((t) => t.id + "　" + (t.plan?.summary || t.origin.content)).join("\n")
            : "没有找到要取消的待办，可以回复原任务消息。";
      } else
        text =
          task?.state === "cancelled" ? "这项任务已经取消了。" : "没有可取消的待确认任务。已派发的任务请通过中台停止。";
    } else if (command === "确认" && task?.state !== "clarify") {
      if (!task || task.state !== "draft" || !task.plan?.project || !task.plan.kind) {
        text = "没有可确认的任务，请先补齐项目和任务内容，或回复原任务消息中的确认指令。";
      } else if (!config.projects.some((p) => p.id === task!.plan!.project)) {
        task.state = "cancelled";
        text = "这项任务的项目配置已移除，请选择当前已登记项目后重新提交。";
      } else {
        const project = config.projects.find((p) => p.id === task!.plan!.project)!;
        envelope.dispatch = {
          id: `feishu:${task.origin.message_id}`,
          type: project.events[task.plan.kind],
          subject: `feishu-${task.origin.message_id}`,
          summary: task.plan.summary,
          detail: `${task.plan.detail}\n\n飞书任务号：${task.id}。需求摘要已由原发送人确认。`,
        };
        text = `已提交任务 ${task.id}：${task.plan.summary}。执行结果会回复到原消息，需要决定时还会收到私聊卡片。`;
      }
    } else if (interpretation?.intent === "confirm" || interpretation?.intent === "cancel") {
      const action = interpretation.intent === "confirm" ? "确认" : "取消";
      const targetId = interpretation.target;
      const target = references.length
        ? quotedTask
        : targetId
          ? own.find((row) => row.id === targetId)
          : related(m, own, undefined, action);
      task = undefined;
      if (target?.state === "clarify")
        text =
          action === "确认"
            ? `任务 ${target.id} 还需补充：\n${target.plan?.questions[0] || "请补齐项目和任务内容。"}`
            : `如需取消这项待补充任务，请发送“取消 ${target.id}”。`;
      else if (target?.state === "draft") {
        const card = target.cards?.find((row) => row.revision === target.revision && row.ref);
        text = card
          ? `请在任务 ${target.id} 的确认卡上选择「${action}」，或发送“${action} ${target.id}”。`
          : `请发送“${action} ${target.id}”。`;
      } else {
        const choices = own.filter(pending);
        text = target
          ? "这项任务已不在待确认阶段。已派发的任务请通过中台停止。"
          : choices.length
            ? `请指定任务，发送“${action} 任务号”：\n` +
              choices.map((row) => `${row.id}　${row.plan?.summary || row.origin.content}`).join("\n")
            : "没有可确认或取消的待办。";
      }
    } else if (interpretation?.intent === "chat") {
      task = undefined;
      envelope.conversation = true;
      text = groundedChatReply(
        (privateText && ports.personal ? await ports.personal(m, m.content) : undefined) ?? interpretation.reply,
      );
    } else if (interpretation?.intent === "unsupported") {
      task = undefined;
      text = "目前无法通过飞书执行这项操作，也没有登记完成通知。";
    } else if (ports.interpret && !interpretation) {
      task = undefined;
      text = image
        ? "我暂时没能读到这张图，可以晚点重发，或先告诉我你想让我看哪部分。"
        : "我刚才没能读懂这条消息，可以再发一次。";
    } else if (!m.content && m.message_type !== "image") {
      text = "请说明项目、要改什么，以及预期结果。";
    } else {
      if (task && !pending(task)) task = undefined;
      const matches = task
        ? config.projects.filter((p) => [p.id, p.name, ...(p.aliases ?? [])].includes(m.content))
        : [];
      const projectAnswer = matches.length === 1 ? matches[0].id : undefined;
      if (projectAnswer && task?.state === "draft" && task.plan?.project === projectAnswer) {
        envelope.state = "ready";
        envelope.task = task.id;
        envelope.text = `任务 ${task.id} 已选项目 ${projectAnswer}，可以在这项任务的确认卡上继续。`;
        store.save(undefined, envelope);
        return;
      }
      let history = [...(task?.history ?? []), m.content];
      let result: ParsedMessage;
      try {
        if (interpretation?.intent === "new") result = { intent: "new", plan: interpretation.plan };
        else if (interpretation?.intent === "update") {
          const targetId = interpretation.target;
          const named = targetId && own.find((row) => row.id === targetId);
          const quote = !!(m.reply_to || m.root_id || m.thread_id);
          const chosen = targetId ? (named && (!quote || named.id === task?.id) ? named : undefined) : task;
          if (!chosen || !pending(chosen)) {
            envelope.state = "ready";
            envelope.text = "请回复你要补充的那条待确认任务。";
            store.save(undefined, envelope);
            return;
          }
          if (material && ports.interpret && chosen.plan && task?.id !== chosen.id) {
            const next = await ports.interpret(
              { ...material, focus: chosen.id, task: { plan: chosen.plan, explicitReply: true } },
              m,
              () => {},
              image,
            );
            if (next.intent !== "update" || (next.target && next.target !== chosen.id)) {
              envelope.state = "ready";
              envelope.text = "我找到了这项任务，请再确认一下要补充的内容。";
              store.save(undefined, envelope);
              return;
            }
            interpretation = next;
          }
          task = chosen;
          history = [...task.history, m.content];
          result = interpretation.plan;
        } else if (interpretation) {
          envelope.state = "ready";
          envelope.text = "请回复你要补充的那条任务消息，或再说明一下想让我做什么。";
          store.save(undefined, envelope);
          return;
        } else
          result = await ports.parse({
            projects,
            messages: history,
            previous: task?.plan ?? null,
            ...(projectAnswer && { projectAnswer }),
          });
      } catch {
        envelope.state = "ready";
        envelope.text = "这条消息暂未解析成功，尚未派发。等会儿可以再发一次。";
        store.save(undefined, envelope);
        return;
      }
      if ("intent" in result && result.intent === "chat") {
        envelope.state = "ready";
        envelope.text = groundedChatReply(result.reply);
        store.save(undefined, envelope);
        return;
      }
      if ("intent" in result && !projectAnswer) {
        task = undefined;
        history = [m.content];
      }
      const parsed = "intent" in result ? result.plan : result;
      if (history.join("\n").length > 16000) {
        text = "这项任务的补充内容过长，请取消后重新提交一份整理好的需求。";
      } else {
        task ??= {
          id: hash(m.message_id).slice(0, 12),
          origin: m,
          refs: [m.message_id, m.thread_id].filter(Boolean) as string[],
          history: [],
          state: "clarify",
        };
        const project = config.projects.find((p) => p.id === parsed.project);
        const validProject = !!project;
        const validKind = ["feature", "change", "bug", "verify"].includes(parsed?.kind ?? "");
        const questions = Array.isArray(parsed?.questions)
          ? parsed.questions.filter((q) => typeof q === "string").slice(0, 5)
          : [];
        if (!validProject) questions.push("请明确选择一个已登记项目。");
        if (!validKind && !questions.length) questions.push("你想运行已有检查，还是需要修改代码？");
        if (parsed.kind === "verify" && project && !project.events.verify) {
          envelope.state = "ready";
          envelope.text = project.name + "还没有登记验收流程，请先配置项目验收规则。";
          store.save(undefined, envelope);
          return;
        }
        if (
          typeof parsed?.summary !== "string" ||
          !parsed.summary.trim() ||
          parsed.summary.length > 200 ||
          typeof parsed?.detail !== "string" ||
          !parsed.detail.trim() ||
          parsed.detail.length > 3500
        ) {
          questions.push("请补充清晰、适当长度的任务说明和验收条件。");
        }
        task.history = history;
        task.refs = [...new Set([...task.refs, m.message_id])];
        // Only validated fields survive the parser; no model-selected paths, commands or permissions exist here.
        task.plan = {
          project: validProject ? parsed.project : null,
          kind: validKind ? parsed.kind : null,
          summary: typeof parsed?.summary === "string" ? parsed.summary.slice(0, 200) : "",
          detail: typeof parsed?.detail === "string" ? parsed.detail.slice(0, 3500) : "",
          questions: questions.slice(0, 1),
        };
        task.state = questions.length ? "clarify" : "draft";
        task.revision = hash(`${m.message_id}:${JSON.stringify(task.plan)}`);
        text = questions.length
          ? `任务 ${task.id} 还需补充：\n${questions[0]}`
          : parsed.kind === "verify"
            ? `${project!.name} · 只验收\n${parsed.summary}\n在${project!.verifyBranch || "已登记的目标分支"}运行项目检查，保留现有代码，无需提 MR。`
            : `待确认任务 ${task.id}\n项目：${project!.name}\n类型：${{ feature: "新增功能", change: "修改", bug: "修复 Bug" }[parsed.kind as Exclude<Kind, "verify">]}\n${task.plan.summary}\n${ports.interpret ? `\n${task.plan.detail}` : ""}`;
        if (task.state === "draft") envelope.proposal = draftCard(task, text).revision;
      }
    }
    envelope.state = "ready";
    envelope.text = text;
    envelope.task = task?.id;
    store.save(task, envelope);
  }
  const laneOf = (message: Message) => `${message.chat_id}:${message.sender_id}`;
  const maintenance = new Map<string, Promise<void>>();
  async function maintain(now: Date, selectedLane: string) {
    const errors: unknown[] = [];
    for (const envelope of store.dueReminders(now.getTime()).filter((row) => laneOf(row.message) === selectedLane)) {
      const m = envelope.message;
      if (!authorized(m)) continue;
      try {
        const reminder = envelope.reminder!;
        const ref = await ports.reply(
          m.message_id,
          `待办提醒\n${reminder.text}`,
          reminder.deliveryKey ?? `ft-reminder-${hash(m.message_id)}`,
        );
        store.outbound(m, ref, `待办提醒\n${reminder.text}`);
        store.reminderSent(m.message_id, reminder.at, ref);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const task of store
      .tasks()
      .filter((t) => laneOf(t.origin) === selectedLane && t.state === "queued" && t.event !== undefined)) {
      if (!authorized(task.origin)) continue;
      try {
        if (!task.report) {
          const result = await ports.outcome(task.event!);
          const run = result.runs.at(-1);
          if (!run) continue;
          const { id, run: number, state, stopping, attempts, error } = run;
          const progress = { id, run: number, state, stopping, attempts, ...(error && { error: "本轮有执行错误" }) };
          if (JSON.stringify(task.lastRun) !== JSON.stringify(progress)) {
            task.lastRun = progress;
            store.save(task);
          }
          if (!["done", "nothing", "cancelled"].includes(run.state)) continue;
          task.report = {
            key: `ft-result-${task.id}`,
            text: `任务 ${task.id} 本轮${run.state === "cancelled" ? "已停止" : "已结束"}：\n${run.summary || run.error || "请查看中台记录"}`,
            sent: false,
          };
          if (task.plan?.kind === "verify")
            task.delivery = {
              title:
                run.state === "cancelled"
                  ? "验收已停止"
                  : run.summary?.startsWith("验收通过")
                    ? "验收通过"
                    : "验收未通过",
              text: run.summary || run.error || "请查看中台记录",
            };
          store.save(task);
        }
        if (!task.report.sent) {
          await ports.reply(task.origin.message_id, task.report.text, task.report.key);
          task.report.sent = true;
          task.state = "finished";
          store.save(task);
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  }
  const running = new Map<string, Promise<void>>();
  let cleaning: Promise<void> | undefined;
  let laneCursor = 0;
  async function tick(now = new Date()) {
    const lanes = new Set([
      ...store.messages().map((row) => laneOf(row.message)),
      ...store.tasks().map((row) => laneOf(row.origin)),
      ...store.dueReminders(now.getTime()).map((row) => laneOf(row.message)),
    ]);
    const jobs: Promise<void>[] = [];
    if (ports.reaction && !cleaning) {
      cleaning = (async () => {
        for (const envelope of store.reactions()) {
          try {
            await ports.reaction!(envelope.message.message_id, envelope.reaction);
            store.clearReaction(envelope.message.message_id, envelope.reaction!);
          } catch {}
        }
      })().finally(() => {
        cleaning = undefined;
      });
      jobs.push(cleaning);
    }

    const order = [...lanes];
    const start = laneCursor % Math.max(1, order.length);
    laneCursor = (start + 4) % Math.max(1, order.length);
    for (const lane of [...order.slice(start), ...order.slice(0, start)]) {
      if (!maintenance.has(lane) && maintenance.size < 4) {
        const job = maintain(now, lane).finally(() => maintenance.delete(lane));
        maintenance.set(lane, job);
        jobs.push(job);
      }
      if (running.has(lane) || running.size >= 4) continue;
      const laneJob = tickLane(now, lane).finally(() => running.delete(lane));
      running.set(lane, laneJob);
      const job = laneJob.then(async () => {
        await maintenance.get(lane);
        if (!maintenance.has(lane) && maintenance.size < 4) {
          const finish = maintain(now, lane).finally(() => maintenance.delete(lane));
          maintenance.set(lane, finish);
          await finish;
        }
      });
      jobs.push(job);
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  async function tickLane(now: Date, selectedLane: string) {
    const errors: unknown[] = [];
    const blocked = new Set<string>();
    const lane = (message: Message) => `${message.chat_id}:${message.sender_id}`;
    for (const envelope of store.messages().filter((row) => laneOf(row.message) === selectedLane)) {
      if (blocked.has(lane(envelope.message))) continue;
      try {
        if (!authorized(envelope.message)) {
          envelope.state = "done";
          store.save(undefined, envelope);
          continue;
        }
        if (envelope.state === "new" && ports.reaction && !envelope.reaction) {
          try {
            envelope.reaction = await ports.reaction(envelope.message.message_id);
            store.save(undefined, envelope);
          } catch {}
        }
        if (envelope.state === "new" && envelope.decision) {
          const choice = envelope.decision;
          const task = store.tasks().find((t) => t.id === choice.task);
          if (
            !task ||
            task.state !== "draft" ||
            task.revision !== choice.revision ||
            !task.cards?.some((c) => c.revision === choice.revision && c.ref === choice.ref)
          ) {
            envelope.state = "done";
            store.save(undefined, envelope);
            continue;
          }
        }
        if (envelope.state === "new") {
          if (envelope.archiveDecision) await applyArchive(envelope, now);
          else await prepare(envelope, now);
        }
        if (envelope.state === "done") continue;
        const task = store.tasks().find((t) => t.id === envelope.task);
        if (envelope.dispatch && task?.state === "cancelled") {
          delete envelope.dispatch;
          envelope.text = "这项任务已经取消，未派发。";
          store.save(task, envelope);
        }
        if (envelope.dispatch && task && task.event === undefined) {
          const project = config.projects.find((p) => p.id === task.plan?.project);
          const type = project && task.plan?.kind && project.events[task.plan.kind];
          if (!type || type !== (envelope.dispatch as { type?: string }).type) {
            envelope.text = "这项任务的项目或事件配置已变化，未派发。请按当前项目配置重新提交。";
            task.state = "cancelled";
            delete envelope.dispatch;
            store.save(task, envelope);
          } else {
            const result = await ports.dispatch(envelope.dispatch);
            if (!result.routed.length) {
              envelope.text = `任务 ${task.id} 未派发：没有匹配的启用规则，请管理员检查来源、事件类型和暂停状态。`;
              task.state = "cancelled";
            } else {
              task.event = result.event;
              task.state = "queued";
            }
            store.save(task, envelope);
          }
        }
        const card = task?.cards?.find((c) => c.revision === envelope.proposal);
        const view = envelope.archive
          ? archiveProposal({ ...envelope, archive: envelope.archive })
          : task && card
            ? proposal(task, card)
            : undefined;
        const ref =
          card?.ref ??
          (await ports.reply(
            envelope.replyTo ?? (envelope.decision ? task!.origin.message_id : envelope.message.message_id),
            envelope.text!,
            card ? `ft-card-${task!.id}-${card.revision}` : `ft-${hash(envelope.message.message_id)}`,
            view,
          ));
        if (card) {
          card.ref = ref;
          card.rendered = view!.status;
        }
        if (task && !task.refs.includes(ref)) task.refs.push(ref);
        if (envelope.reminder || envelope.reminderOf || envelope.archive) envelope.replyRef = ref;
        if (envelope.archive) envelope.archive.rendered = envelope.archive.status;
        envelope.state = "done";
        store.save(task, envelope);
      } catch (error) {
        errors.push(error);
        blocked.add(lane(envelope.message));
      }
    }
    if (ports.updateProposal)
      for (const request of store.archives().filter((row) => laneOf(row.message) === selectedLane)) {
        if (!authorized(request.message) || !request.replyRef || request.archive.status === request.archive.rendered)
          continue;
        try {
          await ports.updateProposal(request.replyRef, archiveProposal(request));
          request.archive.rendered = request.archive.status;
          store.save(undefined, request);
        } catch (error) {
          errors.push(error);
        }
      }
    // Existing text-only drafts acquire a card without reparsing or starting development.
    for (const task of store.tasks().filter((row) => laneOf(row.origin) === selectedLane)) {
      if (task.archived || !authorized(task.origin) || blocked.has(lane(task.origin))) continue;
      try {
        if (task.state === "draft" && task.plan && !task.cards?.some((c) => c.revision === task.revision)) {
          draftCard(
            task,
            `待确认任务 ${task.id}\n${task.plan.summary}\n\n${task.plan.detail}\n\n点击确认开始，取消则结束本任务。也可回复文字补充修改。`,
          );
          store.save(task);
        }
        await refresh(task);
        for (const card of task.cards ?? []) {
          const view = proposal(task, card);
          const deliveryHash = view.delivery
            ? hash(JSON.stringify([view.delivery.title, view.delivery.text]))
            : undefined;
          if (!card.ref) {
            card.ref = await ports.reply(
              task.origin.message_id,
              card.text,
              `ft-card-${task.id}-${card.revision}`,
              view,
            );
            task.refs.push(card.ref);
            card.deliveryHash = deliveryHash;
            card.rendered = view.status;
            store.save(task);
          } else if ((card.rendered !== view.status || card.deliveryHash !== deliveryHash) && ports.updateProposal) {
            await ports.updateProposal(card.ref, view);
            card.deliveryHash = deliveryHash;
            card.rendered = view.status;
            store.save(task);
          }
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
  }
  return {
    receive,
    tick,
    action,
    proposals,
    drain: () => Promise.allSettled([...running.values(), ...maintenance.values(), ...(cleaning ? [cleaning] : [])]),
  };
}
