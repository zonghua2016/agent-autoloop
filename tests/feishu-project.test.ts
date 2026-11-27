// Prevent a shared view, a stale login or a repeated poll from sending someone else's work for development.
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { personalItems, eventsFor, type Settings, type Call } from "../plugins/feishu-project/items.ts";

import { setup } from "./helpers.ts";
import { publish, run } from "../plugins/feishu-project/run.ts";

const settings: Settings = {
  profile: { userKey: "me-1", role: "前端", match: "role", projects: ["garden"] },
  roles: { 前端: { storyOwner: "fe", issuePlatforms: ["fe"] } },
  projects: {
    garden: {
      businessLine: "平台",
      issueView: "https://project.feishu.cn/team/issueView/abc",
      storyView: "https://project.feishu.cn/team/storyView/def",
      ready: { issue: ["待处理"], story: ["开发中"] },
    },
  },
};
function item(id: number, fields: Record<string, unknown> = {}, kind = "issue") {
  const data: Record<string, unknown> = {
    业务线: "line-1",
    经办人: [{ key: "me-1" }],
    所属端: { value: "fe", label: "前端" },
    缺陷状态: "待处理",
    前端开发: [{ key: "me-1" }],
    状态: "开发中",
    ...fields,
  };
  return {
    work_item_attribute: {
      work_item_id: String(id),
      work_item_name: String(data.title ?? "工作项 " + id),
      owned_project: { simple_name: "team" },
      work_item_type: { key: kind },
      work_item_status: { name: data[kind === "issue" ? "缺陷状态" : "状态"] },
      role_members: [
        { key: "operator", members: data.经办人 },
        { key: "fe", members: data.前端开发 },
      ],
    },
    work_item_fields: [
      { key: "business", value: data.业务线 },
      { key: "bug_classification", value: data.所属端 },
    ],
  };
}
const meta = { list: [{ field_key: "business", option: [{ option_id: "line-1", option_name: "平台" }] }] };
const page = (rows: unknown[], has_more = false) => ({ work_item_list: rows, pagination: { has_more } });
const fixture =
  (issue: unknown[], story: unknown[] = [], user = "me-1"): Call =>
  async (r, _m, p) =>
    r === "user" ? { user_key: user } : r === "workitem" ? meta : page(p.view_id === "abc" ? issue : story);

test("only the configured business line, platform and exact responsible user enter the personal list", async () => {
  const result = await personalItems(
    settings,
    fixture(
      [
        item(11),
        item(12, { 业务线: "别的项目" }),
        item(13, { 所属端: "iOS" }),
        item(14, { 经办人: [{ key: "other", name: "me-1" }] }),
        item(15, { 经办人: [] }),
        item(16, { 所属端: null }),
      ],
      [item(21, {}, "story"), item(22, { 前端开发: [], 后端开发: ["me-1"] }, "story")],
    ),
  );
  assert.deepEqual(
    result.map((x) => [x.kind, x.id]),
    [
      ["issue", "11"],
      ["story", "21"],
    ],
  );
});
test("identity mismatch stops before reading a shared view", async () => {
  const calls: string[] = [];
  await assert.rejects(
    personalItems(settings, async (r) => {
      calls.push(r);
      return { user_key: "other" };
    }),
    /身份/,
  );
  assert.deepEqual(calls, ["user"]);
});
test("a second page is filtered and overlap keeps one stable event per item across polls", async () => {
  const call: Call = async (r, _m, p) =>
    r === "user"
      ? { user_key: "me-1" }
      : r === "workitem"
        ? meta
        : p.view_id === "def"
          ? page([])
          : p.page_num === 1
            ? page([item(11)], true)
            : page([item(11), item(12, { 缺陷状态: "关闭" })]);
  const items = await personalItems(settings, call);
  assert.equal(items.length, 2);
  const events = eventsFor(items);
  assert.deepEqual(
    events.map((e) => e.type),
    ["garden.bug"],
  );
  const edited = await personalItems(settings, fixture([item(11, { title: "改名" })]));
  assert.equal(eventsFor(edited)[0].id, events[0].id);
  const home = setup("feishu-project-routing");
  const rules = join(home, "rules.json");
  process.env.AGENT_AUTOLOOP_RULES = rules;
  writeFileSync(
    rules,
    JSON.stringify({
      sources: { "feishu-project": { name: "飞书项目" } },
      agents: { dev: { name: "开发", use: "codex", worker: "worker" } },
      channels: {},
      rules: [
        {
          name: "开发",
          when: { source: "feishu-project", types: ["garden.bug", "garden.feature"] },
          to: "dev",
          prompt: "按项目规则开发",
          cwd: home,
          parallel: 1,
        },
      ],
    }),
  );
  const { ingest, claimNext } = await import("./hub.ts");
  const send = async (event: (typeof events)[number]) => ingest("feishu-project", event);
  assert.equal(await publish(events, send), 1);
  assert.equal(await publish(eventsFor(edited), send), 0);
  assert.equal(claimNext("worker", "first")?.context.events[0].summary, events[0].summary);
  assert.equal(claimNext("worker", "second"), null);
});
test("an unknown project or role and a malformed view response fail closed", async () => {
  for (const profile of [
    { ...settings.profile, projects: ["other"] },
    { ...settings.profile, role: "未知" },
    { ...settings.profile, projects: [] },
  ]) {
    await assert.rejects(personalItems({ ...settings, profile }, fixture([])));
  }
  await assert.rejects(
    personalItems(settings, async (r) => (r === "user" ? { user_key: "me-1" } : { error: "denied" })),
  );
});

test("two project subscriptions share one view and an ambiguous business line cannot route twice", async () => {
  const projects = { ...settings.projects, other: { ...settings.projects!.garden, businessLine: "搜索" } };
  const profile = { ...settings.profile, projects: ["garden", "other"] };
  let read = 0;
  const call: Call = async (resource, method, params) => {
    if (resource === "workitem")
      return {
        list: [
          { field_key: "business", option: [...meta.list[0].option, { option_id: "line-2", option_name: "搜索" }] },
        ],
      };
    if (resource === "view") read++;
    return fixture([item(11), item(12, { 业务线: "line-2" }), item(13, { 业务线: null })])(resource, method, params);
  };
  assert.deepEqual(
    (await personalItems({ ...settings, projects, profile }, call)).map((i) => i.project),
    ["garden", "other"],
  );
  assert.equal(read, 2);
  await assert.rejects(
    personalItems({ ...settings, projects: { ...projects, other: settings.projects!.garden }, profile }, call),
    /多个项目/,
  );
});

test("the list command invokes the configured client and returns only this user's work", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fp-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "meegle.cjs");
  const script = [
    "const [r,m,...flags]=process.argv.slice(2);",
    'if(process.env.MEEGLE_HOST!=="project.feishu.cn"||flags.at(-1)!=="json") process.exit(2);',
    'const params=flags.includes("--params")?JSON.parse(flags[flags.indexOf("--params")+1]):{};',
    "let response;",
    'if(r==="user"&&m==="me")response={user_key:"me-1"};',
    'else if(r==="workitem"&&m==="meta-fields")response=' + JSON.stringify(meta) + ";",
    'else if(r==="view"&&m==="get"&&params.fields.includes("business"))response=params.view_id==="abc"?' +
      JSON.stringify(page([item(11), item(13, { 经办人: [] })])) +
      ":" +
      JSON.stringify(page([])) +
      ";",
    "else process.exit(1);console.log(JSON.stringify(response));",
  ];
  writeFileSync(cli, script.join("\n"));
  const result = JSON.parse(await run({ ...settings, cli }, "list"));
  assert.deepEqual(
    result.map((r: { id: string }) => r.id),
    ["11"],
  );
});

test("scheduled dispatch requires a pinned user even when manual listing can use the current login", async () => {
  await assert.rejects(run({ ...settings, profile: { ...settings.profile, userKey: undefined } }, "poll"), /userKey/);
});

test("all-business owner mode follows my assignments even with no business line or a different platform", async () => {
  const config: Settings = {
    ...settings,
    profile: { ...settings.profile, projects: "*", match: "owner" },
    views: { story: settings.projects!.garden.storyView, issue: settings.projects!.garden.issueView },
  };
  const assigned = item(31, { 业务线: null, 所属端: "ios" });
  const other = item(32, { 业务线: null, 经办人: [{ key: "other" }] });
  const node = {
    ...item(33, { 业务线: "out", 前端开发: [] }, "story"),
    work_item_current_node: [{ owners: [{ key: "me-1" }] }],
  };
  const current = item(34, { 业务线: null, 经办人: [] });
  current.work_item_fields.push({ key: "current_status_operator", value: [{ key: "me-1" }] });
  const items = await personalItems(config, fixture([assigned, other, current], [node]));
  assert.deepEqual(
    items.map((i) => i.id),
    ["31", "34", "33"],
  );
  assert.equal(eventsFor(items).length, 0);
  assert.deepEqual(
    (await personalItems({ ...config, projects: {} }, fixture([assigned]))).map((i) => i.id),
    ["31"],
  );
});

test("dispatch reads descriptions only for eligible items and drops a reassigned item before it reaches the hub", async () => {
  const detailIds: unknown[] = [];
  const call: Call = async (r, m, p) => {
    if (r === "view") assert.ok(!(p.fields as string[]).includes("description"));
    if (r === "workitem" && m === "get") {
      detailIds.push(p.work_item_id);
      const row = item(Number(p.work_item_id), p.work_item_id === "11" ? { 经办人: [] } : {});
      row.work_item_fields.push({ key: "description", value: "复现步骤" });
      return row;
    }
    return fixture([item(11), item(12, { 经办人: [] }), item(13), item(14, { 缺陷状态: "关闭" })])(r, m, p);
  };
  const events = eventsFor(await personalItems(settings, call, true));
  assert.deepEqual(detailIds, ["11", "13"]);
  assert.deepEqual(
    events.map((e) => JSON.parse(e.detail).description),
    ["复现步骤"],
  );
});

test("pilot routes only enrolled issue IDs in the registered view even without a business line", async () => {
  const config: Settings = {
    ...settings,
    projects: {
      garden: {
        issueView: settings.projects!.garden.issueView,
        issueIds: ["11", "14", "15"],
        ready: { issue: ["OPEN", "REOPENED"] },
      },
    },
  };
  const rows = [
    item(11, { 业务线: null, 缺陷状态: "OPEN" }),
    item(12, { 业务线: null, 缺陷状态: "OPEN" }),
    item(14, { 缺陷状态: "IN PROGRESS" }),
    item(15, { 缺陷状态: "REOPENED", 经办人: [] }),
  ];
  const call: Call = async (r, m, p) => {
    if (r === "workitem") {
      assert.equal(m, "get");
      assert.equal(p.work_item_id, "11");
      return rows[0];
    }
    return fixture(rows)(r, m, p);
  };
  const events = eventsFor(await personalItems(config, call, true));
  assert.deepEqual(
    events.map((e) => e.type),
    ["garden.bug"],
  );
  await assert.rejects(
    personalItems({ ...config, projects: { garden: { ...config.projects!.garden, businessLine: "平台" } } }, call),
    /登记/,
  );
});

test("the worker can deliver its single enrolled bug through a scoped receipt without a source secret", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fp-receipt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = join(dir, "client.cjs"),
    row = item(11);
  writeFileSync(
    cli,
    'const [r,m]=process.argv.slice(2); console.log(JSON.stringify(r==="user"?{user_key:"me-1"}:r==="view"?' +
      JSON.stringify(page([row])) +
      ":" +
      JSON.stringify(row) +
      "));",
  );
  const config: Settings = {
    ...settings,
    cli,
    projects: {
      garden: { issueIds: ["11"], issueView: settings.projects!.garden.issueView, ready: { issue: ["待处理"] } },
    },
  };
  const { readMessage } = await import("../worker/contract.ts");
  const { parseResult } = await import("../protocol/validate.ts");
  const first = readMessage(await run(config, "receipt"));
  const result = parseResult({ outcome: first.outcome, ...first.receipt });
  assert.equal(result.events?.[0].type, "garden.bug");
  assert.deepEqual(readMessage(await run(config, "receipt")).receipt, first.receipt);
  await assert.rejects(run({ ...config, profile: { ...config.profile, userKey: undefined } }, "receipt"), /userKey/);
});

test("space-wide assignment finds a colleague's report across pages and rechecks before dispatch", async () => {
  const config: Settings = {
    profile: settings.profile,
    projects: { garden: { assignedIssueSpace: "team", ready: { issue: ["待处理"] } } },
  };
  const detail: string[] = [];
  const call: Call = async (r, m, p) => {
    if (r === "user") return { user_key: "me-1" };
    assert.equal(r, "workitem");
    if (m === "meta-roles") return { list: [{ role_id: "operator", role_name: "经办人" }] };
    if (m === "query") {
      if (p.mql)
        assert.equal(
          p.mql,
          "SELECT `work_item_id` FROM `team`.`issue` WHERE array_contains(`__经办人`, current_login_user()) AND (`work_item_status` = '待处理')",
        );
      else {
        assert.equal(p.session_id, "session");
        assert.deepEqual(p.group_pagination_list, [{ group_id: "1", page_num: 2 }]);
      }
      const ids = p.mql ? [11, 12] : [13, 14];
      return {
        session_id: "session",
        list: [{ count: 4, group_infos: [{ group_id: "1" }] }],
        data: { "1": ids.map((id) => ({ moql_field_list: [{ key: "work_item_id", value: { long_value: id } }] })) },
      };
    }
    const id = Number(p.work_item_id),
      full = (p.fields as string[]).includes("description");
    if (full) detail.push(String(id));
    const row = item(
      id,
      id === 12 ? { 所属端: "ios" } : id === 13 ? { 缺陷状态: "关闭" } : id === 14 && full ? { 经办人: [] } : {},
    );
    row.work_item_attribute.role_members.push({ key: "reporter", members: [{ key: "another" }] });
    return row;
  };
  const events = eventsFor(await personalItems(config, call, true));
  assert.deepEqual(
    events.map((e) => e.link),
    ["https://project.feishu.cn/team/issue/detail/11"],
  );
  assert.deepEqual(detail, ["11", "14"]);
});

test("a large poll continues from its receipt timer instead of dropping work past the hub limit", async () => {
  const { pollReceipt } = await import("../plugins/feishu-project/run.ts");
  const { readMessage } = await import("../worker/contract.ts");
  const { parseResult } = await import("../protocol/validate.ts");
  const events = Array.from({ length: 121 }, (_, n) => ({
    id: String(n + 1),
    subject: "bug-" + n,
    type: "garden.bug",
    summary: "问题",
    detail: "",
    link: "",
    hops: 0,
  }));
  const receive = (context: { timers?: { key: string; about?: string }[] }) => {
    const said = readMessage(pollReceipt(events, context));
    return parseResult({ outcome: said.outcome, ...said.receipt });
  };
  const first = receive({});
  assert.ok(first.events!.length <= 100);
  const second = receive({ timers: first.later });
  assert.equal(new Set([...first.events!, ...second.events!].map((e) => e.id)).size, 121);
  assert.ok(second.later?.[0].cancel);
});
