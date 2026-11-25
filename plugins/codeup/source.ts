import { createHash, timingSafeEqual } from "node:crypto";
import { repositorySubject } from "./subject.ts";
import { fitJson } from "../command/json.ts";

export default function source({
  headers,
  body,
  secret,
}: {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  secret: string;
}) {
  const given = String(headers["x-codeup-token"] ?? "");
  if (
    !secret ||
    Buffer.byteLength(given) !== Buffer.byteLength(secret) ||
    !timingSafeEqual(Buffer.from(given), Buffer.from(secret))
  )
    throw new Error("signature");
  if (headers["codeup-event"] !== "Merge Request Hook") return [];
  const payload = JSON.parse(body),
    item = payload.object_attributes ?? {};
  let repo = payload.project?.path_with_namespace;
  if (!repo && item.target?.http_url) {
    const url = new URL(item.target.http_url);
    if (url.hostname !== "codeup.aliyun.com") throw new Error("Codeup 仓库链接无效");
    repo = url.pathname.slice(1).replace(/\.git$/, "");
  }
  const number = item.local_id ?? item.iid;
  if (typeof repo !== "string" || !/^[\w./-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1)
    throw new Error("Codeup 事件缺少仓库或局部 MR 编号，不能使用全局 ID 代替");
  const action = String(item.action ?? "update").toLowerCase();
  if (!/^[a-z_]+$/.test(action)) throw new Error("Codeup 事件类型无效");
  return [
    {
      id: createHash("sha256").update(body).digest("hex"),
      type: `merge_request.${action}`,
      subject: repositorySubject(repo, number),
      summary: [...String(item.title ?? "Codeup 合并请求更新")].slice(0, 200).join(""),
      detail: fitJson({
        source: typeof item.source_branch === "string" ? item.source_branch : undefined,
        target: typeof item.target_branch === "string" ? item.target_branch : undefined,
      }),
    },
  ];
}
