// An unrelated check, stale checkout, or generic no-op must never become a successful delivery or a user pause.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergedResult, pausedAnswer } from "../plugins/codeup/task-result.ts";

const head = "a".repeat(40);
const project = { git: "https://codeup.aliyun.com/org/test.git", serviceUserId: "self", branch: "acceptance" };
const work = { mr: 1, branch: "topic" };
const state = { merged: head, head, ciRun: "2", ciPipeline: "123" };
const mr = {
  localId: 1,
  status: "MERGED",
  sourceProjectId: 5,
  targetProjectId: 5,
  targetBranch: project.branch,
  sourceBranch: work.branch,
  mergedRevision: head,
};
const run = {
  status: "SUCCESS",
  pipelineId: 123,
  pipelineRunId: 2,
  sources: [
    { type: "codeup", data: { repo: project.git, branch: work.branch, commit: JSON.stringify([{ commitId: head }]) } },
  ],
};
const checks = ["autoloop-ci", "autoloop-cr"].map((name) => ({
  name,
  id: 1,
  writer: { id: "self" },
  headSha: head,
  status: "completed",
  conclusion: "success",
}));
test("merged results bind both checks and the Flow checkout to the exact submission", () => {
  assert.match(mergedResult(project, work, state, mr, checks, run).text, /CI 通过[\s\S]*CR 通过/);
  assert.doesNotMatch(
    mergedResult(project, work, state, mr, [checks[0], { ...checks[1], writer: { id: "other" } }], run).text,
    /CR 通过/,
  );
  assert.doesNotMatch(mergedResult(project, work, state, mr, checks, { ...run, pipelineRunId: 3 }).text, /CI 通过/);
});
test("a verified merge completes delivery polling while unverified evidence remains refreshable", () => {
  assert.equal(mergedResult(project, work, state, mr, checks, run).stage, "complete");
  assert.notEqual(mergedResult(project, work, state, mr, [], run).stage, "complete");
});
test("pause requires an explicit stop answer on the no-change run", () => {
  assert.equal(pausedAnswer("nothing", "先不动了"), true);
  assert.equal(pausedAnswer("running", "先不动了"), false);
  assert.equal(pausedAnswer("nothing", "不要暂停"), false);
});

test("delivery reads authorized hub APIs without opening hub.db", async () => {
  const { mkdtempSync, writeFileSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const { codeupTaskResults } = await import("../plugins/codeup/task-result.ts");
  const home = mkdtempSync(join(tmpdir(), "task-results-"));
  const project = JSON.parse(
    readFileSync(new URL("../examples/recipes/codeup/projects.json", import.meta.url), "utf8"),
  )[0];
  writeFileSync(join(home, "projects.json"), JSON.stringify([project]));
  writeFileSync(join(home, "config.json"), JSON.stringify({ owner: "owner-key" }));
  writeFileSync(join(home, "hub.db"), "not a sqlite database");
  const db = new DatabaseSync(join(home, "codeup.db"));
  db.exec("CREATE TABLE codeup_items(key TEXT PRIMARY KEY,data TEXT)");
  db.prepare("INSERT INTO codeup_items VALUES (?,?)").run(
    "work:react-app:feishu-om_one",
    JSON.stringify({ branch: "autoloop/task" }),
  );
  db.close();
  const calls: string[] = [];
  let answerEvent = 9;
  let latestAnswer = false;
  const hub = createServer((req, res) => {
    calls.push(req.url!);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/events/5") {
      assert.equal(req.headers.authorization, "Bearer source-key");
      res.end(JSON.stringify({ event: 5, runs: [{ run: 42, state: "nothing" }] }));
    } else if (req.url === "/v1/runs/42/why") {
      assert.equal(req.headers.authorization, "Bearer owner-key");
      res.end(
        JSON.stringify([
          {
            changes: [
              { table: "runs", key: "42", row: { id: 42, lane: "feishu-om_one", state: "nothing" } },
              { table: "run_events", key: "42:9", row: { run_id: 42, event_id: 9 } },
              {
                table: "cards",
                key: "8",
                row: {
                  id: 8,
                  answer_event: answerEvent,
                  kind: "ask",
                  state: "done",
                  lane: "feishu-om_one",
                  by: "owner",
                  choice: null,
                  answer: "先暂停",
                  about: JSON.stringify({
                    kind: "codeup-development",
                    project: "react-app",
                    work: "react-app:feishu-om_one",
                  }),
                },
              },
              ...(latestAnswer
                ? [
                    { table: "run_events", key: "42:10", row: { run_id: 42, event_id: 10 } },
                    {
                      table: "cards",
                      key: "9",
                      row: {
                        id: 9,
                        answer_event: 10,
                        kind: "ask",
                        state: "done",
                        lane: "feishu-om_one",
                        by: "owner",
                        choice: null,
                        answer: "已处理，继续",
                        about: JSON.stringify({
                          kind: "codeup-development",
                          project: "react-app",
                          work: "react-app:feishu-om_one",
                        }),
                      },
                    },
                  ]
                : []),
            ],
          },
        ]),
      );
    } else {
      assert.equal(req.url, "/v1/state");
      assert.equal(req.headers.authorization, "Bearer owner-key");
      res.end(
        JSON.stringify({
          runs: [{ id: 42, state: "nothing", events: [{ subject: "feishu-om_one" }] }],
          cards: [],
          recentCards: [
            {
              kind: "ask",
              state: "done",
              lane: "feishu-om_one",
              by: "owner",
              choice: null,
              answer: "先暂停",
              about: JSON.stringify({
                kind: "codeup-development",
                project: "react-app",
                work: "react-app:feishu-om_one",
              }),
            },
          ],
        }),
      );
    }
  }).listen(0, "127.0.0.1");
  await once(hub, "listening");
  try {
    const delivery = codeupTaskResults(
      { registry: join(home, "projects.json"), envFile: join(home, "env"), source: "tasks" },
      home,
      () => {},
      { url: `http://127.0.0.1:${(hub.address() as any).port}`, sourceKey: "source-key" },
    );
    const result = await delivery({ project: "react-app", message: "om_one", event: 5, sender: "owner" } as any);
    assert.equal(result?.title, "已暂停");
    assert.deepEqual(calls.sort(), ["/v1/events/5", "/v1/runs/42/why", "/v1/state"]);
    latestAnswer = true;
    assert.equal(
      (await delivery({ project: "react-app", message: "om_one", event: 5, sender: "owner" } as any))?.title,
      "未产生改动",
    );
    latestAnswer = false;
    answerEvent = 4;
    assert.equal(
      (await delivery({ project: "react-app", message: "om_one", event: 5, sender: "owner" } as any))?.title,
      "未产生改动",
    );
  } finally {
    hub.closeAllConnections();
    await new Promise<void>((resolve) => hub.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
