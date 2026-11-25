import type { Codeup } from "./api.ts";

export function redact(text: string, secrets: string[]) {
  for (const secret of secrets.filter(Boolean)) text = text.replaceAll(secret, "[已隐藏]");
  return text
    .replace(
      /((?:token|secret|password|authorization|api[_-]?key)\s*[=:]\s*)(?:(?:Bearer|Basic)\s+)?[^\s,;]+/gi,
      "$1[已隐藏]",
    )
    .replace(/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[已隐藏]@");
}
export async function failureLogs(api: Codeup, pipeline: string, runId: string, run: any) {
  const parts = [`Flow ${pipeline} / run ${runId}`];
  const jobs = (run.stages ?? []).flatMap((stage: any) => stage.stageInfo?.jobs ?? []);
  for (const job of jobs.filter((job: any) => ["FAIL", "FAILED"].includes(job.status))) {
    if (!job.id) continue;
    const data = await api.call(`${api.flow(pipeline, runId)}/job/${encodeURIComponent(String(job.id))}/log`);
    parts.push(`${job.name ?? job.id}:\n${String(data.content ?? "").slice(-12000)}`);
  }
  return redact(parts.join("\n"), [api.token]).slice(-24000);
}
