// Only the trusted browser runner publishes completed reports, by renaming a temporary file in its output directory.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Retest = { round: number; testedAt: number; summary: string; cardSeen?: boolean };

export function passedRetest(
  directory: string | undefined,
  binding: {
    issue: string;
    mr: number;
    round: number;
    page: string;
    sha: string;
    since: number;
    repairId: string;
    legacy: boolean;
  },
): Retest | undefined {
  const { issue, mr, round, page, sha, since } = binding;
  if (!directory) return;
  const file = join(directory, `feishu-${issue}-mr${mr}`, "results.json");
  let report;
  try {
    if (statSync(file).size > 64 * 1024) throw new Error("复验报告过大");
    report = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`缺陷 ${issue} 的 MR #${mr} 复验报告暂不可读，保留当前流程`);
    return;
  }
  const testedAt = typeof report?.testedAt === "string" ? Date.parse(report.testedAt) : NaN;
  if (
    report?.issue !== issue ||
    report.mr !== mr ||
    report.page !== page ||
    report.sha !== sha ||
    (report.repairId !== binding.repairId && !(binding.legacy && report.repairId === undefined)) ||
    !Number.isFinite(testedAt) ||
    testedAt < since ||
    testedAt > Date.now() ||
    !Array.isArray(report.results) ||
    !report.results.length ||
    report.results.length > 32 ||
    !report.results.every(
      (r: { expected?: unknown; actual?: unknown; scenario?: unknown } | null) =>
        r &&
        typeof r.scenario === "string" &&
        r.scenario.trim() &&
        typeof r.expected === "string" &&
        r.expected.trim() &&
        r.expected === r.actual,
    )
  )
    return;
  const scenarios = [...new Set<string>(report.results.map((r: { scenario: string }) => r.scenario))].join("、");
  const fixture = typeof report.fixture === "string" ? report.fixture.trim().slice(0, 240) : "";
  return {
    round,
    testedAt,
    summary:
      `网页实测 ${report.results.length} 项通过（${scenarios.slice(0, 200)}）。` +
      (fixture ? "\n测试条件：" + fixture : ""),
  };
}
