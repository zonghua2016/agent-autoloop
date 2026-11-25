import { readFileSync, existsSync } from "node:fs";
import { project } from "./settings.ts";

const projects = JSON.parse(readFileSync(process.argv[2], "utf8")).map(project);
let pending = false;
for (const p of projects) {
  const checks = [
    ["本地仓库", existsSync(p.cwd)],
    ["云效访问令牌", !!process.env[p.tokenEnv]],
    ["检查写入者 ID", !!p.serviceUserId],
  ] as const;
  for (const [label, ok] of checks) {
    console.log(`${ok ? "通过" : "待配置"} ${p.id}：${label}`);
    if (!ok) pending = true;
  }
}
console.log("此检查不请求云效、不运行项目代码；流水线、保护分支、版本接口需真实联调后确认。");
process.exitCode = pending ? 2 : 0;
