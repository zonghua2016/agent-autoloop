// Guards chat-to-code boundaries: unauthorized messages, wrong mentions, guessed projects, duplicate deliveries,
// cross-user confirmations, and restarts must not start unintended or repeated development tasks.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createInbox,
  TaskStore,
  type Message,
  type Plan,
  type ParsedMessage,
  type TaskConfig,
  type Ports,
} from "../plugins/feishu-tasks/inbox.ts";
import { renderProposal } from "../plugins/feishu-tasks/card.ts";
import { readWorkItems } from "../plugins/feishu-tasks/work-items.ts";

const config: TaskConfig = {
  senders: ["ou_owner"],
  bot: "ou_bot",
  projects: [
    {
      id: "palette",
      name: "命令面板",
      aliases: ["组件库"],
      events: {
        feature: "palette.feature",
        change: "palette.change",
        bug: "palette.bug",
        verify: "palette.verify",
      },
    },
  ],
};
const plan: Plan = {
  project: "palette",
  kind: "feature",
  summary: "新增按键提示",
  detail: "新增按键提示组件，支持按键数组，构建通过。",
  questions: [],
};
const message = (id: string, content: string, extra: Partial<Message> = {}): Message => ({
  message_id: id,
  sender_id: "ou_owner",
  sender_type: "user",
  chat_id: "oc_private",
  chat_type: "p2p",
  message_type: "text",
  content,
  ...extra,
});

function fixture(
  t: { after: (fn: () => void) => void },
  parse = async (_input: unknown): Promise<ParsedMessage> => plan,
  interpret?: Ports["interpret"],
) {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-feishu-tasks-"));
  const file = join(dir, "tasks.db");
  let store = new TaskStore(file);
  const connections: TaskStore[] = [];
  t.after(() => {
    for (const connection of connections) connection.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const replies: { id: string; text: string; key: string }[] = [];
  const events: any[] = [];
  let parsed = 0;
  const ports = {
    interpret,
    parse: async (input: unknown) => {
      parsed++;
      return parse(input);
    },
    reply: async (id: string, text: string, key: string) => {
      replies.push({ id, text, key });
      return `om_reply_${replies.length}`;
    },
    dispatch: async (event: unknown) => {
      events.push(event);
      return { event: 41, routed: ["palette"] };
    },
    outcome: async (_id: number): Promise<any> => ({ runs: [] }),
  };
  let inbox = createInbox(config, store, ports);
  return {
    get inbox() {
      return inbox;
    },
    replies,
    events,
    ports,
    file,
    parsed: () => parsed,
    openStore() {
      const connection = new TaskStore(file);
      connections.push(connection);
      return connection;
    },
    restart() {
      store.close();
      store = new TaskStore(file);
      inbox = createInbox(config, store, ports);
    },
  };
}

test("explicit controls and standard reminders work without calling the model", async (t) => {
  let calls = 0;
  const f = fixture(t, undefined, async () => {
    calls++;
    return { intent: "new", plan };
  });
  const now = new Date(2026, 10, 20, 18);
  f.inbox.receive(message("om_fast_task", "增加组件"));
  await f.inbox.tick(now);
  const id = f.inbox.proposals()[0].task;
  for (const [index, text] of [
    "帮助",
    "状态",
    "明天9点提醒我核对排期",
    "改到10点",
    `确认 ${id}`,
    "归档任务",
    "取消",
  ].entries()) {
    f.inbox.receive(message(`om_fast_${index}`, text));
    await f.inbox.tick(now);
  }
  assert.equal(calls, 1);
  assert.equal(f.events.length, 1);
  assert.match(f.replies.find((r) => r.id === "om_fast_2")!.text, /已安排/);
  assert.match(f.replies.find((r) => r.id === "om_fast_3")!.text, /已改到/);
});

test("private conversation retains delivered task, reminder and status replies across restart and stays scoped", async (t) => {
  const seen: Parameters<NonNullable<Ports["interpret"]>>[0][] = [];
  const f = fixture(t, undefined, async (input) => {
    seen.push(input);
    return input.message === "增加组件" ? { intent: "new", plan } : { intent: "chat", reply: "我在听。" };
  });
  const now = new Date(2026, 10, 20, 18);
  for (const [index, text] of ["增加组件", "明天9点提醒我核对排期", "状态"].entries()) {
    f.inbox.receive(message(`om_context_${index}`, text));
    await f.inbox.tick(now);
  }
  f.restart();
  f.inbox.receive(message("om_context_next", "继续说刚才的事"));
  await f.inbox.tick(now);
  assert.deepEqual(
    seen.at(-1)!.conversation.map((turn) => turn.message),
    ["增加组件", "明天9点提醒我核对排期", "状态"],
  );
  assert.ok(seen.at(-1)!.conversation.every((turn) => turn.reply && turn.reply !== "null"));
  f.inbox.receive(message("om_context_other", "继续", { chat_id: "oc_other" }));
  await f.inbox.tick(now);
  assert.deepEqual(seen.at(-1)!.conversation, []);
});

test("natural confirmation and cancellation point to a current owned card without executing a model decision", async (t) => {
  const f = fixture(t, undefined, async (input) => {
    if (input.message === "增加组件") return { intent: "new", plan };
    return { intent: input.message === "就按这个开工吧" ? "confirm" : "cancel" };
  });
  f.inbox.receive(message("om_natural_task", "增加组件"));
  await f.inbox.tick();
  const card = f.inbox.proposals()[0];
  for (const [index, text] of ["就按这个开工吧", "刚才那项先不要了"].entries()) {
    f.inbox.receive(message(`om_natural_${index}`, text));
    await f.inbox.tick();
    assert.match(f.replies.at(-1)!.text, new RegExp(card.task));
    assert.match(f.replies.at(-1)!.text, /确认卡/);
  }
  assert.equal(f.inbox.proposals().length, 1);
  assert.equal(f.inbox.proposals()[0].status, "draft");
  assert.equal(f.events.length, 0);
});

test("natural confirmation of an incomplete task repeats its missing question instead of inventing a button", async (t) => {
  const f = fixture(t, undefined, async (input) =>
    input.message === "增加组件"
      ? { intent: "new", plan: { ...plan, questions: ["需要支持移动端吗？"] } }
      : { intent: "confirm" },
  );
  f.inbox.receive(message("om_clarify_task", "增加组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_clarify_yes", "开始吧"));
  await f.inbox.tick();
  assert.match(f.replies.at(-1)!.text, /需要支持移动端吗/);
  assert.doesNotMatch(f.replies.at(-1)!.text, /确认卡/);
  assert.equal(f.events.length, 0);
});

test("clearing tasks previews a reversible archive and sends a retryable receipt only after the owner confirms", async (t) => {
  const f = fixture(t, undefined, async (input) => {
    if (input.message === "除了待办的提醒项，把其他任务删掉") return { intent: "chat", reply: "清理完成后回你确认。" };
    if (input.message === "撤销归档") return { intent: "restore_archive" };
    if (input.message.includes("核对周报"))
      return { intent: "reminder", date: "2026-11-23", time: null, text: "核对周报" };
    return { intent: "new", plan: { ...plan, summary: input.message } };
  });
  const scope = { senderId: "ou_owner", chatId: "oc_private" };
  const now = new Date(2026, 10, 20, 20);
  f.ports.outcome = async () => ({ runs: [{ run: 41, state: "done", summary: "已完成" }] });
  f.inbox.receive(message("om_archivable", "已经结束的任务"));
  await f.inbox.tick(now);
  f.inbox.receive(message("om_archivable_confirm", "确认 " + f.inbox.proposals()[0].task));
  await f.inbox.tick(now);
  f.inbox.receive(message("om_keep_reminder", "周一待办，记得提醒我\n核对周报"));
  f.inbox.receive(message("om_keep_task", "等待确认的任务"));
  f.inbox.receive(message("om_archive_request", "除了待办的提醒项，把其他任务删掉"));
  await f.inbox.tick(now);
  const card = f.inbox.proposals().find((item) => item.archive)!;
  assert.match(card.text, /已经结束的任务/);
  assert.match(card.text, /1 条提醒/);
  assert.match(card.text, /1 条未结束/);
  f.inbox.receive(message("om_bare_archive_confirm", "确认"));
  await f.inbox.tick(now);
  assert.match(f.replies.at(-1)!.text, /归档卡片/);
  assert.equal(f.events.length, 1);
  const action = {
    operator_id: "ou_owner",
    message_id: card.ref,
    action_value: { kind: "autoloop-archive", task: card.task, revision: card.revision, action: "confirm" },
  };
  f.inbox.action({ ...action, operator_id: "ou_other" });
  await f.inbox.tick(now);
  assert.equal(readWorkItems(f.file, scope).items.length, 3);
  const send = f.ports.reply;
  let failedOnce = false;
  f.ports.reply = async (id, text, key) => {
    if (id === "om_archive_request" && text.includes("清理完成") && !failedOnce) {
      failedOnce = true;
      throw new Error("断网");
    }
    return send(id, text, key);
  };
  f.inbox.action(action);
  await assert.rejects(f.inbox.tick(now), /断网/);
  assert.equal(readWorkItems(f.file, scope).items.length, 2);
  f.restart();
  f.inbox.action(action);
  await f.inbox.tick(now);
  const results = f.replies.filter((reply) => reply.id === "om_archive_request" && reply.text.includes("清理完成"));
  assert.equal(results.length, 1);
  assert.match(results[0].text, /已归档 1 条.*保留 1 条提醒/s);
  f.inbox.receive(message("om_restore", "撤销归档"));
  await f.inbox.tick(now);
  assert.equal(readWorkItems(f.file, scope).items.length, 3);
  assert.equal(f.events.length, 1);
});

test("a chat reply cannot promise later work without an execution record", async (t) => {
  const f = fixture(t, undefined, async () => ({ intent: "chat", reply: "好，清理完成后回你确认。" }));
  f.inbox.receive(message("om_untracked", "处理完了记得回我一下"));
  await f.inbox.tick();
  assert.match(f.replies[0].text, /没有.*执行记录/);
  assert.deepEqual(f.events, []);
});

test("a natural status question reports the selected project's actual round and exposes no other sender's items", async (t) => {
  const f = fixture(t, undefined, async (input) => {
    if (input.message === "这个活卡在哪了") {
      assert.deepEqual(
        input.items?.map(({ title }) => title),
        [plan.summary],
      );
      return { intent: "status", target: input.items![0].id };
    }
    return { intent: "new", plan: input.message === "另外的需求" ? { ...plan, summary: "其他人的事项" } : plan };
  });
  f.ports.outcome = async () => ({ runs: [{ run: 72, state: "claimed" }] });
  f.inbox.receive(message("om_develop", "加组件"));
  await f.inbox.tick();
  const card = f.inbox.proposals()[0];
  f.inbox.receive(message("om_go", `确认 ${card.task}`));
  await f.inbox.tick();
  f.inbox.receive(message("om_other_item", "另外的需求", { chat_id: "oc_other" }));
  await f.inbox.tick();
  f.restart();
  f.inbox.receive(message("om_progress", "这个活卡在哪了"));
  await f.inbox.tick();
  const reply = f.replies.find((item) => item.id === "om_progress")!.text;
  assert.match(reply, /执行中.*#72/s);
  assert.doesNotMatch(reply, /其他人的事项/);
  const view = readWorkItems(f.file, { senderId: "ou_owner", chatId: "oc_private" });
  assert.deepEqual(
    view.items.map((item) => [item.id, item.state, item.run]),
    [[card.task, "执行中", 72]],
  );
  assert.deepEqual(readWorkItems(f.file, { senderId: "ou_other" }).items, []);
  assert.equal(view.intake?.intent, "status");
  assert.equal(f.events.length, 1);
});

test("changing a named reminder uses its durable identifier and the read-only view records the change", async (t) => {
  const f = fixture(t, undefined, async (input) => {
    if (input.message === "把周报那条移到十点") {
      const target = input.items?.find((item) => item.kind === "reminder" && item.title === "核对周报");
      assert.ok(target);
      return { intent: "reschedule", target: target.id, date: null, time: "10:00" };
    }
    return { intent: "reminder", date: "2026-11-23", time: "09:00", text: input.message };
  });
  const now = new Date(2026, 10, 20, 18);
  f.inbox.receive(message("om_review_report", "核对周报"));
  f.inbox.receive(message("om_schedule_meeting", "安排会议"));
  await f.inbox.tick(now);
  const scope = { senderId: "ou_owner", chatId: "oc_private" };
  const initial = readWorkItems(f.file, scope).items.find((item) => item.title === "核对周报")!;
  f.restart();
  f.inbox.receive(message("om_move_only_report", "把周报那条移到十点"));
  await f.inbox.tick(now);
  const items = readWorkItems(f.file, scope).items;
  const report = items.find((item) => item.id === initial.id)!;
  assert.equal(report.scheduledAt, new Date(2026, 10, 23, 10).toISOString());
  assert.match(report.activity?.[0]?.label ?? "", /改期.*10:00/);
  assert.equal(items.find((item) => item.title === "安排会议")?.scheduledAt, new Date(2026, 10, 23, 9).toISOString());
  assert.equal(items.length, 2);
  assert.deepEqual(f.events, []);
});

test("a text reply reads its quoted image across restart and ignores a quote from another conversation", async (t) => {
  const f = fixture(t, undefined, async (input, _message, _selected, image) => {
    if (input.messageType === "image") return { intent: "chat", reply: "读到图片了。" };
    if (input.message === "这张图写了什么") {
      assert.equal(image?.message_id, "om_receipt");
      return { intent: "chat", reply: "图片上的合计是 20 元。" };
    }
    assert.equal(image, undefined);
    return { intent: "chat", reply: "当前会话里没有这张图片。" };
  });
  f.inbox.receive(message("om_receipt", "[Image: img_example]", { message_type: "image" }));
  await f.inbox.tick();
  f.restart();
  f.inbox.receive(message("om_quote", "这张图写了什么", { reply_to: "om_receipt", root_id: "om_receipt" }));
  f.inbox.receive(message("om_wrong_chat", "跨会话的引用", { chat_id: "oc_other", reply_to: "om_receipt" }));
  await f.inbox.tick();
  assert.match(f.replies[1].text, /20 元/);
  assert.match(f.replies[2].text, /当前会话里没有/);
  assert.deepEqual(f.events, []);
});

test("model-first intake keeps conversation context and only a real card click starts development", async (t) => {
  const seen: Parameters<NonNullable<Ports["interpret"]>>[0][] = [];
  const f = fixture(t, undefined, async (input) => {
    seen.push(input);
    if (input.message === "想加个组件") return { intent: "new", plan };
    if (input.message === "明天记得叫我确认排期")
      return { intent: "reminder", date: "2026-11-21", time: "09:30", text: "确认排期" };
    if (input.messageType === "image") return { intent: "chat", reply: "截图里有一个黄色按钮。" };
    return { intent: "chat", reply: "我在听。" };
  });
  assert.equal(f.inbox.receive(message("om_forbidden", "想加个组件", { sender_id: "ou_other" })), false);
  for (const [id, text, type] of [
    ["om_chat_route", "今天好累", "text"],
    ["om_draft_route", "想加个组件", "text"],
    ["om_chat_again", "你呢", "text"],
    ["om_remind_route", "明天记得叫我确认排期", "text"],
    ["om_image_route", '{"image_key":"img_test"}', "image"],
  ]) {
    assert.ok(f.inbox.receive(message(id, text, { message_type: type })));
    await f.inbox.tick(new Date(2026, 10, 20, 18));
  }
  assert.equal(seen.length, 5);
  assert.deepEqual(seen[2].conversation[0], { message: "今天好累", reply: "我在听。" });
  assert.equal(f.inbox.proposals().length, 1);
  assert.deepEqual(f.events, []);
  assert.match(f.replies.find((r) => r.id === "om_remind_route")!.text, /09:30/);
  assert.match(f.replies.find((r) => r.id === "om_image_route")!.text, /黄色按钮/);
  const card = f.inbox.proposals()[0];
  f.inbox.action({
    operator_id: "ou_owner",
    message_id: card.ref,
    action_value: { kind: "autoloop-task", action: "confirm", task: card.task, revision: card.revision },
  });
  await f.inbox.tick(new Date(2026, 10, 20, 18));
  assert.equal(f.events.length, 1);
  assert.equal(seen.length, 5);
});

test("a Monday checklist is reminded once after a restart without parsing or dispatching development", async (t) => {
  const f = fixture(t);
  const checklist = "1. 替换测试接口\n2. 下线旧测试接口\n3. 删除测试服务文件";
  const original = message("om_reminder", `<p>周一待办，记得提醒我</p><p>${checklist.replaceAll("\n", "</p><p>")}</p>`);
  assert.ok(f.inbox.receive(original));
  await f.inbox.tick(new Date(2026, 10, 20, 18));
  assert.match(f.replies[0].text, /11月23日.*09:00/);
  assert.ok(f.replies[0].text.includes(checklist));
  f.restart();
  assert.equal(f.inbox.receive(original), false);
  await f.inbox.tick(new Date(2026, 10, 23, 8, 59));
  assert.equal(f.replies.length, 1);
  await f.inbox.tick(new Date(2026, 10, 23, 9));
  await f.inbox.tick(new Date(2026, 10, 23, 10));
  assert.equal(f.replies.length, 2);
  assert.equal(f.replies[1].id, "om_reminder");
  assert.ok(f.replies[1].text.includes(checklist));
  assert.equal(f.parsed(), 0);
  assert.deepEqual(f.events, []);
});

test("a reply to a reminder selects that reminder and moves its time without a second delivery", async (t) => {
  const f = fixture(t, undefined, async (input) => {
    if (input.message === "改为 10 点吧") {
      assert.equal(input.reminder?.text, "核对周报");
      return { intent: "reschedule", date: null, time: "10:00" };
    }
    return { intent: "reminder", date: "2026-11-23", time: "09:00", text: input.message };
  });
  const now = new Date(2026, 10, 20, 18);
  f.inbox.receive(message("om_weekly", "核对周报"));
  f.inbox.receive(message("om_other_reminder", "安排会议"));
  await f.inbox.tick(now);
  f.restart();
  f.inbox.receive(message("om_ambiguous_move", "改到 11 点吧"));
  f.inbox.receive(message("om_move", "改为 10 点吧", { reply_to: "om_reply_1" }));
  await f.inbox.tick(now);
  assert.match(f.replies[2].text, /多条.*回复/);
  assert.match(f.replies[3].text, /已改到.*10:00/);
  await f.inbox.tick(new Date(2026, 10, 23, 9));
  assert.deepEqual(
    f.replies.slice(4).map(({ id }) => id),
    ["om_other_reminder"],
  );
  await f.inbox.tick(new Date(2026, 10, 23, 10));
  await f.inbox.tick(new Date(2026, 10, 23, 11));
  assert.deepEqual(
    f.replies.slice(4).map(({ id }) => id),
    ["om_other_reminder", "om_weekly"],
  );
  assert.deepEqual(f.events, []);
});

test("only authorized human messages and actual bot mentions enter the durable inbox", async (t) => {
  const f = fixture(t);
  for (const m of [
    message("om_stranger", "做组件", { sender_id: "ou_stranger" }),
    message("om_bot", "做组件", { sender_type: "bot" }),
    message("om_group", "@机器人 做组件", { chat_type: "group", chat_id: "oc_group" }),
    message("om_other", "@_user_1 做组件", {
      chat_type: "group",
      chat_id: "oc_group",
      mentions: [{ id: "ou_other", key: "@_user_1" }],
    }),
  ])
    assert.equal(f.inbox.receive(m), false);
  assert.equal(
    f.inbox.receive(
      message("om_ok", "@_user_1 组件库新增按键提示", {
        chat_type: "group",
        chat_id: "oc_group",
        mentions: [{ id: "ou_bot", key: "@_user_1" }],
      }),
    ),
    true,
  );
  await f.inbox.tick();
  assert.equal(f.parsed(), 1);
  assert.equal(f.events.length, 0);
  assert.match(f.replies[0].text, /确认/);
});

test("a proposal starts only after its owner's confirmation, once across redelivery and restart", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "组件库新增按键提示，构建通过"));
  await f.inbox.tick();
  f.restart();
  assert.equal(f.inbox.receive(message("om_task", "组件库新增按键提示，构建通过")), false);
  assert.equal(f.inbox.receive(message("om_hijack", "确认", { sender_id: "ou_other", reply_to: "om_task" })), false);
  f.inbox.receive(message("om_confirm", "确认", { reply_to: "om_task" }));
  await f.inbox.tick();
  f.restart();
  f.inbox.receive(message("om_confirm", "确认", { reply_to: "om_task" }));
  await f.inbox.tick();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].type, "palette.feature");
  assert.equal(f.events[0].id, "feishu:om_task");
  assert.ok(!("cwd" in f.events[0]));
  assert.ok(!("agent" in f.events[0]));
  assert.equal(f.parsed(), 1);
});

test("missing project is clarified; a reply adds context but does not silently dispatch", async (t) => {
  const inputs: any[] = [];
  const f = fixture(t, async (input) => {
    inputs.push(input);
    return inputs.length === 1 ? { ...plan, project: null, questions: ["请指定项目"] } : plan;
  });
  f.inbox.receive(message("om_unknown", "加一个组件"));
  await f.inbox.tick();
  assert.match(f.replies[0].text, /指定项目/);
  f.inbox.receive(message("om_more", "命令面板组件库，新增按键提示", { reply_to: "om_reply_1" }));
  await f.inbox.tick();
  assert.match(JSON.stringify(inputs[1]), /加一个组件/);
  assert.match(f.replies[1].text, /确认/);
  assert.equal(f.events.length, 0);
});

test("a model cannot invent projects, event types, paths or ready-to-run commands", async (t) => {
  const f = fixture(t, async () => ({ ...plan, project: "../../other", kind: "shell" }) as any);
  f.inbox.receive(message("om_bad", "去其他目录删数据"));
  await f.inbox.tick();
  f.inbox.receive(message("om_yes", "确认"));
  await f.inbox.tick();
  assert.equal(f.events.length, 0);
  assert.match(f.replies[0].text, /项目|类型/);
});

test("group confirmations stay in the same thread and groups can be restricted", async (t) => {
  const f = fixture(t);
  const group = { chat_type: "group" as const, chat_id: "oc_group", mentions: [{ id: "ou_bot", key: "@bot" }] };
  f.inbox.receive(message("om_g1", "@bot 新增组件", group));
  await f.inbox.tick();
  f.inbox.receive(message("om_g2", "@bot 确认", group));
  await f.inbox.tick();
  assert.equal(f.events.length, 0, "an unthreaded group reply cannot confirm a pending task");
  f.inbox.receive(message("om_g3", "@bot 确认", { ...group, reply_to: "om_reply_1" }));
  await f.inbox.tick();
  assert.equal(f.events.length, 1);
});

test("a lost dispatch response retries the same idempotent event without reparsing", async (t) => {
  const f = fixture(t);
  let attempts = 0;
  f.ports.dispatch = async (event) => {
    f.events.push(event);
    if (++attempts === 1) throw new Error("response lost");
    return { event: 41, routed: ["palette"] };
  };
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_yes", "确认"));
  await assert.rejects(f.inbox.tick(), /response lost/);
  f.restart();
  await f.inbox.tick();
  assert.equal(f.parsed(), 1);
  assert.equal(f.events.length, 2);
  assert.deepEqual(f.events[0], f.events[1]);
});

test("results are replied to the originating message and survive a failed send", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_yes", "确认"));
  await f.inbox.tick();
  f.ports.outcome = async () => ({ runs: [{ id: 1, state: "done", summary: "已新增组件，构建通过" }] });
  let fail = true;
  f.ports.reply = async (id, text, key) => {
    f.replies.push({ id, text, key });
    if (fail) throw new Error("offline");
    return "om_result";
  };
  await assert.rejects(f.inbox.tick(), /offline/);
  f.restart();
  fail = false;
  await f.inbox.tick();
  const last = f.replies.slice(-2);
  assert.equal(last[0].id, "om_task");
  assert.equal(last[0].key, last[1].key);
  assert.match(last[1].text, /构建通过/);
});

test("an unavailable parser replies once instead of spending tokens in an automatic retry loop", async (t) => {
  const f = fixture(t, async () => {
    throw new Error("credentials missing");
  });
  f.inbox.receive(message("om_down", "组件库新增组件"));
  await f.inbox.tick();
  await f.inbox.tick();
  assert.equal(f.parsed(), 1);
  assert.match(f.replies[0].text, /尚未派发/);
  assert.equal(f.events.length, 0);
});

test("optional group allowlist rejects other groups even when they mention the bot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-feishu-groups-"));
  const store = new TaskStore(join(dir, "tasks.db"));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const inbox = createInbox({ ...config, groups: ["oc_allowed"] }, store, {} as any);
  assert.equal(
    inbox.receive(
      message("om_denied", "@bot 新增组件", {
        chat_type: "group",
        chat_id: "oc_other",
        mentions: [{ id: "ou_bot", key: "@bot" }],
      }),
    ),
    false,
  );
});

test("removing a project invalidates its persisted proposal without blocking later messages", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  const saved = config.projects;
  config.projects = [
    { ...saved[0], id: "replacement", events: { feature: "other.feature", change: "other.change", bug: "other.bug" } },
  ];
  try {
    f.restart();
    f.inbox.receive(message("om_yes", "确认"));
    await f.inbox.tick();
    assert.equal(f.events.length, 0);
    assert.match(f.replies.at(-1)!.text, /配置|项目/);
  } finally {
    config.projects = saved;
  }
});

test("revoked senders cannot dispatch an already persisted confirmation after restart", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_yes", "确认"));
  const senders = config.senders;
  config.senders = ["ou_other"];
  try {
    f.restart();
    await f.inbox.tick();
    assert.equal(f.events.length, 0);
    assert.equal(f.replies.length, 1, "no reply to a revoked sender");
  } finally {
    config.senders = senders;
  }
});

test("revocation also blocks a prepared dispatch whose first network attempt failed", async (t) => {
  const f = fixture(t);
  f.ports.dispatch = async () => {
    throw new Error("offline");
  };
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_yes", "确认"));
  await assert.rejects(f.inbox.tick(), /offline/);
  f.ports.dispatch = async (event) => {
    f.events.push(event);
    return { event: 1, routed: ["palette"] };
  };
  const senders = config.senders;
  config.senders = ["ou_other"];
  try {
    f.restart();
    await f.inbox.tick();
    assert.equal(f.events.length, 0);
  } finally {
    config.senders = senders;
  }
});

test("one unavailable chat does not block other users' messages or results", async (t) => {
  const f = fixture(t);
  f.ports.reply = async (id, text, key) => {
    if (id === "om_bad") throw new Error("chat unavailable");
    f.replies.push({ id, text, key });
    return "om_good_reply";
  };
  f.inbox.receive(message("om_bad", "组件库新增组件", { chat_id: "oc_bad" }));
  f.inbox.receive(message("om_good", "帮助", { chat_id: "oc_good" }));
  await assert.rejects(f.inbox.tick(), /chat unavailable/);
  assert.ok(f.replies.some((r) => r.id === "om_good"));
});

test("a failed confirmation preserves ordering within its chat while other chats continue", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  f.ports.dispatch = async () => {
    throw new Error("offline");
  };
  f.inbox.receive(message("om_yes", "确认"));
  f.inbox.receive(message("om_change", "把需求改成别的组件"));
  f.inbox.receive(message("om_help", "帮助", { chat_id: "oc_other" }));
  await assert.rejects(f.inbox.tick(), /offline/);
  assert.equal(f.parsed(), 1, "do not rewrite a task while its confirmation is being retried");
  assert.ok(f.replies.some((r) => r.id === "om_help"));
});

test("official CLI rendered bot mentions still allow group confirmation", async (t) => {
  for (const rendered of ["@AI 开发 CLI", '<at user_id="ou_bot">AI 开发 CLI</at>']) {
    const f = fixture(t);
    const group = {
      chat_type: "group" as const,
      chat_id: "oc_group",
      mentions: [{ id: "ou_bot", key: "@_user_1", name: "AI 开发 CLI" }],
    };
    f.inbox.receive(message("om_task", rendered + " 新增按键提示", group));
    await f.inbox.tick();
    f.inbox.receive(message("om_yes", rendered + " 确认", { ...group, reply_to: "om_reply_1" }));
    await f.inbox.tick();
    assert.equal(f.parsed(), 1);
    assert.equal(f.events.length, 1);
  }
});

test("confirmation buttons bind the sender, exact card and current proposal revision", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "新增按键提示"));
  await f.inbox.tick();
  const card = f.inbox.proposals()[0];
  assert.ok(card?.ref);
  const clicked = (over: object = {}) => ({
    operator_id: "ou_owner",
    message_id: card.ref,
    action_value: JSON.stringify({
      kind: "autoloop-task",
      task: card.task,
      revision: card.revision,
      action: "confirm",
    }),
    ...over,
  });
  assert.equal(f.inbox.action(clicked({ operator_id: "ou_other" })), true);
  assert.equal(f.inbox.action(clicked({ message_id: "om_forged" })), true);
  await f.inbox.tick();
  assert.equal(f.events.length, 0);
  assert.equal(f.inbox.action(clicked()), true);
  f.inbox.action(clicked());
  f.restart();
  await f.inbox.tick();
  assert.equal(f.events.length, 1);
  assert.equal(f.inbox.proposals()[0].status, "queued");
});

test("cancel button ends a draft without dispatching and old buttons cannot start it", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  const card = f.inbox.proposals()[0];
  const click = (action: string) => ({
    operator_id: "ou_owner",
    message_id: card.ref,
    action_value: JSON.stringify({ kind: "autoloop-task", task: card.task, revision: card.revision, action }),
  });
  f.inbox.action(click("cancel"));
  await f.inbox.tick();
  assert.equal(f.inbox.proposals()[0].status, "cancelled");
  f.inbox.action(click("confirm"));
  await f.inbox.tick();
  assert.equal(f.events.length, 0);
});

test("an old card becomes invalid as soon as the proposal is revised", async (t) => {
  let n = 0;
  const f = fixture(t, async () => ({ ...plan, detail: ++n === 1 ? "第一版组件" : "第二版组件" }));
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  const old = f.inbox.proposals()[0];
  f.inbox.receive(message("om_change", "修改组件接口"));
  await f.inbox.tick();
  f.inbox.action({
    operator_id: "ou_owner",
    message_id: old.ref,
    action_value: JSON.stringify({ kind: "autoloop-task", task: old.task, revision: old.revision, action: "confirm" }),
  });
  await f.inbox.tick();
  assert.equal(f.events.length, 0);
  assert.equal(f.inbox.proposals().find((c) => c.revision === old.revision)!.status, "superseded");
});

test("a click saved before an edit is rechecked before dispatch", async (t) => {
  let n = 0;
  const f = fixture(t, async () => ({ ...plan, detail: ++n === 1 ? "第一版" : "第二版" }));
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  const old = f.inbox.proposals()[0];
  f.inbox.receive(message("om_change", "修改接口"));
  f.inbox.action({
    operator_id: "ou_owner",
    message_id: old.ref,
    action_value: JSON.stringify({ kind: "autoloop-task", task: old.task, revision: old.revision, action: "confirm" }),
  });
  await f.inbox.tick();
  assert.equal(f.events.length, 0);
});

test("existing text-only drafts gain a button card without another model call or dispatch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "autoloop-old-draft-")),
    file = join(dir, "tasks.db");
  const store = new TaskStore(file);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.save({
    id: "abcdef012345",
    origin: message("om_old", "新增组件"),
    refs: ["om_old", "om_old_text"],
    history: ["新增组件"],
    state: "draft",
    plan,
  });
  let sent = 0,
    parsed = 0,
    dispatched = 0;
  const inbox = createInbox(config, store, {
    parse: async () => {
      parsed++;
      return plan;
    },
    reply: async (_id, _text, _key, view) => {
      sent++;
      assert.equal(view?.status, "draft");
      return "om_card";
    },
    dispatch: async () => {
      dispatched++;
      return { event: 1, routed: ["palette"] };
    },
    outcome: async () => ({ runs: [] }),
  });
  await inbox.tick();
  await inbox.tick();
  assert.equal(sent, 1);
  assert.equal(parsed, 0);
  assert.equal(dispatched, 0);
  assert.equal(inbox.proposals()[0].ref, "om_card");
});

test("returning to the same plan after an edit creates a fresh usable confirmation", async (t) => {
  let n = 0;
  const f = fixture(t, async () => ({ ...plan, detail: ++n === 2 ? "版本B" : "版本A" }));
  f.inbox.receive(message("om_task", "版本A"));
  await f.inbox.tick();
  const old = f.inbox.proposals()[0];
  const click = (card: any) => ({
    operator_id: "ou_owner",
    message_id: card.ref,
    action_value: JSON.stringify({
      kind: "autoloop-task",
      task: card.task,
      revision: card.revision,
      action: "confirm",
    }),
  });
  f.inbox.receive(message("om_edit_b", "改为版本B"));
  f.inbox.action(click(old));
  await f.inbox.tick();
  f.inbox.receive(message("om_edit_a", "改回版本A"));
  await f.inbox.tick();
  const current = f.inbox.proposals().find((c) => c.status === "draft")!;
  f.inbox.action(click(current));
  await f.inbox.tick();
  assert.equal(f.events.length, 1);
  assert.notEqual(current.revision, old.revision);
});

test("a historical task updates its confirmed card and status from the same delivery without redispatch", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_old", "新增组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_yes", "确认"));
  f.ports.outcome = async () => ({ runs: [{ state: "done", summary: "论证结束" }] });
  await f.inbox.tick();
  const saved = f.openStore();
  const old = saved.tasks()[0];
  old.delivery = { title: "已合并", text: "旧版合并回执", verified: "old-proof", stage: "complete" };
  saved.save(old);
  const changes: any[] = [];
  const result = { title: "已合并", text: "MR !1；CI 通过；CR 通过" };
  Object.assign(f.ports, {
    delivery: async () => result,
    updateProposal: async (ref: string, card: unknown) => changes.push({ ref, card }),
  });
  f.restart();
  const first = f.inbox.proposals()[0];
  f.inbox.receive(message("om_query", "状态 " + first.task));
  await f.inbox.tick();
  assert.match(f.replies.at(-1)!.text, /已合并[\s\S]*MR !1；CI 通过；CR 通过/);
  assert.deepEqual(
    changes.map((change) => [change.ref, change.card.delivery]),
    [[first.ref, result]],
  );
  result.text += "，运行 #2";
  await f.inbox.tick();
  await f.inbox.tick();
  assert.equal(changes.length, 2);
  assert.equal(f.events.length, 1);
});

test("an unknown explicit status ID never displays another task", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_real", "新增组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_unknown", "状态 ffffffffffff"));
  await f.inbox.tick();
  assert.match(f.replies.at(-1)!.text, /没有找到/);
});

test("confirmed verification uses its own registered event without requesting a development category", async (t) => {
  const f = fixture(t, async () => ({ ...plan, kind: "verify", detail: "只运行已配置检查，无需改文件或提 MR" }));
  f.inbox.receive(
    message(
      "om_verify",
      "只验收当前 main 的 SDK 平台数据库迁移，保留现有代码，由接单程序运行已配置检查，无需改文件或提 MR",
    ),
  );
  await f.inbox.tick();
  assert.equal(f.inbox.proposals()[0]?.status, "draft");
  f.inbox.receive(message("om_yes", "确认"));
  await f.inbox.tick();
  assert.deepEqual(
    f.events.map((e) => e.type),
    ["palette.verify"],
  );
});

for (const phrase of ["取消该任务", "取消 ID 任务"]) {
  test(phrase + " cancels the draft without parsing the command", async (t) => {
    const f = fixture(t);
    f.inbox.receive(message("om_task", "新增组件"));
    await f.inbox.tick();
    f.inbox.receive(message("om_cancel", phrase.replace("ID", f.inbox.proposals()[0].task)));
    await f.inbox.tick();
    assert.equal(f.inbox.proposals()[0].status, "cancelled");
    assert.equal(f.parsed(), 1);
    assert.equal(f.events.length, 0);
  });
}

test("a social turn gets a personal response without becoming part of a pending task", async (t) => {
  const inputs: any[] = [];
  const f = fixture(t, async (input) => {
    inputs.push(input);
    return inputs.length === 2 ? { intent: "chat", reply: "今天辛苦了，早点休息，晚安。" } : plan;
  });
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  const card = f.inbox.proposals()[0];
  f.inbox.receive(message("om_chat", "困了 我下班了"));
  await f.inbox.tick();
  assert.match(f.replies.at(-1)!.text, /晚安/);
  assert.deepEqual(f.inbox.proposals(), [card]);
  f.inbox.receive(message("om_next", "组件支持键盘操作"));
  await f.inbox.tick();
  assert.ok(!JSON.stringify(inputs.at(-1)).includes("困了"));
});

test("confirm answers a clarification before a new proposal can authorize execution", async (t) => {
  const f = fixture(t, async (input: any) =>
    input.messages.length === 1 ? { ...plan, questions: ["要保留旧配置吗？"] } : plan,
  );
  f.inbox.receive(message("om_request", "修改已有组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_answer", "确认"));
  await f.inbox.tick();
  assert.equal(f.inbox.proposals()[0]?.status, "draft");
  assert.equal(f.events.length, 0);
});

test("a relative private cancellation after a social reply finds only the sole open task", async (t) => {
  const f = fixture(t);
  f.inbox.receive(message("om_task", "新增组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_stop", "取消该任务", { reply_to: "om_social_reply" }));
  await f.inbox.tick();
  assert.equal(f.inbox.proposals()[0].status, "cancelled");
});

test("a separate deliverable in the same private chat gets its own confirmation and event origin", async (t) => {
  const f = fixture(t, async (input: any) =>
    input.previous ? { intent: "new", plan } : { ...plan, questions: ["审查哪个分支？"] },
  );
  f.inbox.receive(message("om_review", "审查组件库代码"));
  await f.inbox.tick();
  f.inbox.receive(message("om_activity", "使用组件库脚手架创建一个活动模板，英文名你来起"));
  await f.inbox.tick();
  assert.equal(f.inbox.proposals().length, 1);
  f.inbox.receive(message("om_yes", "确认", { reply_to: "om_activity" }));
  await f.inbox.tick();
  assert.equal(f.events[0]?.id, "feishu:om_activity");
  f.inbox.receive(message("om_check", "状态", { reply_to: "om_review" }));
  await f.inbox.tick();
  assert.match(f.replies.at(-1)!.text, /等待补充/);
});

test("a reply to an earlier card selects that task when a new task shares its Feishu thread", async (t) => {
  const f = fixture(t, async (input: any) => (input.previous ? { intent: "new", plan } : plan));
  const thread = { thread_id: "omt_shared" };
  f.inbox.receive(message("om_first", "生成夏季组件", thread));
  await f.inbox.tick();
  const first = f.inbox.proposals()[0];
  f.inbox.receive(message("om_second", "另外创建秋季组件", thread));
  await f.inbox.tick();
  f.inbox.receive(message("om_cancel_first", "取消该任务", { ...thread, reply_to: first.ref }));
  await f.inbox.tick();
  assert.equal(f.inbox.proposals().find((c) => c.task === first.task)?.status, "cancelled");
  assert.equal(f.inbox.proposals().find((c) => c.task !== first.task)?.status, "draft");
});

test("plain private answers follow the last discussed task across restart with other drafts open", async (t) => {
  const inputs: any[] = [];
  const missing = { ...plan, project: null, questions: ["哪个项目？"] };
  const f = fixture(t, async (input: any) => {
    inputs.push(input);
    if (input.messages.at(-1) === "另做代码审查") return { intent: "new", plan };
    if (input.messages.includes("palette")) return plan;
    return missing;
  });
  const send = async (id: string, text: string, extra?: Partial<Message>) => {
    f.inbox.receive(message(id, text, extra));
    await f.inbox.tick();
  };
  await send("om_activity", "用脚手架创建活动");
  const originalId = f.replies[0].text.match(/[a-f0-9]{12}/)![0];
  await send("om_review", "另做代码审查");
  await send("om_more", "能正常启动即可", { reply_to: "om_activity" });
  f.restart();
  await send("om_project", "palette");
  assert.deepEqual(inputs.at(-1).messages, ["用脚手架创建活动", "能正常启动即可", "palette"]);
  assert.equal(inputs.at(-1).projectAnswer, "palette");
  const before = f.inbox.proposals();
  assert.equal(before.find((card) => card.task === originalId)?.status, "draft");
  await send("om_repeat", "组件库");
  assert.deepEqual(f.inbox.proposals(), before);
  assert.match(f.replies.at(-1)!.text, new RegExp(originalId));
  await send("om_confirm", "确认");
  assert.equal(f.events.length, 0);
});

test("slow chat does not block another chat and one chat keeps message order", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  const f = fixture(t, undefined, async (input) => {
    seen.push(input.message);
    if (input.message === "慢消息") await gate;
    return { intent: "chat", reply: "收到" };
  });
  f.inbox.receive(message("om_slow", "慢消息"));
  f.inbox.receive(message("om_ordered", "后一条"));
  f.inbox.receive(message("om_fast", "快消息", { chat_id: "oc_other" }));
  const running = f.inbox.tick();
  await new Promise((resolve) => setTimeout(resolve, 30));
  try {
    assert.ok(f.replies.some((row) => row.id === "om_fast"));
    assert.ok(!seen.includes("后一条"));
  } finally {
    release();
    await running;
  }
  assert.deepEqual(
    seen.filter((value) => value !== "快消息"),
    ["慢消息", "后一条"],
  );
});

test("reminder timezone is independent of the host and rejects invalid twelve-hour changes", async () => {
  const { reminderFor, reminderTimeChange, scheduleReminder } = await import("../plugins/feishu-tasks/reminder.ts");
  const date = new Date("2026-11-23T16:30:00Z");
  const reminder = reminderFor("今天上午9点提醒我开会", date, "Asia/Shanghai");
  assert.ok(reminder && "at" in reminder);
  assert.equal(new Date(reminder.at).toISOString(), "2026-11-24T01:00:00.000Z");
  const change = reminderTimeChange("改到下午13点")!;
  assert.ok("error" in scheduleReminder("2026-11-25", change.time, "开会", date, "Asia/Shanghai"));
});

test("invalid calendar dates return a reminder correction instead of throwing during timezone conversion", async () => {
  const { scheduleReminder } = await import("../plugins/feishu-tasks/reminder.ts");
  for (const date of ["2026-13-01", "2026-00-10", "2027-02-30"])
    assert.ok("error" in scheduleReminder(date, "09:00", "开会", new Date("2026-11-23T00:00:00Z"), "Asia/Shanghai"));
});

test("stale task-card saves preserve concurrently updated progress and verification", () => {
  const store = new TaskStore(":memory:");
  try {
    store.save({
      id: "concurrent",
      state: "queued",
      refs: [],
      history: [],
      origin: message("om_concurrent", "验收"),
      lastRun: { state: "claimed", run: 1 },
      delivery: { title: "验收中", text: "等待" },
    } as any);
    const stale = store.tasks()[0],
      fresh = store.tasks()[0];
    fresh.lastRun = { state: "done", run: 1 };
    fresh.delivery = { title: "验收通过", text: "检查通过" };
    store.save(fresh);
    stale.refs.push("om_card");
    store.save(stale);
    assert.equal(store.tasks()[0].lastRun?.state, "done");
    assert.equal(store.tasks()[0].delivery?.title, "验收通过");
    assert.ok(store.tasks()[0].refs.includes("om_card"));
  } finally {
    store.close();
  }
});

test("a reminder sent during reschedule parsing never gains a false reschedule activity", async (t) => {
  const f = fixture(t);
  const now = new Date(2026, 10, 23, 8);
  f.inbox.receive(message("om_race_reminder", "今天9点提醒我开会"));
  await f.inbox.tick(now);
  const store = f.openStore();
  f.ports.interpret = async () => {
    const target = store.reminderTarget(message("om_change", "请改成10点")).target!;
    store.reminderSent(target.message.message_id, target.reminder.at, "om_sent");
    return { intent: "reschedule", date: null, time: "10:00" };
  };
  f.restart();
  f.inbox.receive(message("om_change", "请改成10点"));
  await f.inbox.tick(now);
  assert.match(f.replies.at(-1)!.text, /原提醒已发送/);
  const view = readWorkItems(f.file, { senderId: "ou_owner", privateOnly: true });
  assert.deepEqual(view.items[0].activity, []);
});

test("historical recollection is allowed but a new unsupported action promise is blocked", async () => {
  const { groundedChatReply } = await import("../plugins/feishu-tasks/archive.ts");
  const history = "你之前已经安排提醒我复习。";
  assert.equal(groundedChatReply(history), history);
  assert.match(groundedChatReply("你之前已经安排提醒。我会帮你删除旧记录。"), /没有登记/);
});

test("due reminders and terminal results continue while this chat's model waits", async (t) => {
  const f = fixture(t);
  const now = new Date(2026, 10, 20, 8);
  f.inbox.receive(message("om_due", "今天9点提醒我开会"));
  await f.inbox.tick(now);
  f.inbox.receive(message("om_task_async", "新增功能"));
  await f.inbox.tick(now);
  const id = f.inbox.proposals()[0].task;
  f.inbox.receive(message("om_confirm_async", `确认 ${id}`));
  await f.inbox.tick(now);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.ports.interpret = async () => {
    await gate;
    return { intent: "chat", reply: "收到" };
  };
  f.ports.outcome = async () => ({ runs: [{ run: 1, state: "done", summary: "已验证" }] });
  f.restart();
  f.inbox.receive(message("om_chat_async", "聊一会儿"));
  const job = f.inbox.tick(new Date(2026, 10, 20, 9, 1));
  await new Promise((r) => setTimeout(r, 30));
  try {
    assert.ok(f.replies.some((row) => row.key.startsWith("ft-reminder-")));
    assert.ok(f.replies.some((row) => row.key.startsWith("ft-result-")));
  } finally {
    release();
    await job;
  }
});

test("reaction removal retries after the durable reply without repeating the business response", async (t) => {
  const f = fixture(t);
  const store = f.openStore();
  let starts = 0,
    ends = 0;
  const inbox = createInbox(config, store, {
    ...f.ports,
    reaction: async (_message, previous) => {
      if (!previous) {
        starts++;
        return "reaction1";
      }
      ends++;
      if (ends === 1) throw Error("temporary");
      return undefined;
    },
  });
  inbox.receive(message("om_reaction", "帮助"));
  await inbox.tick();
  await inbox.tick();
  await inbox.tick();
  assert.equal(starts, 1);
  assert.equal(ends, 2);
  assert.equal(f.replies.length, 1);
  assert.equal(store.reactions().length, 0);
});

test("rescheduling during an in-flight reminder preserves the new time and its delivery key", async (t) => {
  const f = fixture(t);
  const now = new Date(2026, 10, 20, 8);
  f.inbox.receive(message("om_race_reminder", "今天9点提醒我开会"));
  await f.inbox.tick(now);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const original = f.ports.reply;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  f.ports.reply = async (id, text, key) => {
    if (key.startsWith("ft-reminder-") && !f.replies.some((row) => row.key.startsWith("ft-reminder-"))) {
      entered();
      await gate;
    }
    return original(id, text, key);
  };
  f.restart();
  f.inbox.receive(message("om_race_change", "改到10点", { reply_to: "om_race_reminder" }));
  const pending = f.inbox.tick(new Date(2026, 10, 20, 9, 1));
  await started;
  try {
    for (let i = 0; i < 50 && !f.replies.some((row) => row.id === "om_race_change"); i++)
      await new Promise((r) => setTimeout(r, 5));
    assert.match(f.replies.find((row) => row.id === "om_race_change")!.text, /已改到/);
  } finally {
    release();
    await pending;
  }
  await f.inbox.tick(new Date(2026, 10, 20, 10));
  const reminders = f.replies.filter((row) => row.key.startsWith("ft-reminder-"));
  assert.equal(reminders.length, 2);
  assert.notEqual(reminders[0].key, reminders[1].key);
});

test("bounded maintenance eventually visits every chat", async (t) => {
  const f = fixture(t),
    store = f.openStore();
  for (let i = 1; i <= 5; i++)
    store.save({
      id: "fair" + i,
      state: "queued",
      event: i,
      refs: [],
      history: [],
      origin: message("om_fair" + i, "任务", { chat_id: "oc_" + i }),
    } as any);
  const visited = new Set<number>();
  f.ports.outcome = async (id) => {
    visited.add(id);
    return { runs: [] };
  };
  f.restart();
  for (let i = 0; i < 5; i++) await f.inbox.tick();
  assert.equal(visited.size, 5);
});

test("overlapping ticks keep result polling within its four-chat bound", async (t) => {
  const f = fixture(t),
    store = f.openStore();
  for (let i = 1; i <= 5; i++)
    store.save({
      id: "limit" + i,
      state: "queued",
      event: i,
      refs: [],
      history: [],
      origin: message("om_limit" + i, "任务", { chat_id: "oc_" + i }),
    } as any);
  let active = 0,
    maximum = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  f.ports.outcome = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await gate;
    active--;
    return { runs: [] };
  };
  f.restart();
  const first = f.inbox.tick();
  await new Promise((r) => setTimeout(r, 5));
  const second = f.inbox.tick();
  try {
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(maximum, 4);
  } finally {
    release();
    await Promise.all([first, second]);
  }
});

test("maintenance saves cannot erase card references written while awaiting an outcome", () => {
  const store = new TaskStore(":memory:");
  try {
    store.save({
      id: "race",
      state: "queued",
      refs: [],
      cards: [{ revision: "v1", text: "task" }],
      history: [],
      origin: message("om_race", "task"),
    } as any);
    const maintenance = store.tasks()[0],
      card = store.tasks()[0];
    card.cards![0].ref = "om_card";
    card.refs.push("om_card");
    store.save(card);
    maintenance.lastRun = { state: "done", run: 1 };
    store.save(maintenance);
    assert.equal(store.tasks()[0].cards![0].ref, "om_card");
    assert.deepEqual(store.tasks()[0].refs, ["om_card"]);
  } finally {
    store.close();
  }
});

test("scoped task edits preserve delivery changes made after the read", () => {
  const store = new TaskStore(":memory:");
  try {
    store.save({
      id: "scoped",
      state: "finished",
      refs: [],
      history: [],
      origin: message("om_scoped", "task"),
      delivery: { title: "old", text: "old" },
    } as any);
    const stale = (store as any).scopedTasks({ senderId: "ou_owner" })[0];
    const fresh = store.tasks()[0];
    fresh.delivery = { title: "new", text: "new" };
    store.save(fresh);
    stale.archived = true;
    store.save(stale);
    assert.equal(store.tasks()[0].delivery?.title, "new");
    assert.equal(store.tasks()[0].archived, true);
  } finally {
    store.close();
  }
});

test("saving successive delivered cards preserves every message reference", () => {
  const store = new TaskStore(":memory:");
  try {
    store.save({
      id: "two-cards",
      state: "draft",
      refs: [],
      history: [],
      origin: message("om_two", "task"),
      cards: [
        { revision: "v1", text: "old" },
        { revision: "v2", text: "new" },
      ],
    } as any);
    const task = store.tasks()[0];
    for (const card of task.cards!) {
      card.ref = "om_" + card.revision;
      task.refs.push(card.ref);
      store.save(task);
    }
    assert.deepEqual(
      store.tasks()[0].cards!.map((card) => card.ref),
      ["om_v1", "om_v2"],
    );
  } finally {
    store.close();
  }
});

test("ending an unheard verification round does not claim its process stopped", async (t) => {
  const f = fixture(t, async () => ({ ...plan, kind: "verify" }));
  f.inbox.receive(message("om_unheard", "验收组件"));
  await f.inbox.tick();
  f.inbox.receive(message("om_confirm_unheard", "确认"));
  await f.inbox.tick();
  f.ports.outcome = async () => ({
    runs: [{ id: 1, state: "cancelled", summary: "本人停掉：这一轮早已没有回音", error: "进程可能还在" }],
  });
  await f.inbox.tick();
  const reply = f.replies.findLast((r) => r.key.startsWith("ft-result-"))!;
  assert.ok(reply);
  assert.doesNotMatch(reply.text, /本轮已停止/);
  assert.match(reply.text, /进程可能还在/);
  assert.equal(f.inbox.proposals()[0].delivery?.title, "验收已结束");
});

test("task cards keep current delivery progress ahead of the original request and only a draft offers actions", () => {
  const task = { task: "123456789abc", revision: "r1", text: "待确认任务 123456789abc\n检查帮助链接" };
  for (const stage of ["review", "ci", "approval", "repair", "shipping", "complete"] as const) {
    const card = renderProposal({ ...task, status: "finished", delivery: { stage, title: "进度", text: "最新进展" } });
    assert.match(JSON.stringify(card.body.elements[0]), /最新进展/);
    assert.doesNotMatch(JSON.stringify(card), /待确认任务|callback/);
  }
  assert.match(JSON.stringify(renderProposal({ ...task, status: "draft" })), /callback/);
});
