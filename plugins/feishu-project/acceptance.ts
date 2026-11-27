// Only trusted Codeup work links an MR to a project issue. Each repair gets a new subject and branch.
import { createHash } from "node:crypto";
import type { ReleaseEvidence } from "../feishu-bugs/release.ts";

type Scope = { space: string; project: string; source: string; fromMR: number };
export type AcceptedWork = ReleaseEvidence & {
  issue: string;
  link: string;
  root: string;
  title: string;
};
type Work = {
  mr?: number;
  title?: string;
  checked?: string;
  pushed?: string;
  branch?: string;
  gate?: { head?: string; base?: string; reviewed?: boolean; findings?: unknown[]; ciRun?: string };
  task?: {
    events?: { id?: string; source?: string; type?: string; subject?: string; link?: string; detail?: string }[];
  };
};
export function acceptanceWork(c: Scope, key: string, w: Work): AcceptedWork | undefined {
  const e = w.task?.events?.find((e) => e.source === c.source && e.type === c.project + ".bug");
  const issue = e?.link?.split("/").at(-1);
  if (
    !e ||
    !issue ||
    !/^[1-9]\d*$/.test(issue) ||
    e.link !== `https://project.feishu.cn/${c.space}/issue/detail/${issue}`
  )
    return;
  const root = createHash("sha256")
    .update(JSON.stringify([c.space, "issue", issue]))
    .digest("hex");
  if (
    !e.id ||
    !(
      e.id === root ||
      (e.id.startsWith(root + "-r") && /^[1-9]\d*(?:-v[1-9]\d*)?$/.test(e.id.slice(root.length + 2)))
    ) ||
    e.subject !== "fp-" + e.id ||
    key !== `work:${c.project}:${e.subject}` ||
    typeof w.mr !== "number" ||
    !Number.isSafeInteger(w.mr) ||
    w.mr < c.fromMR ||
    !w.branch?.startsWith("autoloop/") ||
    !w.checked ||
    w.pushed !== w.checked ||
    w.gate?.head !== w.checked ||
    !w.gate.reviewed ||
    w.gate.findings?.length ||
    !w.gate.ciRun ||
    !w.gate.base
  )
    return;
  return {
    mr: w.mr,
    branch: w.branch,
    head: w.checked,
    base: w.gate.base,
    issue,
    root,
    link: e.link,
    title: w.title ?? "缺陷",
  };
}
export function recipients(roles: { key: string; members?: { key: string }[] }[]) {
  return [
    ...new Set(
      roles
        .filter((r) => r.key === "reporter" || r.key === "operator")
        .flatMap((r) => (r.members ?? []).map((m) => m.key))
        .filter(Boolean),
    ),
  ];
}
export type Answer = { about?: string; by?: string; choice?: number | null };
export function acceptanceAction(
  status: string,
  key: string,
  people: string[],
  user: string,
  openId: string,
  answer?: Answer,
) {
  if (status !== "RESOLVED" || !people.includes(user) || answer?.about !== key || answer.by !== openId) return;
  return answer.choice === 0 ? "CLOSED" : answer.choice === 1 ? "REOPENED" : undefined;
}
