// A minimal project must generate the same routes as a fully configured one, and broken wiring must be visible before dispatch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { project } from "../plugins/codeup/settings.ts";
import { configuration } from "../plugins/codeup/configure.ts";
import { wiring } from "../plugins/codeup/doctor.ts";

test("a project registered once covers development and verification, including mismatched active intake", () => {
  const p = project({
    id: "tiny",
    cwd: join(tmpdir(), "tiny"),
    organization: "org",
    git: "https://codeup.aliyun.com/org/team/tiny.git",
    serviceUserId: "writer",
    developmentModel: "example",
    commands: [["npm", "test"]],
  });
  assert.equal(p.repository, "org/team/tiny");
  assert.equal(p.branch, "main");
  const plan = configuration([p], resolve("registry"), "worker", resolve("."), process.execPath);
  const config = { channels: { chat: { use: "feishu-tasks", tasks: { projects: plan.intake } } } };
  assert.deepEqual(wiring(p, plan.rules, config), []);
  plan.rules.agents["codeup-tiny-deliver"] = {
    use: "command",
    command: ["node-with-env", "/installed/plugins/codeup/run.ts", resolve("registry"), "tiny"],
  };
  assert.deepEqual(wiring(p, plan.rules, config, resolve("registry")), []);
  plan.intake[0].verifyBranch = "elsewhere";
  delete plan.rules.agents["codeup-tiny-develop"];
  const findings = wiring(p, plan.rules, config).join(" ");
  delete plan.rules.agents["codeup-tiny-deliver"];
  assert.match(wiring(p, plan.rules, config).join(" "), /codeup-tiny-deliver/);
  assert.match(findings, /verifyBranch/);
  assert.match(findings, /codeup-tiny-develop/);
});
