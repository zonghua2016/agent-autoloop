// Run the real developer and delivery entry points over temporary Git and a local API, including answer/timer recovery.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { git } from "../plugins/codeup/git.ts";
import { parseResult } from "../protocol/validate.ts";
import { receiptBlock } from "../plugins/delivery/input.ts";

test("React and NestJS enter through developer, real Git, HTTP, CR, approval, Flow and version verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeup-runtime-"));
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const repository = join(root, "repo");
    mkdirSync(repository);
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    const policy = {
      ci: { pipeline: "123", env: {} },
      checks: [{ name: "autoloop-ci", writers: ["bot"] }],
      sensitive: [],
      review: { model: "test", effort: "high", points: "真实错误" },
      autoMerge: true,
      protectedBranchVerified: true,
      deploy: { pipeline: "456", env: {}, health: { url: "https://example.invalid/version.json", field: "commit" } },
    };
    mkdirSync(join(repository, "ops"));
    writeFileSync(join(repository, "ops/codeup-delivery.json"), JSON.stringify(policy));
    git(repository, "add", ".");
    git(repository, "commit", "-m", "base");
    let mr: any,
      checks: any[] = [],
      nextCheck = 0,
      nextRun = 0;
    const runs = new Map<string, any>();
    const calls: string[] = [];
    let loseCreateResponse = true;
    let failRead = false;
    let failDeployment = false;
    let pendingCI = false;
    let blockReview = false;
    server = createServer(async (req, res) => {
      try {
        let text = "";
        for await (const chunk of req) text += chunk;
        const body = text ? JSON.parse(text) : undefined;
        const url = new URL(req.url!, "http://localhost"),
          path = url.pathname;
        calls.push(`${req.method} ${path}`);
        assert.equal(req.headers["x-yunxiao-token"], "fake-test-token");
        let value: any;
        if (path === "/review") value = blockReview ? [{ title: "src/react.ts:1", text: "需要修复的问题" }] : [];
        else if (path === "/version.json") value = { commit: mr.mergedRevision };
        else if (path.endsWith("/changeRequests") && req.method === "GET" && failRead) {
          failRead = false;
          res.writeHead(503).end('{"error":"temporary read outage"}');
          return;
        } else if (path.endsWith("/changeRequests") && req.method === "GET")
          value = mr && mr.status !== "MERGED" ? [mr] : [];
        else if (path.endsWith("/repositories/17") && req.method === "GET") value = { id: 17 };
        else if (path.endsWith("/changeRequests") && req.method === "POST") {
          const head = git(repository, "rev-parse", body.sourceBranch);
          assert.ok(checks.some((c) => c.name === "autoloop-cr" && c.headSha === head && c.conclusion === "success"));
          assert.ok(checks.some((c) => c.name === "autoloop-ci" && c.headSha === head && c.conclusion === "success"));
          assert.equal(body.sourceProjectId, 17);
          mr = {
            ...body,
            localId: 7,
            projectId: 17,
            status: "UNDER_REVIEW",
            allRequirementsPass: true,
            conflictCheckStatus: "NO_CONFLICT",
            behind: 0,
            detailUrl: "https://codeup.aliyun.com/org/demo/change/7",
          };
          value = mr;
          if (loseCreateResponse) {
            loseCreateResponse = false;
            res.writeHead(503);
            res.end(JSON.stringify({ error: "模拟已创建MR但响应丢失" }));
            return;
          }
        } else if (path.endsWith("/changeRequests/7/merge")) {
          assert.equal(body.mergeType, "ff-only");
          mr.mergedRevision = git(repository, "rev-parse", mr.sourceBranch);
          mr.status = "MERGED";
          git(repository, "update-ref", "refs/heads/main", mr.mergedRevision);
          value = mr;
        } else if (path.endsWith("/changeRequests/7")) value = mr;
        else if (path.endsWith("/checkRuns") && req.method === "GET")
          value = checks.filter((c) => c.headSha === url.searchParams.get("ref"));
        else if (path.includes("/checkRuns") && req.method === "POST") {
          const prior = checks.find((c) => c.externalId === body.externalId);
          value = { ...body, id: prior?.id ?? ++nextCheck, writer: { id: "bot" } };
          checks = checks.filter((c) => c.id !== value.id);
          checks.push(value);
        } else if (path.endsWith("/runs") && req.method === "POST") {
          const params = JSON.parse(body.params);
          assert.match(params.envs.AUTOLOOP_EXPECTED_SHA, /^[a-f0-9]{40}$/);
          value = ++nextRun;
          runs.set(`${path}/${value}`, {
            status: "SUCCESS",
            pipelineId: path.includes("/123/") ? 123 : 456,
            pipelineRunId: value,
            sources: [
              {
                type: "codeup",
                data: {
                  repo: "https://codeup.aliyun.com/org/demo.git",
                  branch: Object.values(params.runningBranchs)[0],
                  commit: JSON.stringify([{ commitId: params.envs.AUTOLOOP_EXPECTED_SHA }]),
                },
              },
            ],
            globalParams: Object.entries(params.envs).map(([key, value]) => ({ key, value })),
          });
        } else if (path.includes("/runs/")) {
          value = { ...runs.get(path), ...(failDeployment && path.includes("/pipelines/456/") && { status: "FAIL" }) };
          if (pendingCI && path.includes("/pipelines/123/")) {
            value.status = "RUNNING";
            pendingCI = false;
          }
        } else throw new Error(`Unexpected API ${req.method} ${path}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      } catch (error) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const registry = join(root, "projects.json");
    const file = join(repository, ".env");
    writeFileSync(file, "APP_FIXTURE=name-from-local-file");
    writeFileSync(
      registry,
      JSON.stringify(
        ["react", "nestjs"].map((id) => ({
          id,
          organization: "org",
          repository: "17",
          git: "https://codeup.aliyun.com/org/demo.git",
          cwd: repository,
          workRoot: join(root, "work", id),
          branch: "main",
          tokenEnv: "YUNXIAO_TOKEN",
          serviceUserId: "bot",
          api: "https://openapi-rdc.aliyuncs.com",
          settingsPath: "ops/codeup-delivery.json",
          codex: "fake-codex",
          developmentModel: "test",
          ...(id === "nestjs" && { localEnv: { file, keys: ["APP_FIXTURE"] } }),
          commands: [
            [
              process.execPath,
              "-e",
              `require('node:assert/strict').equal(process.env.APP_FIXTURE, ${id === "nestjs" ? "'name-from-local-file'" : "undefined"})`,
            ],
          ],
        })),
      ),
    );
    const runner = join(root, "runner.mjs");
    const missingOptions =
      "待你处理：请补充接口契约\n" +
      receiptBlock({ ask: [{ key: "contract", title: "接口契约", text: "请提供平台字段", about: "补充后续跑" }] });
    writeFileSync(
      runner,
      `
      import {readFileSync,writeFileSync,mkdirSync,appendFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {develop} from ${JSON.stringify(new URL("../plugins/codeup/develop.ts", import.meta.url).href)};
      import {runDelivery,loadProject,execute} from ${JSON.stringify(new URL("../plugins/codeup/runtime.ts", import.meta.url).href)};
      const [mode,registry,id]=process.argv.slice(2);
      const request=async(url,init)=>fetch(new URL(new URL(url).pathname+new URL(url).search,'http://127.0.0.1:${address.port}'),{...init,headers:{...init?.headers,'x-yunxiao-token':'fake-test-token'}});
      if(mode==='develop'||mode==='clarify') console.log(await develop(registry,id,{request,beforeCheck:async proof=>{
        if(!/^[a-f0-9]{40}$/.test(proof.head)||!proof.gate.reviewed||proof.gate.findings?.length||proof.pushed!==proof.head)throw Error('precheck received unverified work');
        writeFileSync(${JSON.stringify(join(root, "precheck-proof"))},JSON.stringify(proof));
      },review:async()=>{
        const response=await request('https://openapi-rdc.aliyuncs.com/review',{method:'POST'});
        return response.json();
      },run:async(args,cwd,...rest)=>{
        if(args[0]!=='fake-codex') return execute(args,cwd,...rest);
        if(id==='nestjs') await execute([process.execPath,'-e',"require('node:assert/strict').equal(process.env.APP_FIXTURE,'name-from-local-file')"],cwd,...rest);
        if(mode==='clarify') return [
          {type:'thread.started',thread_id:'clarification-session'},
          {type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(missingOptions)}}},
          {type:'turn.completed'},
        ].map(x=>JSON.stringify(x)).join('\\n');
        appendFileSync(${JSON.stringify(join(root, "developer-calls"))},id+'\\n');
        const task = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT, 'utf8'));
        const subject = task.events.find(event => event.type !== 'timer.due')?.subject ?? 'task-1';
        mkdirSync(join(cwd,'src'),{recursive:true});writeFileSync(join(cwd,'src',id+'-'+subject+'.ts'),'export const value=1;');
        return [ {type:'thread.started',thread_id:'fake-session'}, {type:'turn.started'}, {type:'item.completed',item:{type:'agent_message',text:'开发完成'}}, {type:'turn.completed'} ].map(x=>JSON.stringify(x)).join('\\n');
      }}));
      else console.log(await runDelivery(loadProject(registry,id),JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT,'utf8')),request,async()=>[]));
    `,
    );
    const contextFile = join(root, "context.json");
    const run = (mode: string, id: string, data: object) => {
      writeFileSync(contextFile, JSON.stringify(data));
      return new Promise<string>((resolve, reject) =>
        execFile(
          process.execPath,
          [runner, mode, registry, id],
          {
            env: {
              ...process.env,
              AGENT_AUTOLOOP_HOME: join(root, "home", id),
              AGENT_AUTOLOOP_CONTEXT: contextFile,
              YUNXIAO_TOKEN: "fake-test-token",
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: `url.${repository}.insteadOf`,
              GIT_CONFIG_VALUE_0: "https://codeup.aliyun.com/org/demo.git",
            },
            encoding: "utf8",
            timeout: 30_000,
          },
          (error, stdout, stderr) => (error ? reject(new Error(stderr || String(error))) : resolve(stdout)),
        ),
      );
    };
    const question = await run("clarify", "nestjs", {
      events: [{ id: 10, subject: "needs-contract", summary: "变更 SDK 接口" }],
    });
    const clarification = JSON.parse(/```agent-autoloop\n([\s\S]*?)\n```/.exec(question)![1]);
    const validated = parseResult({ outcome: "done", ...clarification });
    assert.deepEqual(validated.ask?.[0].options, ["已补充，继续", "暂不处理"], question);
    assert.equal(validated.ask?.[0].text, "请提供平台字段");
    const binding = JSON.parse(validated.ask![0].about!);
    assert.equal(binding.work, "nestjs:needs-contract");
    assert.equal(binding.clarify, true);
    assert.equal(binding.retry, undefined);
    assert.match(
      await run("develop", "nestjs", { events: [], answers: [{ choice: 1, about: validated.ask![0].about }] }),
      /暂不继续/,
    );
    assert.deepEqual(calls.slice(), []);
    for (const id of ["react", "nestjs"]) {
      if (id === "nestjs") {
        writeFileSync(join(repository, "ops/codeup-delivery.json"), JSON.stringify({ ...policy, deploy: undefined }));
        git(repository, "add", "ops/codeup-delivery.json");
        git(repository, "commit", "-m", "use main-triggered deployment");
      }
      mr = undefined;
      checks = [];
      loseCreateResponse = true;
      pendingCI = true;
      const start = calls.length;
      const waiting = await run("develop", id, {
        events: [{ id: 1, subject: "task-1", summary: "增加功能", detail: "支持新增条目" }],
        answers: [{ text: "PRIVATE_ANSWER_SENTINEL" }],
        open: [{ text: "PRIVATE_OPEN_SENTINEL" }],
        decided: [{ text: "PRIVATE_DECISION_SENTINEL" }],
      });
      assert.match(waiting, /等待.*CI/);
      assert.equal(JSON.parse(readFileSync(join(root, "precheck-proof"), "utf8")).project.id, id);
      assert.equal(mr, undefined);
      const round = calls.slice(start);
      assert.ok(
        round.indexOf("POST /review") <
          round.findIndex((c) => c.startsWith("POST") && c.endsWith("/pipelines/123/runs")),
      );
      assert.ok(round.includes("POST /review"));
      const waitingReceipt = JSON.parse(/```agent-autoloop\n([\s\S]*?)\n```/.exec(waiting)![1]);
      failRead = true;
      await assert.rejects(
        run("develop", id, {
          events: [{ id: 2, type: "timer.due", subject: "task-1" }],
          timers: waitingReceipt.later,
        }),
        /HTTP 503/,
      );
      const interrupted = await run("develop", id, {
        events: [{ id: 2, type: "timer.due", subject: "task-1" }],
        timers: waitingReceipt.later,
      });
      const retry = JSON.parse(/```agent-autoloop\n([\s\S]*?)\n```/.exec(interrupted)![1]);
      assert.equal(retry.ask[0].options[0], "已处理，继续");
      const beforeDecline = calls.length;
      assert.match(
        await run("develop", id, { events: [{ subject: "" }], answers: [{ choice: 1, about: retry.ask[0].about }] }),
        /暂不继续/,
      );
      assert.equal(calls.length, beforeDecline);
      const developed = await run("develop", id, {
        events: [{ id: 100, subject: "" }],
        answers: [{ choice: 0, about: retry.ask[0].about }],
      });
      assert.match(developed, /MR 7/);
      assert.match(mr!.description, /增加功能/);
      assert.match(mr!.description, /支持新增条目/);
      assert.doesNotMatch(mr!.description, /PRIVATE_.*_SENTINEL|"answers"|"open"|"decided"/);
      const approval = await run("delivery", id, { events: [{ subject: `${id}#7` }] });
      assert.equal(
        calls.slice(start).filter((c) => c.startsWith("POST") && c.endsWith("/pipelines/123/runs")).length,
        1,
      );
      const receipt = JSON.parse(/```agent-autoloop\n([\s\S]*?)\n```/.exec(approval)![1]);
      assert.equal(receipt.ask.length, 1);
      const approved = await run("delivery", id, {
        events: [{ subject: "" }],
        answers: [{ choice: 0, about: receipt.ask[0].about }],
      });
      if (id === "nestjs") {
        assert.match(approved, /代码已合并到 main/);
        assert.equal(calls.slice(start).filter((c) => c.includes("/pipelines/456/")).length, 0);
        continue;
      }
      assert.match(approved, /已启动 Flow/);
      failDeployment = true;
      const attention = await run("delivery", id, {
        events: [],
        timers: [{ about: JSON.stringify({ project: id, mr: 7 }) }],
      });
      const attentionReceipt = JSON.parse(/```agent-autoloop\n([\s\S]*?)\n```/.exec(attention)![1]);
      const beforeDeliveryDecline = calls.length;
      assert.match(
        await run("delivery", id, {
          events: [{ subject: "" }],
          answers: [{ choice: 1, about: attentionReceipt.ask[0].about }],
        }),
        /暂不继续/,
      );
      assert.equal(calls.length, beforeDeliveryDecline);
      failDeployment = false;
      assert.match(
        await run("delivery", id, {
          events: [{ subject: "" }],
          answers: [{ choice: 0, about: attentionReceipt.ask[0].about }],
        }),
        /线上版本已核实/,
      );
      assert.match(await run("develop", id, { events: [{ id: 1, subject: "task-1", summary: "增加功能" }] }), /MR/);
    }
    assert.equal(readFileSync(join(root, "developer-calls"), "utf8").trim().split("\n").length, 2);
    const projects = JSON.parse(readFileSync(registry, "utf8"));
    projects[1].mysqlMigration = {
      binDir: join(root, "missing-mysql"),
      database: "test_db",
      command: [process.execPath, "--version"],
    };
    writeFileSync(registry, JSON.stringify(projects));
    const beforeMigration = calls.length;
    const failed = await run("develop", "nestjs", {
      events: [{ id: 12, subject: "database-check", summary: "验证数据库迁移" }],
    });
    assert.match(failed, /独立 MySQL 迁移测试/);
    assert.equal(calls.length, beforeMigration);
    assert.equal(calls.filter((c) => c.endsWith("/merge")).length, 2);
    assert.equal(calls.filter((c) => c.startsWith("POST") && c.endsWith("/changeRequests")).length, 2);
    const beforeBlocked = calls.length;
    blockReview = true;
    const needsRepair = await run("develop", "react", {
      events: [{ id: 14, subject: "cr-blocks-ci", summary: "修复代码" }],
    });
    assert.match(needsRepair, /审查发现问题，交回开发任务/);
    assert.deepEqual(calls.slice(beforeBlocked), ["POST /review"]);
    blockReview = false;
    git(repository, "rm", "ops/codeup-delivery.json");
    git(repository, "commit", "-m", "disable delivery");
    const beforeSkip = calls.length;
    const skipped = await run("develop", "react", {
      events: [{ id: 13, subject: "no-delivery", summary: "本地开发" }],
    });
    assert.match(skipped, /未配置.*跳过/);
    assert.equal(calls.length, beforeSkip);
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
