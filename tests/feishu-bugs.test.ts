// Prevent duplicate jobs/notices, stale checks requesting a merge, table data changing the project, and automatic merging.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { poll, work, ensureReviewMR, assertUnmergedMR, type Config, type Row } from "../plugins/feishu-bugs/run.ts";
import { readMessage } from "../worker/contract.ts";
import { receiptBlock } from "../plugins/delivery/input.ts";
import { Store } from "../plugins/codeup/store.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bitable-pilot-"));
  const config: Config = {
    database: join(dir, "jobs.db"),
    cli: "/fake/lark",
    base: "base1",
    table: "table1",
    url: "https://example.test/base/base1",
    project: "test-project",
    registry: "/fake/projects.json",
    target: "autoloop/acceptance",
    records: ["rec1"],
  };
  const row: Row = {
    record_id: "rec1",
    fields: {
      "Bug 标题": "日期缺失却显示今天",
      所属项目: "test-project",
      状态: "待修复",
      复现步骤: "formatDateTime(undefined)",
    },
  };
  const updates: unknown[] = [];
  const ports = {
    get: async () => structuredClone(row),
    update: async (_id: string, fields: Record<string, unknown>) => {
      updates.push(fields);
      Object.assign(row.fields, fields);
    },
    proof: async () => ({ text: "独立 CR / CI 同提交通过", link: "https://example.test/verified-mr/1" }),
  };
  return { config, row, ports, updates, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test("only freshly verified CR and CI notify the approved owner, retrying a lost reply once across restarts", async () => {
  const f = fixture();
  try {
    f.config.notifyUsers = ["ou_owner", "ou_accept"];
    Object.assign(f.row.fields, {
      负责人: [{ id: "ou_owner" }, { id: "ou_owner" }, { id: "ou_outside" }],
      验收人: [{ id: "ou_accept" }],
    });
    const evidence = { mr: 1, branch: "autoloop/bug", head: "a".repeat(40), base: "b".repeat(40) };
    let valid = true;
    let merged = false;
    let lost = true;
    let develops = 0;
    const attempts: { to: string; body: string; id: string }[] = [];
    const ports = {
      ...f.ports,
      proof: async () => {
        if (!valid) throw new Error("CR / CI 或提交已变化");
        return {
          text: "CR / CI 同提交通过",
          link: "https://example.test/mr/1",
          evidence,
          checks: { cr: "https://example.test/mr/1", ci: "https://flow.aliyun.com/pipelines/99/builds/5" },
        };
      },
      release: async () => ({ note: merged ? "已合并" : "待本人合并", awaitingMerge: !merged }),
      develop: async () => {
        develops++;
        return "完成\n" + receiptBlock({ events: [{ id: "ready", type: "delivery.requested", subject: "repo#1" }] });
      },
      send: async (to: string, body: string, id: string) => {
        attempts.push({ to, body, id });
        if (lost) {
          lost = false;
          throw new Error("send reply lost");
        }
        return "om_merge";
      },
    };
    const events = readMessage(await poll(f.config, ports)).receipt!.events as any[];
    await work(f.config, { events }, ports);
    assert.equal(attempts.length, 0);
    valid = false;
    await poll(f.config, ports);
    assert.equal(attempts.length, 0);
    valid = true;
    await poll(f.config, ports);
    await poll(f.config, ports);
    await poll(f.config, ports);
    await work(f.config, { events }, ports);
    assert.equal(develops, 1);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].id, attempts[1].id);
    assert.equal(attempts[0].to, "ou_owner");
    for (const content of [
      "请负责人确认合并",
      "record=rec1",
      "https://example.test/mr/1",
      "/pipelines/99/builds/5",
      evidence.head,
    ])
      assert.ok(attempts[0].body.includes(content));
    assert.equal(f.row.fields["状态"], "修复中");
    merged = true;
    await poll(f.config, ports);
    assert.equal(attempts.length, 2);
  } finally {
    f.clean();
  }
});

test("merge reminders stop on changed proof, manual closure, and an expired unknown send", async () => {
  const f = fixture();
  try {
    f.config.notifyUsers = ["ou_owner"];
    f.row.fields["负责人"] = [{ id: "ou_owner" }];
    const evidence = { mr: 1, branch: "autoloop/bug", head: "a".repeat(40), base: "b".repeat(40) };
    let changed = false;
    let sends = 0;
    const ports = {
      ...f.ports,
      proof: async () => ({
        text: "通过",
        link: "https://example.test/mr/1",
        evidence: { ...evidence, head: changed ? "c".repeat(40) : evidence.head },
        checks: { cr: "https://example.test/mr/1", ci: "https://flow.aliyun.com/pipelines/99/builds/5" },
      }),
      release: async () => ({ note: "待合并", awaitingMerge: true }),
      develop: async () =>
        "完成\n" + receiptBlock({ events: [{ id: "ready", type: "delivery.requested", subject: "repo#1" }] }),
      send: async () => {
        sends++;
        throw new Error("reply lost");
      },
    };
    const events = readMessage(await poll(f.config, ports)).receipt!.events as any[];
    await work(f.config, { events }, ports);
    changed = true;
    await poll(f.config, ports);
    assert.equal(sends, 0);
    changed = false;
    f.row.fields["状态"] = "已关闭";
    await poll(f.config, ports);
    assert.equal(sends, 0);
    f.row.fields["状态"] = "修复中";
    await poll(f.config, ports);
    assert.equal(sends, 1);
    const db = new Store(f.config.database);
    const job = db.get<any>("base1:table1:rec1", null);
    for (const state of Object.values(job.notified) as { started: number }[]) state.started -= 56 * 60_000;
    db.put("base1:table1:rec1", job);
    db.close();
    const result = readMessage(await poll(f.config, ports));
    assert.equal(sends, 1);
    assert.match(JSON.stringify(result.receipt?.notice), /通知未确认/);
  } finally {
    f.clean();
  }
});

test("a lost merge notification is not retried after the MR is merged", async () => {
  const f = fixture();
  try {
    f.config.notifyUsers = ["ou_owner"];
    f.row.fields["负责人"] = [{ id: "ou_owner" }];
    let merged = false;
    let sends = 0;
    const ports = {
      ...f.ports,
      proof: async () => ({
        text: "CR / CI 通过",
        link: "https://example.test/mr/1",
        evidence: { mr: 1, branch: "autoloop/bug", head: "a".repeat(40), base: "b".repeat(40) },
        checks: { cr: "https://example.test/mr/1/checks", ci: "https://flow.aliyun.com/pipelines/99/builds/5" },
      }),
      release: async () => ({ note: merged ? "已合并，等待测试部署配置" : "待本人合并", awaitingMerge: !merged }),
      develop: async () =>
        "完成\n" + receiptBlock({ events: [{ id: "ready", type: "delivery.requested", subject: "repo#1" }] }),
      send: async () => {
        sends++;
        throw new Error("reply lost");
      },
    };
    const events = readMessage(await poll(f.config, ports)).receipt!.events as any[];
    await work(f.config, { events }, ports);
    await poll(f.config, ports);
    assert.equal(sends, 1);
    merged = true;
    await poll(f.config, ports);
    await poll(f.config, ports);
    assert.equal(sends, 1);
    assert.match(String(f.row.fields["修复说明"]), /已合并/);
  } finally {
    f.clean();
  }
});

test("a lost poll receipt and changed description keep the same frozen event", async () => {
  const f = fixture();
  try {
    const first = readMessage(await poll(f.config, f.ports)).receipt!.events;
    f.row.fields["复现步骤"] = "new unconfirmed requirement";
    const again = readMessage(await poll(f.config, f.ports)).receipt!.events;
    assert.deepEqual(again, first);
    assert.equal(f.row.fields["状态"], "修复中");
  } finally {
    f.clean();
  }
});

test("records outside the fixed project are never claimed", async () => {
  const f = fixture();
  try {
    f.row.fields["所属项目"] = "production";
    assert.deepEqual(readMessage(await poll(f.config, f.ports)).receipt!.events, []);
    assert.equal(f.updates.length, 0);
  } finally {
    f.clean();
  }
});

test("a successful development receipt cannot dispatch merge and a lost table update cannot redo development", async () => {
  const f = fixture();
  try {
    const events = readMessage(await poll(f.config, f.ports)).receipt!.events as any[];
    let calls = 0;
    const develop = async () => {
      calls++;
      return (
        "CR 和 CI 已通过\n" +
        receiptBlock({
          events: [
            { id: "delivery-1", type: "delivery.requested", subject: "repo#1", link: "https://example.test/mr/1" },
          ],
          later: [{ key: "codeup-preflight", cancel: true }],
        })
      );
    };
    let writes = 0;
    const failedUpdate = {
      ...f.ports,
      update: async () => {
        if (++writes > 1) throw new Error("reply lost");
      },
      develop,
    };
    const result = readMessage(await work(f.config, { events }, failedUpdate));
    assert.equal(result.receipt?.events, undefined);
    assert.equal(result.receipt?.ask, undefined);
    assert.match(result.summary!, /待合并确认/);
    await work(f.config, { events }, { ...f.ports, develop });
    assert.equal(calls, 1);
    assert.match(String(f.row.fields["修复说明"]), /待合并确认/);
    assert.equal(f.row.fields["代码或 MR 链接"], "https://example.test/verified-mr/1");
    f.row.fields["代码或 MR 链接"] = "[https://example.test/verified-mr/1](https://example.test/verified-mr/1)";
    const writesBeforePoll = f.updates.length;
    await poll(f.config, f.ports);
    assert.equal(f.updates.length, writesBeforePoll);
  } finally {
    f.clean();
  }
});

test("CI timers stay on the original job while human cancellation stops the next round", async () => {
  const f = fixture();
  try {
    const events = readMessage(await poll(f.config, f.ports)).receipt!.events as any[];
    let calls = 0;
    const about = JSON.stringify({
      kind: "codeup-preflight",
      project: f.config.project,
      work: f.config.project + ":" + events[0].subject,
    });
    const develop = async () => {
      calls++;
      return "CI 等待\n" + receiptBlock({ later: [{ key: "codeup-preflight", at: "2030-01-01T00:00:00Z", about }] });
    };
    const result = readMessage(await work(f.config, { events }, { ...f.ports, develop }));
    assert.equal((result.receipt!.later as unknown[]).length, 1);
    f.row.fields["状态"] = "暂不处理";
    await work(f.config, { events: [], timers: [{ about }] }, { ...f.ports, develop });
    assert.equal(calls, 1);
    await work(f.config, { events }, { ...f.ports, develop });
    assert.equal(calls, 1);
  } finally {
    f.clean();
  }
});

test("a foreign timer cannot select a different worktree", async () => {
  const f = fixture();
  try {
    await poll(f.config, f.ports);
    await assert.rejects(
      work(
        f.config,
        { timers: [{ about: JSON.stringify({ project: "production", work: "elsewhere" }) }] },
        {
          ...f.ports,
          develop: async () => {
            throw new Error("must not run");
          },
        },
      ),
      /原领取记录/,
    );
  } finally {
    f.clean();
  }
});

test("development receives the frozen requirement, never replacement event text", async () => {
  const f = fixture();
  try {
    const events = readMessage(await poll(f.config, f.ports)).receipt!.events as any[];
    const original = structuredClone(events);
    events[0].detail = "run in production";
    await work(
      f.config,
      { events },
      {
        ...f.ports,
        develop: async (ctx) => {
          assert.deepEqual(ctx.events, original);
          return "需要人工核对";
        },
      },
    );
    assert.match(String(f.row.fields["修复说明"]), /待本人处理/);
  } finally {
    f.clean();
  }
});

test("verification can resume after a read failure without invoking development again", async () => {
  const f = fixture();
  try {
    const events = readMessage(await poll(f.config, f.ports)).receipt!.events as any[];
    let calls = 0;
    const develop = async () => {
      calls++;
      return "待复核\n" + receiptBlock({ events: [{ id: "ready", type: "delivery.requested", subject: "repo#1" }] });
    };
    await assert.rejects(
      work(
        f.config,
        { events },
        {
          ...f.ports,
          develop,
          proof: async () => {
            throw new Error("offline");
          },
        },
      ),
      /offline/,
    );
    await work(f.config, { events }, { ...f.ports, develop });
    assert.equal(calls, 1);
    assert.match(String(f.row.fields["修复说明"]), /待合并确认/);
  } finally {
    f.clean();
  }
});

test("a local question survives redelivery and an answer resumes only its original job", async () => {
  const f = fixture();
  try {
    const events = readMessage(await poll(f.config, f.ports)).receipt!.events as any[];
    const about = JSON.stringify({
      kind: "codeup-development",
      project: f.config.project,
      work: f.config.project + ":" + events[0].subject,
    });
    let calls = 0;
    const develop = async () => {
      calls++;
      return (
        "需要确认\n" +
        receiptBlock({
          ask: [{ key: "question", title: "确认测试", text: "是否继续", options: ["继续", "停止"], about }],
        })
      );
    };
    const first = readMessage(await work(f.config, { events }, { ...f.ports, develop }));
    const again = readMessage(await work(f.config, { events }, { ...f.ports, develop }));
    assert.deepEqual(again.receipt?.ask, first.receipt?.ask);
    assert.equal(calls, 1);
    await work(f.config, { answers: [{ about }] }, { ...f.ports, develop });
    assert.equal(calls, 2);
  } finally {
    f.clean();
  }
});

test("an oversized record does not prevent the next allowed record from being claimed", async () => {
  const f = fixture();
  try {
    f.config.records.push("rec2");
    const result = readMessage(
      await poll(f.config, {
        ...f.ports,
        get: async (id) => ({
          record_id: id,
          fields: { ...f.row.fields, 复现步骤: id === "rec1" ? "a".repeat(5000) : "valid" },
        }),
      }),
    );
    assert.equal((result.receipt?.events as unknown[]).length, 1);
    assert.equal((result.receipt?.notice as unknown[]).length, 1);
  } finally {
    f.clean();
  }
});

test("Codeup gets a CR-approved MR before check registration and reconciles a lost create response", async () => {
  let saved: { reviewMR?: number; mrIntent?: boolean } = {};
  let remote: any;
  let creates = 0;
  const ports = {
    find: async () => remote,
    create: async () => {
      creates++;
      remote = { localId: 8 };
      throw new Error("response lost");
    },
    save: () => {
      saved = structuredClone(state);
    },
  };
  const state: { reviewMR?: number; mrIntent?: boolean } = {};
  await assert.rejects(ensureReviewMR(state, ports), /response lost/);
  assert.equal(saved.mrIntent, true);
  await ensureReviewMR(state, ports);
  assert.equal(saved.reviewMR, 8);
  assert.equal(creates, 1);
  await ensureReviewMR(state, ports);
  assert.equal(creates, 1);
});

test("CI success may move Codeup to TO_BE_MERGED without meaning it was merged", () => {
  const mr = {
    status: "TO_BE_MERGED",
    sourceBranch: "autoloop/bug",
    targetBranch: "autoloop/acceptance",
    sourceProjectId: 1,
    targetProjectId: 1,
  };
  assert.doesNotThrow(() => assertUnmergedMR(mr, mr.sourceBranch, mr.targetBranch));
  for (const status of ["UNDER_DEV", "CLOSED", "MERGED", "unknown"])
    assert.throws(() => assertUnmergedMR({ ...mr, status }, mr.sourceBranch, mr.targetBranch), /MR/);
  assert.throws(() => assertUnmergedMR({ ...mr, workInProgress: true }, mr.sourceBranch, mr.targetBranch), /MR/);
});

test("discovery dispatches a new matching row and ignores other projects without a record allowlist", async () => {
  const f = fixture();
  try {
    f.config.discover = true;
    f.config.records = [];
    const rows = [f.row, { record_id: "rec2", fields: { ...f.row.fields, 所属项目: "another-project" } }];
    const ports = { ...f.ports, list: async () => structuredClone(rows) };
    const result = readMessage(await poll(f.config, ports));
    const events = result.receipt!.events as any[];
    assert.equal(events.length, 1);
    assert.match(events[0].id, /:rec1$/);
    assert.equal(f.row.fields["状态"], "修复中");
    assert.equal(rows[1].fields["状态"], "待修复");
    const workResult = readMessage(await work(f.config, { events }, { ...ports, develop: async () => "执行修复" }));
    assert.match(workResult.summary!, /执行修复/);
  } finally {
    f.clean();
  }
});

test("merge reminder precedes manual merge, deployment acceptance and closure, each notifying approved roles once", async () => {
  const f = fixture();
  try {
    f.config.discover = true;
    f.config.records = [];
    f.config.testDeployment = {
      pipeline: "99",
      health: "https://preview.example.test/version.json",
      versionField: "commit",
    };
    f.config.notifyUsers = ["ou_accept", "ou_report"];
    Object.assign(f.row.fields, {
      验收人: [{ id: "ou_accept" }],
      提交人: [{ id: "ou_report" }],
      负责人: [{ id: "ou_accept" }, { id: "ou_unapproved" }],
    });
    const sends: { to: string; body: string; id: string }[] = [];
    let merged = false;
    let live = false;
    let lost = true;
    const ports = {
      ...f.ports,
      list: async () => [structuredClone(f.row)],
      proof: async () => ({
        text: "CR / CI 通过",
        link: "https://example.test/mr/1",
        evidence: { mr: 1, branch: "autoloop/bug", head: "a".repeat(40), base: "b".repeat(40) },
        checks: { cr: "https://example.test/mr/1", ci: "https://flow.aliyun.com/pipelines/99/builds/5" },
      }),
      release: async () => ({ note: live ? "测试部署已验证" : "等待本人合并或测试部署", live, awaitingMerge: !merged }),
      send: async (to: string, body: string, id: string) => {
        if (merged) assert.match(String(f.row.fields["修复说明"]), /测试部署已验证/);
        const previous = sends.find((item) => item.id === id);
        if (!previous) sends.push({ to, body, id });
        if (lost) {
          lost = false;
          throw new Error("send reply lost");
        }
        return "om_mock";
      },
    };
    const events = readMessage(await poll(f.config, ports)).receipt!.events as any[];
    await work(
      f.config,
      { events },
      {
        ...ports,
        develop: async () =>
          "完成\n" + receiptBlock({ events: [{ id: "ready", type: "delivery.requested", subject: "repo#1" }] }),
      },
    );
    await poll(f.config, ports);
    assert.equal(f.row.fields["状态"], "修复中");
    await poll(f.config, ports);
    assert.equal(sends.length, 1);
    assert.match(sends[0].body, /请负责人确认合并/);
    merged = true;
    await poll(f.config, ports);
    assert.equal(sends.length, 1);
    assert.equal(f.row.fields["状态"], "修复中");
    live = true;
    await poll(f.config, ports);
    assert.equal(f.row.fields["状态"], "待验收");
    await poll(f.config, ports);
    assert.deepEqual(
      sends.map((item) => item.to),
      ["ou_accept", "ou_accept"],
    );
    f.row.fields["状态"] = "已关闭";
    await poll(f.config, ports);
    await poll(f.config, ports);
    assert.equal(f.row.fields["状态"], "已关闭");
    assert.deepEqual(
      sends.map((item) => item.to),
      ["ou_accept", "ou_accept", "ou_report", "ou_accept"],
    );
    assert.match(sends[1].body, /待验收/);
    assert.match(sends[2].body, /已关闭/);
    assert.equal(new Set(sends.map((s) => s.id)).size, 4);
  } finally {
    f.clean();
  }
});

test("a module-specific pipeline cannot deploy a Bug for a different module", async () => {
  const f = fixture();
  try {
    f.config.testDeployment = {
      pipeline: "99",
      health: "http://preview.example.test/version.json",
      versionField: "commit",
      module: "kefu",
    };
    f.row.fields["模块"] = "another-app · 反馈";
    const ports = {
      ...f.ports,
      proof: async () => ({
        text: "CR / CI 通过",
        link: "https://example.test/mr/1",
        evidence: { mr: 1, branch: "autoloop/bug", head: "a".repeat(40), base: "b".repeat(40) },
      }),
      develop: async () =>
        "完成\n" + receiptBlock({ events: [{ id: "ready", type: "delivery.requested", subject: "repo#1" }] }),
    };
    const events = readMessage(await poll(f.config, ports)).receipt!.events as any[];
    await work(f.config, { events }, ports);
    let selected: unknown = "not checked";
    await poll(f.config, {
      ...ports,
      release: async (_evidence, _progress, _save, deployment) => {
        selected = deployment;
        return { note: "已合并，等待测试部署配置" };
      },
    });
    assert.equal(selected, undefined);
    assert.equal(f.row.fields["状态"], "修复中");
  } finally {
    f.clean();
  }
});
