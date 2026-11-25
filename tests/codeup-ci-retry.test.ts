// A registry timeout needs another real run; a result for a different checkout must never turn the MR green.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Codeup } from "../plugins/codeup/api.ts";
import { checkFlowCI } from "../plugins/codeup/flow-ci.ts";
import type { State } from "../plugins/codeup/delivery.ts";
import type { Project } from "../plugins/codeup/settings.ts";
const sha = "a".repeat(40);
const p = {
  id: "demo",
  git: "https://codeup.aliyun.com/org/demo.git",
  organization: "org",
  repository: "17",
  api: "https://example.invalid",
} as Project;
function fixture() {
  let message = "ETIMEDOUT request to https://registry.npmjs.org/dequal failed, reason: ";
  let commit = sha;
  let attempt = 0;
  let status = "FAIL";
  let lost = false;
  const markers: string[] = [];
  const checks: string[] = [];
  const state: State = { head: sha };
  const api = new Codeup(p, "token");
  api.check = async (_head, _name, conclusion) => {
    checks.push(conclusion);
  };
  api.call = async (path, body: any) => {
    if (body) {
      markers.push(JSON.parse(body.params).comment);
      attempt++;
      if (lost) {
        lost = false;
        throw Error("connection lost");
      }
      return attempt;
    }
    if (path.includes("?page=")) return [{ pipelineRunId: attempt }];
    if (path.endsWith("/log")) return { content: message };
    const id = Number(path.split("/").at(-1));
    return {
      status,
      pipelineId: 3,
      pipelineRunId: id,
      globalParams: [{ key: "BUILD_REMARK", value: markers[id - 1] }],
      sources: [
        {
          type: "codeup",
          data: { repo: p.git, branch: "topic", commit: JSON.stringify([{ commitId: commit }, { commitId: sha }]) },
        },
      ],
      stages: [{ stageInfo: { jobs: [{ id: 21, status: "FAIL" }] } }],
    };
  };
  const tick = () => checkFlowCI(api, state, () => {}, 7, "topic", sha, { pipeline: "3", env: {} });
  return {
    tick,
    state,
    checks,
    markers,
    success: () => (status = "SUCCESS"),
    wrong: () => (commit = "b".repeat(40)),
    socket: () =>
      (message =
        "ERR_SOCKET_TIMEOUT request to https://registry.npmmirror.com/a/-/a.tgz failed, reason: Socket timeout"),
    ordinary: () => (message = "WARN GET https://registry.npmjs.org/a ETIMEDOUT. Will retry\nAssertionError: failed"),
    lose: () => (lost = true),
  };
}
test("retry the timed-out download once, recover its lost start response and bind the successful checkout", async () => {
  const f = fixture();
  assert.equal(await f.tick(), false);
  f.lose();
  assert.equal(await f.tick(), false);
  f.success();
  assert.equal(await f.tick(), true);
  assert.equal(f.markers.length, 2);
  assert.deepEqual(f.checks, ["failure", "success"]);
});
test("reject a green Flow run for another actual SHA", async () => {
  const f = fixture();
  f.wrong();
  f.success();
  await assert.rejects(f.tick());
  assert.deepEqual(f.checks, []);
});
test("keep ordinary test failures in the repair loop", async () => {
  const f = fixture();
  f.ordinary();
  assert.equal(await f.tick(), true);
  assert.deepEqual(f.checks, ["failure"]);
  assert.equal(f.markers.length, 1);
});
test("the second timeout is reported without starting a third run", async () => {
  const f = fixture();
  await f.tick();
  await f.tick();
  await f.tick();
  assert.equal(f.markers.length, 2);
  assert.ok(f.checks.includes("failure"));
});

test("retry the fatal pnpm socket timeout seen on the acceptance pipeline", async () => {
  const f = fixture();
  f.socket();
  assert.equal(await f.tick(), false);
  assert.equal(f.state.ciRetryOf, "1");
});
