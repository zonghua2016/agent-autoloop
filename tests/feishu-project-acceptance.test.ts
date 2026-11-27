// Prevent unrelated Codeup work, stale cards and duplicate roles from changing a project defect.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { acceptanceWork, acceptanceAction, recipients, type Answer } from "../plugins/feishu-project/acceptance.ts";

const hash = createHash("sha256")
  .update(JSON.stringify(["space", "issue", "123"]))
  .digest("hex");
const e = {
  link: "https://project.feishu.cn/space/issue/detail/123",
  id: hash,
  subject: "fp-" + hash,
  source: "project",
  type: "demo.bug",
};
const head = "a".repeat(40),
  base = "b".repeat(40);
const work = {
  mr: 8,
  branch: "autoloop/test",
  task: { events: [e] },
  checked: head,
  pushed: head,
  gate: { head, base, reviewed: true, findings: [], ciRun: "9" },
};
test("only the approved source and a checked head can introduce a release", () => {
  const config = { space: "space", project: "demo", source: "project", fromMR: 8 };
  assert.equal(acceptanceWork(config, "work:demo:" + e.subject, work)?.issue, "123");
  assert.equal(acceptanceWork(config, "work:demo:" + e.subject, { ...work, pushed: base }), undefined);
  assert.equal(
    acceptanceWork(config, "work:demo:" + e.subject, { ...work, task: { events: [{ ...e, source: "chat" }] } }),
    undefined,
  );
});
test("only an explicit current-version answer by a current participant can change a resolved issue", () => {
  const card = { about: "current", by: "ou_me", choice: 0 };
  assert.equal(acceptanceAction("RESOLVED", "current", ["me"], "me", "ou_me", card), "CLOSED");
  assert.equal(acceptanceAction("RESOLVED", "current", ["me"], "me", "ou_me", { ...card, choice: 1 }), "REOPENED");
  for (const bad of [
    { ...card, by: "other" },
    { ...card, about: "old" },
    { ...card, choice: null },
  ])
    assert.equal(acceptanceAction("RESOLVED", "current", ["me"], "me", "ou_me", bad), undefined);
  assert.equal(acceptanceAction("CLOSED", "current", ["me"], "me", "ou_me", card), undefined);
  assert.deepEqual(
    recipients([
      { key: "reporter", members: [{ key: "me" }] },
      { key: "operator", members: [{ key: "me" }, { key: "dev" }] },
    ]),
    ["me", "dev"],
  );
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { follow } from "../plugins/feishu-project/follow.ts";
import { Store } from "../plugins/codeup/store.ts";
import { parseResult } from "../protocol/validate.ts";
import { readMessage } from "../worker/contract.ts";

for (const route of [
  "card-close",
  "card-reopen",
  "project-close",
  "retest-close",
  "retest-reopen",
  "retest-already-closed",
])
  test(route + " closes or reopens the same deployed version and returns a distinct repair event", async () => {
    const root = mkdtempSync(join(tmpdir(), "project-accept-"));
    process.env.FP_TEST_TOKEN = "test-only";
    try {
      const registry = join(root, "registry.json"),
        database = join(root, "work.db");
      writeFileSync(
        registry,
        JSON.stringify([
          {
            id: "demo",
            tokenEnv: "FP_TEST_TOKEN",
            organization: "org",
            git: "https://codeup.aliyun.com/org/demo.git",
            cwd: root,
            branch: "autoloop/acceptance",
            serviceUserId: "bot",
            developmentModel: "test",
            commands: [["true"]],
          },
        ]),
      );
      const store = new Store(database);
      store.put("work:demo:" + e.subject, work);
      store.close();
      const config = {
        space: "space",
        source: "project",
        project: "demo",
        fromMR: 8,
        retestDirectory: root,
        database,
        registry,
        userKey: "me",
        ownerOpenId: "ou_me",
        deployment: {
          pipeline: "2",
          page: "https://test.example/page",
          health: "https://test.example/version",
          versionField: "commit",
        },
      };
      let status = "OPEN",
        live = false;
      let answers: Answer[] = [];
      let open: { title: string; card: number }[] = [];
      const notified: string[][] = [];
      const transitions: string[] = [];
      const ports: NonNullable<Parameters<typeof follow>[2]> = {
        context: () => ({ events: [{ subject: "demo#8" }], answers, open }),
        checks: async () =>
          ["autoloop-cr", "autoloop-ci"].map((name) => ({
            head,
            name,
            status: "completed",
            conclusion: "success",
            writer: "bot",
            detail: "",
          })),
        release: async (_p, config, _e, progress, save) => {
          progress.run = "1";
          progress.intent = { config: config!, sha: head };
          save();
          return live ? { live: true, page: config!.page, note: "已部署" } : { note: "部署中" };
        },
        client: async (r, m, p) => {
          if (r === "user") return { user_key: "me" };
          if (m === "get")
            return {
              work_item_attribute: {
                work_item_id: "123",
                owned_project: { simple_name: "space" },
                work_item_type: { key: "issue" },
                work_item_status: { key: status },
                update_time: new Date(0).toISOString(),
                role_members: [
                  { key: "reporter", members: [{ key: "other" }, { key: "me" }] },
                  { key: "operator", members: [{ key: "me" }] },
                ],
              },
              work_item_fields: [
                { key: "description", value: "点击帮助链接" },
                { key: "bug_classification", value: { label: "前端" } },
              ],
            };
          if (m === "list-state-transitions")
            return {
              state_key: status,
              transition: ["RESOLVED", "CLOSED", "REOPENED"].map((s) => ({ state_key: s, id: s })),
            };
          if (m === "transition-state") {
            status = String(p.transition_id);
            transitions.push(status);
            return {};
          }
          if (m === "list") return { comments: [], pagination: { total_pages: 0 } };
          if (m === "add") {
            notified.push((p.notify_user_list ?? []) as string[]);
            return { comment_id: "1" };
          }
          throw Error("unexpected " + m);
        },
      };
      const tick = async () => {
        const m = readMessage(await follow(config, "track", ports));
        assert.equal(m.problem, undefined);
        return parseResult({ outcome: m.outcome, ...m.receipt });
      };
      assert.equal((await tick()).ask, undefined);
      assert.equal(status, "OPEN");
      live = true;
      const ask = (await tick()).ask![0];
      assert.equal(status, "RESOLVED");
      assert.ok(ask.text.includes(e.link));
      open = [{ title: ask.title, card: 1 }];
      assert.deepEqual((await tick()).ask, []);
      assert.deepEqual(notified.flat(), ["other"]);
      if (route === "project-close") status = "CLOSED";
      else answers = [{ by: "ou_me", choice: route === "card-reopen" ? 1 : 0, about: ask.about }];
      await tick();
      assert.equal(status, route === "card-reopen" ? "REOPENED" : "CLOSED");
      answers = [];
      if (status === "CLOSED") assert.ok((await tick()).resolve?.length);
      status = "REOPENED";
      const actual = await tick();
      assert.equal(actual.events![0].subject, "fp-" + hash + "-r8");
      assert.equal(actual.events![0].link, e.link);
      const evidence = JSON.parse(actual.events![0].detail!);
      assert.equal(evidence.testPage, config.deployment.page);
      assert.equal(evidence.testedCommit, head);
      const persisted = new Store(database);
      assert.deepEqual(persisted.get("verification:demo:" + actual.events![0].subject, null), {
        testPage: config.deployment.page,
        testedCommit: head,
        issueLink: e.link,
        repairId: actual.events![0].id,
      });
      if (route === "project-close") {
        const key = "verification:demo:" + actual.events![0].subject;
        persisted.db.prepare("DELETE FROM codeup_items WHERE key=?").run(key);
        const stateKey = "feishu-project-acceptance:space:123:8";
        const legacy = persisted.get<any>(stateKey, {});
        legacy.repairEvent.detail = JSON.stringify({ previousMR: "old MR" });
        persisted.put(stateKey, legacy);
        await follow(config, "discover", ports);
        assert.equal(persisted.get<any>(key, {}).testedCommit, head);
        assert.deepEqual(persisted.get<any>(stateKey, {}).repairEvent, legacy.repairEvent);
        persisted.put(stateKey, { ...legacy, repairEvent: actual.events![0] });
      }
      persisted.close();
      assert.equal(actual.later![0].cancel, true);
      assert.deepEqual((await tick()).events, actual.events);
      if (route.startsWith("retest-")) {
        const report = {
          issue: "123",
          mr: 8,
          page: config.deployment.page,
          sha: head,
          repairId: actual.events![0].id,
          testedAt: new Date().toISOString(),
          fixture: "仅替换测试公告",
          results: [{ scenario: "点击帮助", expected: "https://example.org/(PC)", actual: "https://example.org/(PC)" }],
        };
        const directory = join(root, "feishu-123-mr8");
        mkdirSync(directory);
        const file = join(directory, "results.json");
        const discovery = async () =>
          readMessage(await follow(config, "discover", ports)).receipt?.events as { id: string }[];
        writeFileSync(file, JSON.stringify({ ...report, repairId: "previous-repair" }));
        assert.equal((await discovery()).length, 1, "a late report from another repair cannot start this round");
        writeFileSync(file, JSON.stringify({ ...report, sha: base }));
        assert.equal((await discovery()).length, 1);
        writeFileSync(
          file,
          JSON.stringify({ ...report, results: [{ scenario: "点击帮助", expected: "right", actual: "wrong" }] }),
        );
        assert.equal((await discovery()).length, 1);
        writeFileSync(file, JSON.stringify({ ...report, testedAt: new Date(0).toISOString() }));
        assert.equal((await discovery()).length, 1);
        writeFileSync(file, JSON.stringify(report));
        assert.equal((await discovery()).length, 2);
        open = [
          { title: ask.title, card: 1 },
          { title: "请验收缺陷 124（MR #9）", card: 2 },
        ];
        if (route === "retest-already-closed") status = "CLOSED";
        const resumed = await tick();
        assert.equal(resumed.events, undefined);
        assert.equal((await discovery()).length, 1, "a consumed report does not wake another round");
        if (route === "retest-already-closed") {
          assert.equal(resumed.ask, undefined);
          assert.equal((await tick()).ask, undefined);
          assert.equal(status, "CLOSED");
          return;
        }
        assert.equal(status, "RESOLVED");
        assert.deepEqual(
          resumed.resolve?.map((r) => r.card),
          [1],
        );
        const retest = resumed.ask![0];
        assert.notEqual(retest.about, ask.about);
        assert.match(retest.text, /仅替换测试公告/);
        assert.ok(retest.text.includes(config.deployment.page));
        open = [
          { title: retest.title, card: 12 },
          { title: "请确认第 1 次网页复验（缺陷 124，MR #9）", card: 13 },
        ];
        answers = [{ about: ask.about, choice: 1, by: "ou_me" }];
        assert.deepEqual((await tick()).ask, []);
        assert.equal(status, "RESOLVED");
        answers = [];
        status = route === "retest-close" ? "CLOSED" : "REOPENED";
        const settled = await tick();
        assert.deepEqual(
          settled.resolve?.map((r) => r.card),
          [12],
        );
        open = [];
        const repeated = await tick();
        assert.equal(repeated.ask, undefined);
        if (status === "CLOSED") {
          assert.equal(settled.events, undefined);
          assert.equal(repeated.events, undefined);
        } else {
          assert.notEqual(settled.events?.[0].id, actual.events![0].id);
          assert.deepEqual(repeated.events, settled.events);
          assert.equal(
            acceptanceWork(config, "work:demo:" + settled.events![0].subject, {
              ...work,
              task: { events: [{ ...settled.events![0], source: "project" }] },
            })?.issue,
            "123",
          );
        }
        return;
      }
      assert.deepEqual(
        transitions,
        route === "project-close" ? ["RESOLVED"] : ["RESOLVED", route === "card-reopen" ? "REOPENED" : "CLOSED"],
      );
    } finally {
      delete process.env.FP_TEST_TOKEN;
      rmSync(root, { recursive: true, force: true });
    }
  });

test("a partial resolution form retains the user's selection and encodes a missing multiselect in the MCP wire format", async () => {
  const { projectIssue } = await import("../plugins/feishu-project/workflow.ts");
  let fields: unknown;
  const issue = projectIssue(
    async (_r, m, p) => {
      if (m === "get")
        return {
          work_item_attribute: { work_item_id: "123" },
          work_item_fields: [{ key: "field_result", value: { value: "fixed" } }],
        };
      if (m === "update") {
        fields = p.fields;
        return { mcp_result: "" };
      }
      throw Error(m);
    },
    "space",
    "123",
  );
  await issue.fillResolution({ field_result: "default", field_class: ["logic"] });
  assert.deepEqual(fields, [{ field_key: "field_class", field_value: '[{"option_id":"logic"}]' }]);
});
