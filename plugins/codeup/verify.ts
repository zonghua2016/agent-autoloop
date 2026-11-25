// Verification uses only the registered branch and checks; the message cannot supply commands or request delivery.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git, remoteHead } from "./git.ts";
import { developmentEnv, runMysqlMigration } from "./local-env.ts";
import { execute, loadProject } from "./runtime.ts";
import type { Project } from "./settings.ts";

export async function verifyProject(project: Project) {
  const head = remoteHead(project, project.branch);
  git(project.cwd, "fetch", "--no-tags", "--no-write-fetch-head", project.git, head);
  mkdirSync(project.workRoot, { recursive: true });
  const dir = mkdtempSync(join(project.workRoot, "verify-"));
  let attached = false;
  try {
    git(project.cwd, "worktree", "add", "--detach", dir, head);
    attached = true;
    const env = developmentEnv(project.localEnv);
    for (const command of project.commands) await execute(command, dir, undefined, undefined, env);
    if (project.mysqlMigration) await runMysqlMigration(project.mysqlMigration, dir);
    return `验收通过：${project.id} ${project.branch}（${head.slice(0, 12)}）项目检查通过${project.mysqlMigration ? "，独立 MySQL 迁移测试通过" : ""}。`;
  } finally {
    if (attached) git(project.cwd, "worktree", "remove", "--force", dir);
    else rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    console.log(await verifyProject(loadProject(process.argv[2], process.argv[3])));
  } catch (error) {
    console.error(error);
    console.log("验收未通过：" + (error as Error).message.split("\n")[0].slice(0, 240));
  }
}
