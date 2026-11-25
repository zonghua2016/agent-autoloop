import { execFileSync } from "node:child_process";
import { commandLine } from "../../host/command.ts";
import { findProgram, tail, type Adapter, type Reading } from "../../worker/agents.ts";

export default {
  command: (turn) => [
    turn.program ?? findProgram("gemini"),
    "--output-format",
    "stream-json",
    "--approval-mode",
    { read: "plan", edit: "auto_edit", full: "yolo" }[turn.access],
    ...(turn.access !== "full" ? ["--sandbox"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.resume ? ["--resume", turn.resume] : []),
    "--prompt",
    turn.prompt,
  ],
  read(stdout, code, stderr): Reading {
    let session: string | undefined;
    let answer = "";
    let terminal: string | undefined;
    let usage: { input?: number; output?: number; cached?: number } | undefined;
    for (const line of stdout.split("\n")) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (row?.type === "init" && typeof row.session_id === "string") session = row.session_id;
      if (row?.type === "message" && row.role === "assistant" && typeof row.content === "string")
        answer = row.delta ? answer + row.content : row.content;
      if (row?.type === "result") {
        terminal = String(row.status);
        usage = { input: row.stats?.input_tokens, output: row.stats?.output_tokens, cached: row.stats?.cached };
      }
    }
    const progress = { session, started: !!session };
    if (terminal === "success" && answer.trim() && (code === 0 || code === null))
      return { ...progress, text: answer.trim(), finished: true, usage };
    if (terminal || code !== null)
      return { ...progress, finished: !!terminal, error: tail(stderr) || "Gemini 没有成功完成本轮" };
    return progress;
  },
  check(program) {
    try {
      execFileSync(...commandLine([program ?? findProgram("gemini"), "--version"]), {
        timeout: 15_000,
        stdio: "ignore",
      });
      return null;
    } catch {
      return "Gemini CLI 无法运行，请检查安装、Node 版本和后台 PATH";
    }
  },
} satisfies Adapter;
