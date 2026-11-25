// Exercise the documented API wire contract and actual Git/CI processes without sending code or deploying remotely.
import { verifyProject } from "../plugins/codeup/verify.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Codeup } from "../plugins/codeup/api.ts";
import { git, snapshot } from "../plugins/codeup/git.ts";
import { project, projectSettings, type Project } from "../plugins/codeup/settings.ts";
import { runCI } from "../plugins/codeup/ci.ts";
import { deliver, type State } from "../plugins/codeup/delivery.ts";
import { numberFor } from "../plugins/codeup/runtime.ts";
import { failureLogs } from "../plugins/codeup/diagnostics.ts";

const head = "a".repeat(40);
const p = (): Project =>
  project({
    id: "demo",
    organization: "org",
    repository: "123",
    git: "https://codeup.aliyun.com/org/team/demo.git",
    cwd: resolve(tmpdir(), "demo"),
    workRoot: resolve(tmpdir(), "demo-work"),
    branch: "main",
    tokenEnv: "YUNXIAO_TOKEN",
    serviceUserId: "bot",
    api: "https://openapi-rdc.aliyuncs.com",
    settingsPath: "ops/codeup-delivery.json",
    codex: "codex",
    developmentModel: "gpt-6-astra",
    commands: [["npm", "test"]],
  });

test("webhook subjects, question answers and follow-up timers recover only the registered project MR", () => {
  assert.equal(numberFor(p(), { events: [{ subject: "org/team/demo#7" }] }), 7);
  assert.equal(
    numberFor(p(), { events: [{ subject: "" }], answers: [{ about: JSON.stringify({ project: "demo", mr: 7 }) }] }),
    7,
  );
  assert.equal(numberFor(p(), { timers: [{ about: JSON.stringify({ project: "demo", mr: 7 }) }] }), 7);
  assert.throws(() => numberFor(p(), { answers: [{ about: JSON.stringify({ project: "other", mr: 7 }) }] }));
});

test("API authenticates, encodes repository paths and updates only the bot's own check", async () => {
  const rows: { url: string; init: RequestInit }[] = [];
  const config = { ...p(), repository: "org/team/demo" };
  const request = (async (url, init) => {
    rows.push({ url: String(url), init: init! });
    return Response.json(
      rows.length === 1
        ? [{ id: 9, name: "autoloop-cr", externalId: `autoloop-autoloop-cr-${head}`, writer: { id: "bot" } }]
        : { id: 9 },
    );
  }) as typeof fetch;
  await new Codeup(config, "not-a-real-token", request).check(head, "autoloop-cr", "success", "通过");
  assert.ok(rows[0].url.includes("repositories/org%2Fteam%2Fdemo/checkRuns"));
  assert.equal(rows[0].init.redirect, "error");
  assert.equal((rows[0].init.headers as any)["x-yunxiao-token"], "not-a-real-token");
  assert.ok(rows[1].url.endsWith("/checkRuns/9"));
  assert.equal(JSON.parse(String(rows[1].init.body)).headSha, head);
});

test("CI failure diagnostics include the failed job and redact credentials before repair", async () => {
  let called = "";
  const api = new Codeup(p(), "private-token", (async (url) => {
    called = String(url);
    return Response.json({ content: "src/a.ts:4 Type error\ntoken=private-token\npassword=hidden" });
  }) as typeof fetch);
  const text = await failureLogs(api, "123", "7", {
    stages: [{ stageInfo: { jobs: [{ id: "job-1", name: "typecheck", status: "FAIL" }] } }],
  });
  assert.ok(called.endsWith("/pipelines/123/runs/7/job/job-1/log"));
  assert.match(text, /Type error/);
  assert.match(text, /typecheck/);
  assert.ok(!text.includes("private-token"));
  assert.ok(!text.includes("password=hidden"));
});

test("review settings come from target, never from the feature branch; diff includes only branch work", () => {
  const root = mkdtempSync(join(tmpdir(), "codeup-git-test-"));
  try {
    git(root, "init", "-b", "main");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "user.name", "Test");
    mkdirSync(join(root, "ops"));
    const settings = {
      checks: [{ name: "ci", writers: ["bot"] }],
      sensitive: [],
      review: { model: "gpt-6-astra", effort: "high", points: "可信规则" },
      autoMerge: false,
      protectedBranchVerified: false,
    };
    writeFileSync(join(root, "ops/codeup-delivery.json"), JSON.stringify(settings));
    git(root, "add", ".");
    git(root, "commit", "-m", "base");
    git(root, "checkout", "-b", "feature");
    writeFileSync(
      join(root, "ops/codeup-delivery.json"),
      JSON.stringify({ ...settings, review: { ...settings.review, points: "恶意放行" } }),
    );
    writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "feature");
    const value = snapshot({ ...p(), cwd: root, git: root }, join(root, "review.git"), "feature");
    assert.equal(value.settings.review.points, "可信规则");
    assert.ok(value.files.includes("index.ts"));
    assert.equal(readFileSync(join(root, "index.ts"), "utf8"), "export const value = 1;\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const kind of ["react", "nestjs"] as const)
  test(`${kind} checks execute real commands and reject a mismatched commit`, () => {
    const root = mkdtempSync(join(tmpdir(), `codeup-${kind}-`));
    try {
      git(root, "init", "-b", "main");
      git(root, "config", "user.email", "test@example.invalid");
      git(root, "config", "user.name", "Test");
      writeFileSync(join(root, "app.js"), "export const value = 1;\n");
      git(root, "add", ".");
      git(root, "commit", "-m", "app");
      const sha = git(root, "rev-parse", "HEAD");
      const profile = {
        kind,
        commands: [[process.execPath, "--input-type=module", "-e", "import('./app.js')"]],
        versionFiles: ["dist/version.json"],
      };
      assert.throws(() => runCI(profile, root, head), /不一致/);
      assert.equal(runCI(profile, root, sha).passed, true);
      assert.equal(JSON.parse(readFileSync(join(root, "dist/version.json"), "utf8")).commit, sha);
      writeFileSync(join(root, "app.js"), "export const = ;");
      assert.throws(() => runCI(profile, root, sha));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("review repair, CI repair, human approval, merge and Flow release complete for both project profiles", async () => {
  for (const kind of ["react", "nestjs"]) {
    let state: State = {},
      commit = head,
      count = 0,
      failCI = true,
      merged = false;
    const settings = projectSettings({
      checks: [{ name: "ci", writers: ["bot"] }],
      sensitive: ["src/**"],
      review: { model: "gpt-6-astra", effort: "high", points: kind },
      autoMerge: true,
      protectedBranchVerified: true,
      deploy: { pipeline: "123", env: {}, health: { url: "https://example.com/version", field: "commit" } },
    });
    const io = {
      project: "demo",
      mr: async () => ({
        id: 1,
        head: commit,
        base: "b".repeat(40),
        branch: "autoloop/demo",
        target: "main",
        status: merged ? "MERGED" : "UNDER_REVIEW",
        requirements: true,
        conflict: false,
        title: "demo",
        description: "",
        merged: merged ? commit : "",
      }),
      settings: async () => settings,
      diff: async () => ({ text: "diff", files: ["src/index.ts"] }),
      review: async () => (++count === 1 ? [{ title: "src/index.ts:1", text: "bug" }] : []),
      checks: async () => [
        { name: "ci", head: commit, writer: "bot", status: "completed", conclusion: failCI ? "failure" : "success" },
      ],
      check: async () => {},
      merge: async () => {
        merged = true;
      },
      deploy: async () => "1",
      deployment: async () => "SUCCESS",
      live: async () => commit,
      save: (s: State) => {
        state = structuredClone(s);
      },
      now: () => new Date(),
    };
    assert.equal((await deliver(io, state, [])).phase, "repair");
    commit = "c".repeat(40);
    assert.equal((await deliver(io, state, [])).phase, "repair");
    commit = "d".repeat(40);
    failCI = false;
    const approval = await deliver(io, state, []);
    assert.equal(approval.phase, "approval");
    assert.equal((await deliver(io, state, [{ choice: 0, about: approval.ask!.about }])).phase, "shipping");
    assert.equal((await deliver(io, state, [])).phase, "live");
  }
});

test("verification checks the registered target in a disposable checkout and keeps edits out of the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "verify-only-"));
  try {
    const config = { ...p(), cwd: root, git: root, workRoot: join(root, "worktrees") };
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "app.txt"), "registered main");
    git(root, "add", "app.txt");
    git(root, "commit", "-m", "base");
    const sha = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "app.txt"), "user changes");
    config.commands = [
      [
        process.execPath,
        "-e",
        "const fs=require('node:fs'); require('node:assert/strict').equal(fs.readFileSync('app.txt','utf8'),'registered main');fs.writeFileSync('app.txt','check output')",
      ],
    ];
    assert.match(await verifyProject(config), new RegExp(sha.slice(0, 12)));
    assert.equal(readFileSync(join(root, "app.txt"), "utf8"), "user changes");
    assert.equal(git(root, "rev-parse", "HEAD"), sha);
    assert.equal(git(root, "worktree", "list", "--porcelain").split("worktree ").length, 2);
    config.commands = [[process.execPath, "-e", "process.exit(1)"]];
    await assert.rejects(verifyProject(config));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("diagnostics hide complete authorization credentials and URL passwords", async () => {
  const { redact } = await import("../plugins/codeup/diagnostics.ts");
  const value = redact(
    "Authorization: Bearer example-bearer\nauthorization=Basic example-basic\nhttps://user:example-password@host.test/log",
    [],
  );
  assert.doesNotMatch(value, /example-bearer|example-basic|example-password/);
});

test("sensitive paths retain Unicode and embedded newlines from Git", async () => {
  const { committedDiff } = await import("../plugins/codeup/git.ts");
  const { matches } = await import("../plugins/delivery/project.ts");
  const root = mkdtempSync(join(tmpdir(), "codeup-paths-"));
  try {
    git(root, "init");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.invalid");
    git(root, "config", "core.quotePath", "true");
    git(root, "commit", "--allow-empty", "-m", "base");
    const base = git(root, "rev-parse", "HEAD");
    const names = ["迁移.sql", "line\nbreak.sql"];
    for (const name of names) writeFileSync(join(root, name), "-- example\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "sample");
    const { files } = committedDiff(root, git(root, "rev-parse", "HEAD"), base);
    assert.deepEqual(new Set(files), new Set(names));
    assert.ok(files.every((file) => matches(file, ["**/*.sql"])));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
