// Run inside Flow's unprivileged build environment. This program has no delivery credentials.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { commandLine } from "../../host/command.ts";

export type Profile = { kind: "react" | "nestjs"; commands: string[][]; versionFiles?: string[] };
export function runCI(profile: Profile, cwd: string, expected: string) {
  if (!/^[a-f0-9]{40}$/.test(expected)) throw new Error("缺少本次提交的 AUTOLOOP_EXPECTED_SHA，拒绝检查或发布其他版本");
  const actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  if (actual !== expected) throw new Error("检出的代码与本次交付提交不一致");
  if (!["react", "nestjs"].includes(profile.kind) || !Array.isArray(profile.commands) || !profile.commands.length)
    throw new Error("CI profile 必须提供实际检查命令");
  for (const command of profile.commands) {
    if (!Array.isArray(command) || !command.length || !command.every((x) => typeof x === "string" && x))
      throw new Error("CI 命令必须为非空参数数组");
    execFileSync(...commandLine(command), { cwd, stdio: "inherit", timeout: 20 * 60_000 });
  }
  for (const file of profile.versionFiles ?? []) {
    const target = resolve(cwd, file);
    const within = relative(resolve(cwd), target);
    if (!within || within === ".." || within.startsWith(".." + sep) || isAbsolute(within))
      throw new Error("版本文件路径越界");
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, JSON.stringify({ commit: expected }) + "\n");
  }
  return { commit: expected, kind: profile.kind, passed: true };
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const profile = JSON.parse(readFileSync(process.argv[2], "utf8"));
    console.log(JSON.stringify(runCI(profile, process.cwd(), process.env.AUTOLOOP_EXPECTED_SHA ?? "")));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
