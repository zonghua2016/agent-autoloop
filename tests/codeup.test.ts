// Prevent cross-repository dispatch, stale approvals, repeated side effects and shipping unverified commits.
import assert from "node:assert/strict";
import { test } from "node:test";
import source from "../plugins/codeup/source.ts";
import { deliver, type DeliveryIO, type State } from "../plugins/codeup/delivery.ts";
import { projectSettings } from "../plugins/codeup/settings.ts";
import { ApiError } from "../plugins/codeup/api.ts";

const sha = "a".repeat(40),
  base = "b".repeat(40);
const settings = () =>
  projectSettings({
    checks: [{ name: "autoloop-ci", writers: ["trusted-ci"] }],
    sensitive: ["src/auth/**", "**/*.sql"],
    review: { model: "gpt-6-astra", effort: "high", points: "只报告真实错误" },
    autoMerge: true,
    protectedBranchVerified: true,
    deploy: {
      pipeline: "123",
      env: { PROJECT: "demo" },
      health: { url: "https://example.com/version.json", field: "commit" },
    },
  });
function fixture() {
  let state: State = {};
  let current = {
    id: 1,
    head: sha,
    base,
    branch: "autoloop/demo",
    target: "main",
    status: "UNDER_REVIEW",
    requirements: true,
    conflict: false,
    title: "demo",
    description: "",
    merged: "",
  };
  const calls: string[] = [];
  const io: DeliveryIO = {
    project: "demo",
    mr: async () => ({ ...current }),
    settings: async () => settings(),
    diff: async () => ({ text: "diff", files: ["src/page.tsx"] }),
    review: async () => [],
    checks: async () => [
      { name: "autoloop-ci", head: sha, status: "completed", conclusion: "success", writer: "trusted-ci" },
    ],
    check: async () => {
      calls.push("check");
    },
    merge: async () => {
      calls.push("merge");
      current = { ...current, status: "MERGED", merged: sha };
    },
    deploy: async () => {
      calls.push("deploy");
      return "7";
    },
    deployment: async () => "SUCCESS",
    live: async () => sha,
    save: (s) => {
      state = structuredClone(s);
    },
    now: () => new Date("2026-11-18T00:00:00Z"),
  };
  return {
    io,
    calls,
    get state() {
      return state;
    },
    get current() {
      return current;
    },
    set current(v) {
      current = v;
    },
  };
}

test("Codeup webhook authenticates and normalizes new-version merge requests", () => {
  const body = JSON.stringify({
    object_attributes: {
      local_id: 12,
      action: "update",
      source_branch: "feat/x",
      target_branch: "main",
      last_commit: { id: sha },
      target: { http_url: "https://codeup.aliyun.com/org/team/app.git" },
    },
  });
  assert.throws(() => source({ headers: {}, body, secret: "key" }));
  const events = source({
    headers: { "x-codeup-token": "key", "codeup-event": "Merge Request Hook" },
    body,
    secret: "key",
  });
  assert.equal(events[0].subject, "org/team/app#12");
  assert.equal(events[0].type, "merge_request.update");
  assert.deepEqual(
    events,
    source({ headers: { "x-codeup-token": "key", "codeup-event": "Merge Request Hook" }, body, secret: "key" }),
  );
});

test("long webhook branch data stays parseable and explicitly marks truncation", () => {
  const event = source({
    headers: { "x-codeup-token": "key", "codeup-event": "Merge Request Hook" },
    secret: "key",
    body: JSON.stringify({
      project: { path_with_namespace: "org/demo" },
      object_attributes: {
        local_id: 1,
        source_branch: 'branch"\\😀'.repeat(800),
        target_branch: "main",
      },
    }),
  })[0];
  assert.ok(event.detail.length <= 4000 && event.detail.isWellFormed());
  assert.equal(JSON.parse(event.detail).truncated, true);
  assert.equal(JSON.parse(event.detail).target, "main");
});

test("React and NestJS use the same delivery stages, resume deployment without merging twice", async () => {
  const f = fixture();
  const first = await deliver(f.io, f.state, []);
  assert.equal(first.phase, "shipping");
  const second = await deliver(f.io, f.state, []);
  assert.equal(second.phase, "live");
  await deliver(f.io, f.state, []);
  assert.equal(f.calls.filter((x) => x === "merge").length, 1);
  assert.equal(f.calls.filter((x) => x === "deploy").length, 1);
});

test("a failed review wakes repair once for this head and never merges it", async () => {
  const f = fixture();
  f.io.review = async () => [{ title: "src/a.ts:1", text: "会崩溃" }];
  const one = await deliver(f.io, f.state, []);
  assert.equal(one.phase, "repair");
  assert.equal(one.repair?.head, sha);
  const two = await deliver(f.io, f.state, []);
  assert.equal(two.phase, "blocked");
  assert.equal(two.repair, undefined);
  assert.ok(!f.calls.includes("merge"));
});

test("missing, skipped, forged or wrong-head CI never passes", async () => {
  for (const checks of [
    [],
    [{ name: "autoloop-ci", head: base, status: "completed", conclusion: "success", writer: "trusted-ci" }],
    [{ name: "autoloop-ci", head: sha, status: "completed", conclusion: "skipped", writer: "trusted-ci" }],
    [{ name: "autoloop-ci", head: sha, status: "completed", conclusion: "success", writer: "attacker" }],
  ]) {
    const f = fixture();
    f.io.checks = async () => checks;
    const result = await deliver(f.io, f.state, []);
    assert.notEqual(result.phase, "shipping");
    assert.ok(!f.calls.includes("merge"));
  }
});

test("sensitive approval is bound to the exact head and base and a new commit invalidates it", async () => {
  const f = fixture();
  f.io.diff = async () => ({ text: "diff", files: ["src/auth/token.ts"] });
  const result = await deliver(f.io, f.state, []);
  assert.equal(result.phase, "approval");
  const wrong = [
    { choice: 0, about: JSON.stringify({ kind: "codeup-merge", project: "demo", mr: 1, head: base, base }) },
  ];
  assert.equal((await deliver(f.io, f.state, wrong)).phase, "approval");
  const right = [
    { choice: 0, about: JSON.stringify({ kind: "codeup-merge", project: "demo", mr: 1, head: sha, base }) },
  ];
  assert.equal((await deliver(f.io, f.state, right)).phase, "shipping");
});

test("target or head change after checks cannot be merged", async () => {
  const f = fixture();
  let reads = 0;
  f.io.mr = async () => ({ ...f.current, head: ++reads > 1 ? "c".repeat(40) : sha });
  assert.equal((await deliver(f.io, f.state, [])).phase, "changed");
  assert.ok(!f.calls.includes("merge"));
});

test("an uncertain deploy response is not retried and a failed ship cannot be covered by HTTP success", async () => {
  const f = fixture();
  f.io.deploy = async () => {
    f.calls.push("deploy");
    throw new Error("lost response");
  };
  await assert.rejects(deliver(f.io, f.state, []));
  assert.equal((await deliver(f.io, f.state, [])).phase, "attention");
  assert.equal(f.calls.filter((x) => x === "deploy").length, 1);
  const g = fixture();
  await deliver(g.io, g.state, []);
  g.io.deployment = async () => "FAIL";
  assert.equal((await deliver(g.io, g.state, [])).phase, "attention");
});

test("drafts and unverified server protection do not merge", async () => {
  const f = fixture();
  f.current = { ...f.current, status: "UNDER_DEV" };
  assert.equal((await deliver(f.io, f.state, [])).phase, "blocked");
  const g = fixture();
  g.io.settings = async () => ({ ...settings(), protectedBranchVerified: false });
  assert.equal((await deliver(g.io, g.state, [])).phase, "approval");
  assert.ok(!g.calls.includes("merge"));
});

test("a cancelled merge stays cancelled for this commit and target", async () => {
  const f = fixture();
  f.io.diff = async () => ({ text: "diff", files: ["src/auth/token.ts"] });
  const ask = await deliver(f.io, f.state, []);
  assert.equal((await deliver(f.io, f.state, [{ choice: 1, about: ask.ask!.about }])).phase, "blocked");
  assert.equal((await deliver(f.io, f.state, [])).phase, "blocked");
  assert.ok(!f.calls.includes("merge"));
});

test("a definitively rejected publish request can resume after correcting permissions", async () => {
  const f = fixture();
  f.io.deploy = async () => {
    throw new ApiError(403);
  };
  await assert.rejects(deliver(f.io, f.state, []));
  assert.equal(f.state.deployIntent, false);
  f.io.deploy = async () => "8";
  assert.equal((await deliver(f.io, f.state, [])).phase, "shipping");
});

test("long repository subjects stay within the protocol and retain the MR identity", async () => {
  const { repositorySubject } = await import("../plugins/codeup/subject.ts");
  const { numberFor } = await import("../plugins/codeup/runtime.ts");
  const repo = "org/" + "long-segment/".repeat(12) + "app";
  const subject = repositorySubject(repo, 123);
  assert.ok(subject.length <= 100);
  assert.equal(
    numberFor({ id: "app", git: "https://codeup.aliyun.com/" + repo + ".git" } as any, { events: [{ subject }] }),
    123,
  );
});
