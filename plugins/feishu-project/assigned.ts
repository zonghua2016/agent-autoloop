// Query the role rather than the reporter's view. Subsequent pages belong to the same MQL session.
import type { Call } from "./items.ts";
export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export async function assignedIssueIds(space: string, ownerKey: string, call: Call, states: string[]) {
  const meta = record(await call("workitem", "meta-roles", { project_key: space, work_item_type: "issue" }));
  const role = Array.isArray(meta.list) ? meta.list.map(record).find((r) => r.role_id === ownerKey) : undefined;
  if (typeof role?.role_name !== "string" || !/^[\p{L}\p{N}_ -]+$/u.test(role.role_name))
    throw new Error("飞书缺陷经办人角色无法用于查询");
  // Exotic custom state names still work through the detailed local check.
  const filter =
    states.length && states.every((s) => /^[\p{L}\p{N} _-]+$/u.test(s))
      ? " AND (" + states.map((s) => "`work_item_status` = '" + s + "'").join(" OR ") + ")"
      : "";
  const mql =
    `SELECT \`work_item_id\` FROM \`${space}\`.\`issue\` WHERE array_contains(\`__${role.role_name}\`, current_login_user())` +
    filter;
  let page = record(await call("workitem", "query", { project_key: space, mql }));
  const session = page.session_id;
  if (typeof session !== "string" || !session || page.search_status_info) throw new Error("飞书未确认经办人查询结果");
  if (
    page.list === null &&
    page.data &&
    typeof page.data === "object" &&
    !Array.isArray(page.data) &&
    !Object.keys(page.data).length
  )
    return [];
  const group = Array.isArray(page.list) && page.list.length === 1 ? record(page.list[0]) : {};
  const count = group?.count,
    infos = group?.group_infos;
  const key = Array.isArray(infos) && infos.length === 1 && record(infos[0]).group_id;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 || typeof key !== "string" || !key)
    throw new Error("飞书缺陷查询分页信息无效");
  const ids = new Set<string>();
  for (let n = 1; ; n++) {
    const rows = record(page.data)[key];
    if (!Array.isArray(rows)) throw new Error("飞书缺陷查询未返回工作项");
    const before = ids.size;
    for (const row of rows) {
      const fields = record(row).moql_field_list;
      const value =
        Array.isArray(fields) &&
        record(record(fields.map(record).find((f) => f.key === "work_item_id")).value).long_value;
      if (
        !(typeof value === "string" && /^[1-9]\d*$/.test(value)) &&
        !(typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      )
        throw new Error("飞书查询返回的缺陷编号无效");
      ids.add(String(value));
    }
    if (ids.size === count) return [...ids];
    if (ids.size === before || ids.size > count) throw new Error("飞书缺陷查询分页数量不一致");
    page = record(
      await call("workitem", "query", {
        project_key: space,
        session_id: session,
        group_pagination_list: [{ group_id: key, page_num: n + 1 }],
      }),
    );
    if (page.search_status_info || (page.session_id && page.session_id !== session))
      throw new Error("飞书缺陷查询会话已变化");
  }
}
