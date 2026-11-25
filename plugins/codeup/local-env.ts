import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Project } from "./settings.ts";
import { execute } from "./runtime.ts";

export function developmentEnv(config: Project["localEnv"]): Record<string, string> {
  if (!config) return {};
  const parsed = parseEnv(readFileSync(config.file, "utf8"));
  return Object.fromEntries(
    config.keys.map((key) => {
      if (!Object.hasOwn(parsed, key) || parsed[key] === undefined) throw new Error(`本地环境文件缺少 ${key}`);
      return [key, parsed[key]];
    }),
  );
}

export async function runMysqlMigration(check: NonNullable<Project["mysqlMigration"]>, cwd: string) {
  if (process.platform === "win32") throw new Error("独立 MySQL 迁移测试需要支持 Unix socket 的接单机");
  // Do not pass the project environment or ambient database URLs to the provisioner or the test.
  try {
    return await execute(
      [
        "/usr/bin/env",
        "-i",
        "PATH=" + (process.env.PATH ?? "/usr/bin:/bin"),
        "HOME=" + (process.env.HOME ?? ""),
        "/bin/sh",
        join(import.meta.dirname, "mysql-migration.sh"),
        check.binDir,
        check.database,
        ...check.command,
      ],
      cwd,
    );
  } catch (cause) {
    throw new Error("独立 MySQL 迁移测试失败，请查看本轮输出", { cause });
  }
}
