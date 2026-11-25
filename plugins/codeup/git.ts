import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Project } from "./settings.ts";
import { projectSettings } from "./settings.ts";

export function git(cwd: string, ...args: string[]) {
  const output = gitOutput(cwd, ...args);
  return output.trim();
}
function gitOutput(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.interactive=false", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 24 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}
export function ref(branch: string) {
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    /[\s~^:?*\[\\]/.test(branch) ||
    branch.endsWith(".lock")
  )
    throw new Error("Git 分支名无效");
  return `refs/heads/${branch}`;
}
export function remoteHead(p: Project, branch: string) {
  const sha = git(p.cwd, "ls-remote", p.git, ref(branch)).split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("远端未返回完整 Git 提交");
  return sha;
}
export function snapshot(p: Project, bare: string, branch: string) {
  mkdirSync(dirname(bare), { recursive: true });
  if (!existsSync(bare)) git(dirname(bare), "init", "--bare", bare);
  git(bare, "fetch", "--no-tags", p.git, `+${ref(p.branch)}:refs/heads/target`, `+${ref(branch)}:refs/heads/source`);
  const head = git(bare, "rev-parse", "source"),
    base = git(bare, "rev-parse", "target");
  const settings = projectSettings(JSON.parse(git(bare, "show", `${base}:${p.settingsPath}`)));
  return { head, base, settings, ...committedDiff(bare, head, base) };
}

export function committedDiff(repo: string, head: string, base: string) {
  const files = gitOutput(repo, "diff", "--name-only", "-z", "--no-renames", `${base}...${head}`)
    .split("\0")
    .filter(Boolean);
  const text = git(repo, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", `${base}...${head}`);
  if (git(repo, "rev-list", "--min-parents=3", head, "--not", base))
    throw new Error("MR 含有无法完整审查的多父合并提交");
  return { files, text };
}
