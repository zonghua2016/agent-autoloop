// Prevent starting an unapproved or wrong-commit deployment, and reporting a stale preview version as released.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project } from "../plugins/codeup/settings.ts";
import { followRelease, testDeploymentUrls, type ReleaseProgress } from "../plugins/feishu-bugs/release.ts";

const project = {
  id: "test-project",
  organization: "test-org",
  repository: "1234",
  branch: "autoloop/acceptance",
  api: "https://openapi-rdc.aliyuncs.com",
  git: "https://codeup.aliyun.com/test-org/test-project.git",
  tokenEnv: "TEST_BUG_RELEASE_TOKEN",
} as Project;
const target = {
  pipeline: "99",
  health: "http://preview.example.test/{commit}/version.json",
  page: "http://preview.example.test/{commit}/index.html",
  versionField: "commit",
};
const evidence = { mr: 8, head: "a".repeat(40), base: "b".repeat(40), branch: "autoloop/bug" };
const merged = "c".repeat(40);

function fixture() {
  process.env[project.tokenEnv] = "mock-token";
  const progress: ReleaseProgress = {};
  let starts = 0;
  let recorded: ReleaseProgress = {};
  const data = {
    status: "TO_BE_MERGED",
    parent: evidence.head,
    runningHead: merged,
    deployed: evidence.base,
    lost: false,
    pageReady: false,
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.href === target.health.replace("{commit}", merged)) {
      assert.equal(new Headers(init?.headers).has("x-yunxiao-token"), false);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      return Response.json({ commit: data.deployed });
    }
    if (url.href === target.page.replace("{commit}", merged)) {
      assert.equal(init?.method, "HEAD");
      assert.equal(init?.credentials, "omit");
      return new Response(null, { status: data.pageReady ? 200 : 404, headers: { "content-type": "text/html" } });
    }
    if (url.pathname.endsWith("/changeRequests/8")) {
      return Response.json({
        localId: 8,
        status: data.status,
        mergedRevision: merged,
        sourceBranch: evidence.branch,
        targetBranch: project.branch,
        sourceProjectId: 1234,
        targetProjectId: 1234,
      });
    }
    if (url.pathname.endsWith(`/commits/${merged}`))
      return Response.json({ id: merged, parentIds: [evidence.base, data.parent] });
    if (url.pathname.endsWith("/pipelines/99/runs") && init?.method === "POST") {
      starts++;
      assert.equal(recorded.intent?.sha, merged);
      assert.deepEqual(JSON.parse(JSON.parse(String(init.body)).params).envs, {
        AUTOLOOP_EXPECTED_SHA: merged,
        AUTOLOOP_TARGET_ENV: "test",
      });
      if (data.lost) throw new Error("response lost");
      return Response.json(15);
    }
    if (url.pathname.endsWith("/pipelines/99/runs/15")) {
      return Response.json({
        pipelineId: 99,
        pipelineRunId: 15,
        status: "SUCCESS",
        sources: [
          {
            type: "codeup",
            data: {
              repo: project.git,
              branch: project.branch,
              commit: JSON.stringify([{ commitId: data.runningHead }]),
            },
          },
        ],
      });
    }
    throw new Error("unexpected request");
  };
  return {
    data,
    starts: () => starts,
    run: (config: typeof target | null = target) =>
      followRelease(
        project,
        config ?? undefined,
        evidence,
        progress,
        () => {
          recorded = structuredClone(progress);
        },
        request,
        () => merged,
      ),
  };
}

test("manual merge of the reviewed commit gates deployment and both the Flow run and live version must match", async () => {
  const f = fixture();
  assert.match((await f.run()).note, /待本人确认/);
  assert.equal(f.starts(), 0);
  f.data.status = "MERGED";
  f.data.parent = "d".repeat(40);
  await assert.rejects(f.run(), /合并提交与已核实/);
  assert.equal(f.starts(), 0);
  f.data.parent = evidence.head;
  assert.match((await f.run()).note, /已启动/);
  f.data.runningHead = evidence.base;
  await assert.rejects(f.run(), /实际检出/);
  f.data.runningHead = merged;
  assert.match((await f.run()).note, /等待测试环境版本/);
  f.data.deployed = merged;
  assert.match((await f.run()).note, /等待验收页面可用/);
  f.data.pageReady = true;
  assert.equal((await f.run()).live, true);
  assert.equal(f.starts(), 1);
});

test("test preview links use the same HTTP origin and cannot embed credentials", () => {
  assert.equal(testDeploymentUrls(target, merged).health, target.health.replace("{commit}", merged));
  assert.throws(() => testDeploymentUrls({ ...target, page: "http://elsewhere.example.test/" }), /同源/);
  assert.throws(() => testDeploymentUrls({ ...target, health: "http://user:pass@preview.example.test/" }), /预览地址/);
});

test("an already merged MR is reported before any deployment is configured", async () => {
  const f = fixture();
  f.data.status = "MERGED";
  assert.match((await f.run(null)).note, /已合并.*等待测试部署配置/);
  assert.equal(f.starts(), 0);
});

test("an unknown deployment startup response cannot issue a second Flow run", async () => {
  const f = fixture();
  f.data.status = "MERGED";
  f.data.lost = true;
  await assert.rejects(f.run(), /response lost/);
  await assert.rejects(f.run(), /启动结果未知/);
  assert.equal(f.starts(), 1);
});
