// Guard against cross-scope recall, stale derivatives, unapproved experience, duplicate bug dispatch and incomplete deliberation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory } from "../plugins/personal/memory.ts";
import { modelRunner } from "../plugins/personal/model.ts";
import { deliberate, collectBugs, care, type Model } from "../plugins/personal/workflow.ts";
import gemini from "../plugins/gemini/agent.ts";

const now = "2026-11-18T08:00:00.000Z";
test("bad extraction output stays retryable without starving later inputs", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-extract-failure-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const config = { database: join(folder, "memory.db"), scope: "private", timezone: "UTC", models: {} };
  using db = new Memory(config.database);
  for (let i = 0; i < 6; i++) {
    const id = db.add({ scope: "private", kind: "raw", text: String(i), at: now });
    db.enqueue("private", id);
  }
  const invoke: Model = async (_model, _operation, data) =>
    (data as any).text === "5"
      ? { entries: [{ kind: "preference", text: "喜欢简短回答" }] }
      : { entries: [{ kind: "care", text: "缺少有效期" }] };
  await assert.rejects(run(config, "extract", [], {}, now, invoke));
  await assert.rejects(run(config, "extract", [], {}, now, invoke));
  assert.equal(db.list("private", now, "preference").length, 1);
  assert.ok(db.pending("private", now).length > 0);
});

test("disabling chat recording also suspends previously queued automatic extraction", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-extract-disabled-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const config = {
    database: join(folder, "memory.db"),
    scope: "private",
    timezone: "UTC",
    models: {},
    recordChats: false,
  };
  using db = new Memory(config.database);
  db.enqueue("private", db.add({ scope: "private", kind: "raw", text: "旧聊天", at: now }));
  let calls = 0;
  await run(config, "extract", [], {}, now, async () => {
    calls++;
    return { entries: [] };
  });
  assert.equal(calls, 0);
  assert.equal(db.pending("private", now).length, 1);
});
test("corrected memories recompute embeddings so semantic recall finds the new fact", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-correct-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const embedding = join(folder, "embedding.mjs");
  writeFileSync(embedding, "export default text => text === '绿色' ? [0, 1] : [1, 0];");
  const config = { database: join(folder, "memory.db"), scope: "private", timezone: "UTC", models: {}, embedding };
  using db = new Memory(config.database);
  const old = db.add({ scope: "private", kind: "preference", text: "红色", at: now, approved: true, vector: [1, 0] });
  const id = await run(config, "correct", [old, "绿色"], {}, now);
  assert.deepEqual(db.get("private", id, now)?.vector, [0, 1]);
  assert.equal(db.search("private", "草地", now, [0, 1])[0]?.id, id);
});

test("large deliberation details remain valid JSON within the event limit", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const { parseResult } = await import("../protocol/validate.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-long-plan-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const result = await run(
    { database: join(folder, "memory.db"), scope: "work", timezone: "UTC", models: {} },
    "plan",
    ["demo"],
    { events: [{ id: 1, type: "demo.feature", subject: "task", summary: "扩展功能" }] },
    now,
    async (_, operation) =>
      operation === "triage"
        ? { complexity: "dsh" }
        : {
            plan: '步骤"\\\n😀'.repeat(200),
            risks: Array(10).fill('风险"\\\n😀'.repeat(50)),
            questions: [],
          },
  );
  const receipt = parseResult({ outcome: "done", ...JSON.parse(/```agent-autoloop\n(.+)\n```/s.exec(result)![1]) });
  const detail = receipt.events!.at(-1)!.detail!;
  const value = JSON.parse(detail);
  assert.ok(detail.length <= 4000 && detail.isWellFormed());
  assert.equal(value.truncated, true);
  assert.ok(value.plan && value.risks.length);
});

test("memory is scoped, can be corrected, and forget cascades into journal and search", () => {
  using m = new Memory(":memory:");
  const fact = m.add({ scope: "private", kind: "decision", text: "发布选蓝色", at: now, approved: true });
  const journal = m.add({ scope: "private", kind: "daily", text: "今天发布选蓝色", at: now, parents: [fact] });
  assert.equal(m.search("work", "蓝色", now).length, 0);
  assert.equal(m.search("private", "蓝色", now).length, 2);
  m.correct("private", fact, "发布选绿色", now);
  assert.equal(m.get("private", journal, now), undefined);
  assert.equal(m.search("private", "绿色", now)[0].text, "发布选绿色");
});

test("experience requires evaluation and approval, review advances and expired care cannot be recalled", () => {
  using m = new Memory(":memory:");
  const id = m.add({ scope: "work", kind: "experience", text: "先跑类型检查", at: now });
  assert.throws(() => m.approve("work", id, now));
  m.evaluate("work", id, true, "复盘样例通过", now);
  m.approve("work", id, now);
  assert.equal(m.search("work", "类型检查", now)[0].id, id);
  const study = m.add({ scope: "private", kind: "study", text: "复习和弦", at: now });
  assert.equal(m.due("private", now)[0].id, study);
  m.revise("private", study, true, now);
  assert.equal(m.due("private", now).length, 0);
  m.add({ scope: "private", kind: "care", text: "想听故事", at: now, expires: "2026-11-19T00:00:00.000Z" });
  assert.equal(m.search("private", "故事", "2026-11-20T00:00:00.000Z").length, 0);
});

test("independent dual reviews must both finish and unresolved points block routing", async () => {
  const calls: string[] = [];
  const run = async (model: string, operation: string) => {
    calls.push(`${model}:${operation}`);
    if (operation === "triage") return { complexity: "dual" };
    if (operation === "review") return { plan: "补测试", risks: [], questions: [] };
    return { plan: "先测试再修改", risks: [], questions: ["缺验收标准"] };
  };
  const plan = await deliberate({ summary: "新增活动" }, run);
  assert.deepEqual(calls, ["dsh:triage", "dsh:review", "gemini:review", "gemini:synthesis"]);
  assert.equal(plan.questions.length, 1);
});

test("deliberation uses the configured reviewer when Gemini is unavailable", async () => {
  const calls: string[] = [];
  const review = { plan: "补测试", risks: [], questions: [] };
  const run = async (model: string, operation: string) => {
    calls.push(`${model}:${operation}`);
    return operation === "triage" ? { complexity: "dual" } : review;
  };
  assert.deepEqual(await deliberate({ summary: "新增活动" }, run, "claude"), review);
  assert.deepEqual(calls, ["dsh:triage", "dsh:review", "claude:review", "claude:synthesis"]);
});

test("a failed peer is tried once per round and one surviving reviewer can send a plan to Codex", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const { parseResult } = await import("../protocol/validate.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-fallback-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = join(folder, "model.mjs");
  const calls = join(folder, "calls");
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
const [name, prompt] = process.argv.slice(2);
const triage = prompt.includes('"complexity"');
appendFileSync(${JSON.stringify(calls)}, name + (triage ? ':triage' : ':review') + '\\n');
if (name === 'gpt') process.exit(1);
console.log(JSON.stringify(triage ? { complexity: 'dual' } : { plan: '补测试', risks: [], questions: [] }));
`,
  );
  const model = (name: string) => ({ use: "command", command: [process.execPath, file, name, "{prompt}"] });
  const config = {
    database: join(folder, "memory.db"),
    timezone: "UTC",
    scope: "work",
    models: { dsh: model("dsh"), gpt: model("gpt") },
    roles: { review: "gpt" },
    fallbackModels: ["dsh", "gpt"],
  };
  const answer = await run(
    config,
    "plan",
    ["demo"],
    { events: [{ id: 7, type: "demo.feature", subject: "task", summary: "补测试" }] },
    now,
  );
  assert.match(answer, /单一模型.*Codex/);
  const receipt = /\x60\x60\x60agent-autoloop\n(.+)\n\x60\x60\x60/s.exec(answer)![1];
  const result = parseResult({ outcome: "done", ...JSON.parse(receipt) });
  assert.ok(result.events?.some((event) => event.type === "demo.ready"));
  assert.equal(readFileSync(calls, "utf8"), "dsh:triage\ndsh:review\ngpt:review\n");
});

test("configured alternatives are tried in order until a model works or the list is exhausted", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "personal-fallback-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const calls = join(folder, "calls");
  const models = Object.fromEntries(
    ["primary", "next", "last"].map((name, index) => [
      name,
      {
        use: "command",
        command: [
          process.execPath,
          "-e",
          `require('node:fs').appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name + "\n")});` +
            (index < 2 ? "process.exit(9);" : "console.log(JSON.stringify({text:'可用'}));"),
        ],
      },
    ]),
  );
  const runner = modelRunner(models, ["next", "primary", "last"]);
  assert.deepEqual(await runner("primary", "chat", {}), { text: "可用" });
  assert.equal(readFileSync(calls, "utf8"), "primary\nnext\nlast\n");
  await assert.rejects(modelRunner(models, ["next"])("primary", "chat", {}), /primary.*next/);
});

test("a fallback model cannot evaluate its own saved experience on a later run", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-experience-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const config = {
    database: join(folder, "memory.db"),
    timezone: "UTC",
    scope: "work",
    models: {},
    fallbackModels: ["dsh", "gpt"],
    roles: { evaluate: "gpt" },
  };
  using db = new Memory(config.database);
  db.add({ scope: "work", kind: "feedback", text: "加上回归测试", at: now });
  const model: Model = async (_, operation, __, choice) => {
    if (operation === "experience") {
      assert.ok(choice?.selected);
      choice.selected("gpt");
      return { text: "先加回归测试" };
    }
    throw new Error("本轮无独立评估");
  };
  await assert.rejects(run(config, "improve", [], {}, now, model), /本轮无独立评估/);
  const saved = db.list("work", now, "procedure")[0];
  await run(config, "evaluate", [saved.id], {}, now, async (_, operation, __, choice) => {
    assert.equal(operation, "evaluate");
    assert.equal(choice?.exclude, "gpt");
    return { passed: true, evidence: "另一模型已核对" };
  });
});

test("bug feed only claims configured projects and replays the same revision ID", async () => {
  const rows = [
    { id: "17", revision: "2", project: "demo", summary: "显示异常" },
    { id: "18", revision: "2", project: "other", summary: "未知项目" },
  ];
  const claimed: string[] = [];
  const provider = {
    list: async () => rows,
    claim: async (_: unknown, id: string) => {
      claimed.push(id);
      return true;
    },
  };
  const first = await collectBugs(provider, "demo", "sprint");
  assert.deepEqual(first, await collectBugs(provider, "demo", "sprint"));
  assert.equal(first.length, 1);
  assert.equal(claimed[0], claimed[1]);
});

test("care respects quiet hours including midnight", () => {
  assert.equal(care({ enabled: true, timezone: "UTC", quietStart: 22, quietEnd: 8 }, "2026-11-18T23:00:00Z"), false);
  assert.equal(care({ enabled: true, timezone: "UTC", quietStart: 22, quietEnd: 8 }, now), true);
});

test("Gemini keeps session and requires a successful terminal event", () => {
  const first = '{"type":"init","session_id":"s1"}\n{"type":"message","role":"assistant","content":"完成"}\n';
  assert.equal(gemini.read(first, null, "").finished, undefined);
  assert.equal(gemini.read(first + '{"type":"result","status":"success"}\n', 0, "").text, "完成");
  assert.ok(gemini.read(first, 1, "").error);
});

test("the plugin clarifies, then passes the original requirement and agreed plan through a valid worker receipt", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { run } = await import("../plugins/personal/run.ts");
  const { parseResult } = await import("../protocol/validate.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-test-"));
  try {
    const config = { database: join(folder, "memory.db"), timezone: "UTC", scope: "work", models: {} };
    const model = async (_: string, op: string, data: any) =>
      op === "triage"
        ? { complexity: "dsh" }
        : {
            plan: "实现活动",
            risks: [],
            questions: data.clarification ? [] : ["支持哪些终端？"],
          };
    const receipt = (s: string) =>
      parseResult({ outcome: "done", ...JSON.parse(/\x60\x60\x60agent-autoloop\n(.+)\n\x60\x60\x60/s.exec(s)![1]) });
    const initial = await run(
      config,
      "plan",
      ["demo"],
      {
        events: [{ id: 1, type: "demo.feature", subject: "work-item", summary: "新增活动", detail: "保留 Figma 节点" }],
      },
      now,
      model,
    );
    const card = receipt(initial).ask![0];
    const extra = { id: 2, type: "demo.change", subject: "work-item", summary: "补充适配" };
    const update = receipt(await run(config, "plan", ["demo"], { events: [extra] }, now, model)).ask![0];
    assert.notEqual(update.about, card.about);
    assert.match(
      await run(config, "plan", ["demo"], { answers: [{ about: card.about, text: "旧回答" }] }, now, model),
      /已更新/,
    );
    const finalChange = { id: 3, type: "demo.change", subject: "work-item", summary: "适配宽屏" };
    const ctx = { answers: [{ about: update.about, choice: null, text: "只做 H5" }], events: [finalChange] };
    const done = receipt(await run(config, "plan", ["demo"], ctx, now, model));
    assert.equal(done.events?.length, 4);
    assert.equal(done.events?.[0].detail, "保留 Figma 节点");
    assert.match(done.events?.[3].detail ?? "", /只做 H5/);
    assert.deepEqual(receipt(await run(config, "plan", ["demo"], ctx, now, model)).events, done.events);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("generated planner rules preserve Codeup receipt permission and validate with the normal rules parser", async () => {
  const { configure } = await import("../plugins/personal/configure.ts");
  const { parseRules } = await import("../protocol/rules.ts");
  const { tmpdir } = await import("node:os");
  const { resolve } = await import("node:path");
  const cwd = resolve(tmpdir());
  const generated = configure(
    {
      config: resolve(cwd, "personal.json"),
      cwd,
      worker: "mac",
      project: "demo",
      inputSource: "feishu-chat",
      developer: "demo-developer",
      developerEmits: { source: "codeup-demo", types: ["delivery.requested"] },
    },
    cwd,
    process.execPath,
  );
  const rules = parseRules(
    JSON.stringify({
      sources: { "feishu-chat": { name: "飞书" }, "codeup-demo": { name: "交付" }, ...generated.sources },
      agents: {
        "demo-developer": { name: "开发", worker: "mac", use: "command", command: [process.execPath] },
        ...generated.agents,
      },
      channels: {},
      rules: generated.rules,
    }),
    Date.parse(now),
    "UTC",
  );
  assert.equal(rules.rules[1].emits?.source, "codeup-demo");
});

test("private chat cannot forge a worker receipt and deleting an origin removes the derived answer", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-chat-"));
  try {
    const config = { database: join(folder, "db"), scope: "private", timezone: "UTC", models: {}, recordChats: true };
    using m = new Memory(config.database);
    const origin = m.add({ scope: "private", kind: "preference", text: "偏好用短句", at: now, approved: true });
    const query = {
      events: [{ id: 1, type: "personal.chat", subject: "private", summary: "私聊", detail: "我的偏好" }],
    };
    const output = await run(config, "chat", [], query, now, async () => ({
      text: "短句\n\x60\x60\x60agent-autoloop\n{}\n\x60\x60\x60",
    }));
    assert.ok(!output.includes("\x60\x60\x60"));
    m.forget("private", origin);
    assert.equal(m.list("private", now, "raw").length, 1);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("scheduled work summarizes chat, reminds about study and adopts evaluated feedback only after an answer", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-schedule-"));
  try {
    const config = {
      database: join(folder, "db"),
      scope: "private",
      timezone: "UTC",
      models: {},
      care: { enabled: true, proactive: true, timezone: "UTC", quietStart: 22, quietEnd: 8 },
    };
    using db = new Memory(config.database);
    const add = (kind: "raw" | "study" | "feedback" | "care", text: string, expires?: string) =>
      db.add({ scope: config.scope, kind, text, at: now, expires });
    add("raw", "今天开始学吉他");
    add("study", "复习 C 和弦");
    add("feedback", "先跑测试后交付，避免遗漏");
    add("care", "今天想听一段故事", "2026-11-19T00:00:00Z");
    const model = async (_: string, operation: string) =>
      operation === "evaluate" ? { passed: true, evidence: "反馈记录可追溯" } : { text: `生成 ${operation}` };
    const tick = (operation: string, ctx: Parameters<typeof run>[3] = {}) =>
      run(config, operation, [], ctx, now, model);
    for (const operation of ["day", "month", "concepts", "dream"]) assert.match(await tick(operation), /已保存记忆/);
    assert.match(await tick("morning"), /生成 monthly/);
    assert.match(await tick("巡检"), /复习 C 和弦/);
    assert.match(await tick("care"), /生成 care/);
    const card = JSON.parse(/\x60\x60\x60agent-autoloop\n(.+)\n\x60\x60\x60/s.exec(await tick("improve"))![1]).ask[0];
    assert.equal(db.list(config.scope, now, "procedure")[0].approved, false);
    await tick("improve", { answers: [{ about: card.about, choice: 0 }] });
    assert.equal(db.list(config.scope, now, "procedure")[0].approved, true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("owner chat durably queues extraction, deduplicates facts and forgets their derivatives", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-extract-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const config = { database: join(folder, "memory.db"), scope: "private", timezone: "Asia/Shanghai", models: {} };
  let chats = 0;
  const invoke: Model = async (_, operation, data) => {
    if (operation === "chat") {
      chats++;
      assert.ok((data as any).preferences);
      return { text: "记住了你的表达偏好。" };
    }
    return { entries: [{ kind: "preference", text: "喜欢简短回答" }] };
  };
  const context = {
    events: [{ id: "one", type: "personal.chat", subject: "private", summary: "聊天", detail: "我喜欢简短回答" }],
  };
  await run(config, "chat", [], context, now, invoke);
  await run(config, "chat", [], context, now, invoke);
  assert.equal(chats, 1);
  await run(config, "extract", [], {}, now, invoke);
  await run(config, "extract", [], {}, now, invoke);
  using db = new Memory(config.database);
  const prefs = db.list("private", now, "preference");
  assert.equal(prefs.length, 1);
  assert.equal(prefs[0].approved, true);
  assert.ok(prefs[0].parents?.length);
  db.forget("private", prefs[0].parents![0]);
  assert.equal(db.list("private", now, "preference").length, 0);
});

test("cached chat repairs a missing extraction job and history keeps each user before its answer", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "personal-recovery-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const config = { database: join(folder, "memory.db"), scope: "private", timezone: "UTC", models: {} };
  const contexts = (id: string) => ({
    events: [{ id, type: "personal.chat", subject: "private", summary: "聊天", detail: "我喜欢绿色" + id }],
  });
  let history: any[] = [];
  const invoke: Model = async (_, op, data) => {
    history = (data as any).history;
    return { text: "答" + (data as any).query };
  };
  const original = Memory.prototype.enqueue;
  Memory.prototype.enqueue = () => {
    throw Error("simulated crash before enqueue");
  };
  try {
    await assert.rejects(run(config, "chat", [], contexts("一"), now, invoke));
  } finally {
    Memory.prototype.enqueue = original;
  }
  await run(config, "chat", [], contexts("一"), now, invoke);
  using db = new Memory(config.database);
  assert.equal(db.pending("private", now).length, 1);
  await run(config, "chat", [], contexts("二"), now, invoke);
  await run(config, "chat", [], contexts("三"), now, invoke);
  assert.deepEqual(history, [
    { role: "user", text: "我喜欢绿色一" },
    { role: "assistant", text: "答我喜欢绿色一" },
    { role: "user", text: "我喜欢绿色二" },
    { role: "assistant", text: "答我喜欢绿色二" },
  ]);
});

test("a scheduled month summarizes the previous month once and explicit recovered care expires its descendants", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const dir = mkdtempSync(join(tmpdir(), "personal-month-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = { database: join(dir, "memory.db"), scope: "private", timezone: "UTC", models: {} };
  using db = new Memory(config.database);
  db.add({ scope: "private", kind: "daily", text: "十月日记", at: "2026-10-20T00:00:00Z" });
  db.add({ scope: "private", kind: "daily", text: "十一月日记", at: "2026-11-01T00:00:00Z" });
  const context = { events: [{ id: 1, type: "schedule.tick", subject: "", summary: "" }] };
  let calls = 0;
  const invoke: Model = async (_, operation, data) => {
    calls++;
    assert.equal((data as any[])[0].text, "十月日记");
    return { text: "十月总结" };
  };
  await run(config, "month", [], context, "2026-11-01T08:00:00Z", invoke);
  await run(config, "month", [], context, "2026-11-02T08:00:00Z", invoke);
  assert.equal(calls, 1);
  const care = db.add({
    scope: "private",
    kind: "care",
    text: "最近状态不佳",
    at: now,
    expires: "2026-11-20T00:00:00Z",
  });
  const child = db.add({ scope: "private", kind: "care-message", text: "问候", at: now, parents: [care] });
  const input = db.add({ scope: "private", kind: "raw", text: "我已经恢复了，不用再提醒", at: now });
  db.enqueue("private", input);
  await run(config, "extract", [], {}, now, async () => ({
    entries: [{ kind: "care", text: "用户已恢复", replaces: care, resolved: true }],
  }));
  assert.equal(db.get("private", care, now), undefined);
  assert.equal(db.get("private", child, now), undefined);
});

test("expired parents never hide valid extraction work behind the queue limit", () => {
  using db = new Memory(":memory:");
  for (let i = 0; i < 6; i++) {
    const id = db.add({
      scope: "private",
      kind: "raw",
      text: String(i),
      at: now,
      ...(i < 5 ? { expires: "2026-11-19T00:00:00Z" } : {}),
    });
    db.enqueue("private", id);
  }
  assert.deepEqual(
    db.pending("private", "2026-11-20T00:00:00Z").map((row) => row.text),
    ["5"],
  );
});

test("invalid extraction stops automatically and can be retried explicitly after restart", async (t) => {
  const { run } = await import("../plugins/personal/run.ts");
  const folder = mkdtempSync(join(tmpdir(), "extract-limit-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const config = { database: join(folder, "memory.db"), scope: "private", timezone: "UTC", models: {} };
  {
    using db = new Memory(config.database);
    db.enqueue("private", db.add({ scope: "private", kind: "raw", text: "example", at: now }));
  }
  let calls = 0;
  const invoke: Model = async () => {
    calls++;
    return { entries: [{ kind: "care", text: "missing expiry" }] };
  };
  for (let i = 0; i < 5; i++) await run(config, "extract", [], {}, now, invoke).catch(() => {});
  assert.equal(calls, 3);
  const failed = JSON.parse(await run(config, "extract-failures", [], {}, now, invoke));
  assert.equal(failed.length, 1);
  await run(config, "extract-retry", [], {}, now, invoke);
  await run(config, "extract", [], {}, now, async () => ({ entries: [] }));
  assert.deepEqual(JSON.parse(await run(config, "extract-failures", [], {}, now, invoke)), []);
});

test(
  "a sole registered Codex answers the chat role when other tools are absent",
  { skip: process.platform === "win32" },
  async (t) => {
    const { run } = await import("../plugins/personal/run.ts");
    const dir = mkdtempSync(join(tmpdir(), "codex-only-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const program = join(dir, "codex");
    writeFileSync(
      program,
      "#!" +
        process.execPath +
        "\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({text:'测试回复'})}}));console.log(JSON.stringify({type:'turn.completed'}));",
      { mode: 0o700 },
    );
    const config = {
      database: join(dir, "notes.db"),
      scope: "test",
      timezone: "UTC",
      models: { local: { use: "codex", program } },
      recordChats: false,
    };
    assert.equal(
      await run(
        config,
        "chat",
        [],
        { events: [{ id: 1, type: "chat", subject: "sample", summary: "合成样例", detail: "合成样例" }] },
        now,
      ),
      "测试回复",
    );
  },
);
