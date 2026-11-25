import type { Task } from "./inbox.ts";

export type ArchivePlan = {
  id: string;
  revision: string;
  targets: string[];
  status: "draft" | "finished" | "cancelled" | "restored";
  text: string;
  result?: string;
  rendered?: ArchivePlan["status"];
};

export function canArchive(task: Task) {
  if (task.archived) return false;
  if (task.state === "cancelled") return true;
  const delivery = task.delivery;
  return (
    task.state === "finished" &&
    (!delivery?.stage || delivery.stage === "complete") &&
    !["已创建 MR", "尚无 MR", "等待返修", "已派发", "交付结果待核实"].includes(delivery?.title ?? "")
  );
}

export function archiveIntent(content: string) {
  const restore = /^(?:撤销|恢复)(?:上次)?归档(?:\s+([a-f0-9]{12}))?[。！!]?$/u.exec(content);
  if (restore) return { intent: "restore_archive" as const, target: restore[1] };
  if (/^(?:清理|归档)(?:进度|状态|完成了吗|完了吗)[。？?]?$/u.test(content))
    return { intent: "archive_status" as const };
  if (
    /^(?:清理|归档)(?:完(?:了|成)?(?:以后|后)?|好了)[，,\s]*(?:记得|请)?(?:回|回复|通知|告诉)我(?:一下|一声)?[。！!]?$/u.test(
      content,
    )
  )
    return { intent: "archive_status" as const };
  if (
    /^(?:除了|保留)[^。！？]{0,36}(?:待办|提醒)[^。！？]{0,28}(?:清理|归档|删(?:除|掉)?)[^。！？]{0,14}[。！!]?$/u.test(
      content,
    ) ||
    /^(?:请|帮我)?\s*(?:清理|归档)(?:已(?:完成|结束|取消)的?|其他|历史)?\s*任务[。！!]?$/u.test(content)
  )
    return { intent: "archive" as const };
}

export function groundedChatReply(reply: string) {
  const claimed =
    /(?:已(?:经)?|正在|开始|马上|我(?:会|来)|这就)[^\n。；]{0,28}(?:安排|登记|提交|派发|执行|清理|归档|删除|删掉|取消|修改|更新|部署|合并|停掉|停止|处理|提醒)|(?:做完|处理完|清理完|完成后|稍后)[^\n。；]{0,28}(?:回你|回复|通知|告诉你|提醒)/u;
  const statements = reply
    .split(/[。；\n]/u)
    .filter(
      (line) =>
        !/^\s*(?:你(?:之前|曾经|说过|提到)|记录(?:显示|提到)|根据(?:此前|历史)记录|回顾[：:])/u.test(line) ||
        /(?:我(?:会|来)|这就|现在|马上)/u.test(line),
    );
  return statements.some((line) => claimed.test(line))
    ? "这条消息没有登记可跟踪的执行记录，暂时无法确认操作或安排完成通知。"
    : reply;
}
