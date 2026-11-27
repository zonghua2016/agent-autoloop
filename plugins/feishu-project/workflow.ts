// Resolve a transition against the current instance; the server remains authoritative about permissions and form fields.
import { recipients } from "./acceptance.ts";
import type { meegle } from "./run.ts";

type Client = ReturnType<typeof meegle>;
export function projectIssue(client: Client, space: string, issue: string) {
  const params = { project_key: space, work_item_id: issue };
  async function read() {
    const response = await client("workitem", "get", { ...params, fields: ["description", "bug_classification"] });
    const attr = response.work_item_attribute;
    if (
      attr?.work_item_id !== issue ||
      attr.owned_project?.simple_name !== space ||
      attr.work_item_type?.key !== "issue" ||
      !Array.isArray(attr.role_members) ||
      !attr.work_item_status?.key
    )
      throw new Error("未核实缺陷的身份、状态或负责人");
    const platform = response.work_item_fields?.find((f: { key: string }) => f.key === "bug_classification")?.value;
    const description = response.work_item_fields?.find((f: { key: string }) => f.key === "description")?.value;
    return {
      status: String(attr.work_item_status.key),
      updatedAt: Date.parse(attr.update_time),
      people: recipients(attr.role_members),
      operators: recipients(attr.role_members.filter((r: { key: string }) => r.key === "operator")),
      platforms: (Array.isArray(platform) ? platform : [platform]).map((v) => v?.label).filter(Boolean),
      description: typeof description === "string" ? description : "",
    };
  }
  async function fillResolution(values: Record<string, string | string[]>) {
    const keys = Object.keys(values);
    if (!keys.length) return;
    if (keys.some((k) => !/^field_[a-z0-9]+$/.test(k) && k !== "resolve_version"))
      throw new Error("解决表单只能补充登记的解决字段");
    const j = await client("workitem", "get", { ...params, fields: ["description", ...keys] });
    if (j.work_item_attribute?.work_item_id !== issue || !Array.isArray(j.work_item_fields))
      throw new Error("无法核对解决表单");
    const fields = keys
      .filter((k) => {
        const current = j.work_item_fields.find((f: { key: string }) => f.key === k)?.value;
        return current == null || current === "" || (Array.isArray(current) && !current.length);
      })
      .map((k) => ({
        field_key: k,
        field_value: Array.isArray(values[k])
          ? JSON.stringify(values[k].map((option_id) => ({ option_id })))
          : values[k],
      }));
    if (fields.length) await client("workitem", "update", { ...params, fields });
  }
  async function transition(from: string, to: string) {
    const live = await client("workflow", "list-state-transitions", { ...params, work_item_type: "issue" });
    if (live.state_key !== from) throw new Error("缺陷状态已变化，等待重新核对");
    const action = live.transition?.filter((a: { state_key: string }) => a.state_key === to);
    if (action?.length !== 1 || !action[0].id) throw new Error(`当前缺陷不能从 ${from} 转为 ${to}`);
    try {
      await client("workflow", "transition-state", { ...params, transition_id: String(action[0].id) });
    } catch (err) {
      if ((await read()).status !== to) throw err;
      return;
    }
    if ((await read()).status !== to) throw new Error("未读回目标状态，等待重新核对");
  }
  type Comment = { content: string; creator: string; created_at: number | string };
  async function comments() {
    const rows: Comment[] = [];
    for (let n = 1; ; n++) {
      const j = await client("comment", "list", { ...params, page_num: n });
      if (!Array.isArray(j.comments) || !Number.isSafeInteger(j.pagination?.total_pages))
        throw new Error("无法核对缺陷评论");
      rows.push(...j.comments);
      if (n >= j.pagination.total_pages) return rows;
    }
  }
  return {
    read,
    fillResolution,
    transition,
    commentExists: async (marker: string, me: string) =>
      (await comments()).some((r) => r.creator === me && r.content.trimEnd().endsWith(marker)),
    feedback: async (people: string[], after: number) =>
      (await comments())
        .filter(
          (r) =>
            people.includes(r.creator) &&
            Number(
              new Date(
                typeof r.created_at === "string" && /^\d+$/.test(r.created_at) ? Number(r.created_at) : r.created_at,
              ),
            ) >= after &&
            !/跟进记录 \d+\/MR\d+\//.test(r.content),
        )
        .slice(-4)
        .map((r) => r.content)
        .join("\n")
        .slice(-1700),
    addComment: (content: string, users: string[]) =>
      client("comment", "add", {
        ...params,
        content,
        ...(users.length ? { notify_user_type: "user_key", notify_user_list: users } : {}),
      }),
  };
}
