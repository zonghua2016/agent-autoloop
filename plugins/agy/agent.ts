import { findProgram, tail, type Adapter, type Reading } from "../../worker/agents.ts";

// Plan mode does not override the user's stored tool permissions.
const analysisSettings = JSON.stringify({
  allowNonWorkspaceAccess: false,
  toolPermission: "request-review",
  permissions: { deny: ["write_file(*)", "command(*)", "mcp(*)", "read_url(*)", "execute_url(*)"] },
});

export default {
  command(turn) {
    if (turn.access !== "read") throw new Error("agy 目前只用于只读分析");
    return [
      turn.program ?? findProgram("agy"),
      "--mode",
      "plan",
      "--sandbox",
      "--output-format",
      "stream-json",
      "--settings",
      analysisSettings,
      ...(turn.model ? ["--model", turn.model] : []),
      ...(turn.effort ? ["--effort", turn.effort] : []),
      ...(turn.resume ? ["--conversation", turn.resume] : []),
      "-p",
      turn.prompt,
    ];
  },
  read(stdout, code, stderr): Reading {
    let session: string | undefined;
    let result: { status?: unknown; response?: unknown } | undefined;
    for (const line of stdout.split("\n")) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const body = event?.event === "result" ? event.result : event?.step_update;
      if (typeof body?.conversation_id === "string" && body.conversation_id) session = body.conversation_id;
      if (event?.event === "result" && body && typeof body === "object") result = body;
    }
    const progress = { session, started: !!session };
    if (result?.status === "SUCCESS" && typeof result.response === "string" && result.response.trim()) {
      if (code === 0 || code === null) return { ...progress, finished: true, text: result.response.trim() };
    }
    if (result || code !== null)
      return { ...progress, finished: !!result, error: tail(stderr) || "agy 没有成功完成本轮" };
    return progress;
  },
} satisfies Adapter;
