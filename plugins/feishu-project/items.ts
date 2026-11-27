import { assignedIssueIds, record as obj } from "./assigned.ts";
import { createHash } from "node:crypto";
import { parseEvent } from "../../protocol/validate.ts";
import { fitJson } from "../command/json.ts";

type Kind = "issue" | "story";
type Role = { storyOwner: string; issuePlatforms: string[] };
type Project = {
  businessLine?: string;
  issueIds?: string[];
  assignedIssueSpace?: string;
  issueView?: string;
  storyView?: string;
  ready?: Partial<Record<Kind, string[]>>;
};
type Fields = {
  line: string;
  issueOwner: string;
  platform: string;
  description: string;
};
export type Settings = {
  cli?: string;
  hub?: { url: string; keyEnv: string };
  profile: { userKey?: string; role: string; projects: string[] | "*"; match?: "owner" | "role" };
  projects?: Record<string, Project>;
  roles?: Record<string, Role>;
  views?: Partial<Record<Kind, string>>;
  fields?: Partial<Fields>;
};
export type Call = (
  resource: "user" | "view" | "workitem",
  method: "me" | "get" | "meta-fields" | "meta-roles" | "query",
  params: Record<string, unknown>,
) => Promise<unknown>;
type Item = {
  id: string;
  kind: Kind;
  project?: string;
  space: string;
  title: string;
  link: string;
  status: string;
  detail: string;
  ready: boolean;
};
const word = (v: unknown): v is string => typeof v === "string" && !!v.trim() && v === v.trim();
const words = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every(word);

function scopeForProfile(c: Settings) {
  const profile = c.profile;
  if (
    !profile ||
    (profile.projects !== "*" && !words(profile.projects)) ||
    (profile.match !== undefined && !["owner", "role"].includes(profile.match)) ||
    !word(profile.role) ||
    (profile.userKey !== undefined && !word(profile.userKey))
  )
    throw new Error("请配置本人职务和负责的项目；用户标识可留空以使用登录账号");
  const defaults: Record<string, Role> = Object.fromEntries(
    [
      ["前端", "fe"],
      ["后端", "server"],
      ["iOS", "ios"],
      ["Android", "android"],
    ].map(([name, key]) => [name, { storyOwner: key, issuePlatforms: [key] }]),
  );
  const roles = { ...defaults, ...c.roles };
  const roleName = Object.keys(roles).find((k) => k.toLowerCase() === profile.role.toLowerCase());
  const role = roleName && roles[roleName];
  if (!role || !word(role.storyOwner) || !words(role.issuePlatforms))
    throw new Error("职务缺少需求人员角色或缺陷所属端映射");
  const fields: Fields = {
    line: "business",
    issueOwner: "operator",
    platform: "bug_classification",
    description: "description",
    ...c.fields,
  };
  if (!Object.values(fields).every(word)) throw new Error("飞书字段配置不能为空");
  const views = new Map<string, View>();
  function add(kind: Kind, link: string | undefined, route?: Route) {
    if (link === undefined) return;
    const url = new URL(link),
      match = /^\/([\w-]+)\/(issue|story)View\/([\w-]+)\/?$/.exec(url.pathname);
    if (url.origin !== "https://project.feishu.cn" || url.username || url.password || !match || match[2] !== kind)
      throw new Error("请填写对应类型的飞书项目视图链接");
    const key = url.origin + url.pathname.replace(/\/$/, "");
    const view: View = views.get(key) ?? { kind, space: match[1], view: match[3], routes: [] };
    if (route) view.routes.push(route);
    views.set(key, view);
  }
  if (profile.projects === "*") for (const kind of ["issue", "story"] as const) add(kind, c.views?.[kind]);
  const projects = profile.projects === "*" ? Object.keys(c.projects ?? {}) : profile.projects;
  for (const project of new Set(projects)) {
    const p = c.projects?.[project];
    if (p?.assignedIssueSpace !== undefined) {
      const space = p.assignedIssueSpace;
      if (
        !/^[a-z][a-z0-9-]{0,30}$/.test(project) ||
        typeof space !== "string" ||
        !/^[\w-]+$/.test(space) ||
        p.businessLine !== undefined ||
        p.issueIds !== undefined ||
        p.issueView !== undefined ||
        p.storyView !== undefined ||
        p.ready?.story !== undefined
      )
        throw new Error("全空间经办人查询需单独登记空间和开发目标");
      const ready = p.ready?.issue ?? [];
      if (!Array.isArray(ready) || !ready.every(word) || views.has("assigned:" + space))
        throw new Error("经办人查询的开工状态或项目映射无效");
      views.set("assigned:" + space, { kind: "issue", space, view: "", assigned: true, routes: [{ project, ready }] });
      continue;
    }
    if (
      !/^[a-z][a-z0-9-]{0,30}$/.test(project) ||
      !p ||
      !(p.issueView || p.storyView || c.views?.issue || c.views?.story)
    )
      throw new Error("负责的项目需要登记业务线和需求或缺陷视图");
    if (p.issueIds !== undefined) {
      if (
        p.businessLine !== undefined ||
        !word(p.issueView) ||
        !Array.isArray(p.issueIds) ||
        !p.issueIds.every((id) => typeof id === "string" && /^[1-9]\d*$/.test(id)) ||
        p.storyView !== undefined ||
        p.ready?.story !== undefined
      )
        throw new Error("按缺陷编号登记时，请指定缺陷视图和编号列表，不能同时登记业务线或需求");
    } else if (!word(p.businessLine)) throw new Error("请登记业务线或验收缺陷编号");
    for (const kind of ["issue", "story"] as const) {
      if (p.issueIds !== undefined && kind !== "issue") continue;
      const ready = p.ready?.[kind] ?? [];
      if (!Array.isArray(ready) || !ready.every(word)) throw new Error("允许同步的状态应为名称列表");
      add(kind, p[kind === "issue" ? "issueView" : "storyView"] ?? c.views?.[kind], {
        project,
        line: p.businessLine,
        ids: p.issueIds,
        ready,
      });
    }
  }
  if (!views.size) throw new Error("请登记至少一个飞书项目视图");
  return { fields, role, views, all: profile.projects === "*", owner: profile.match !== "role" };
}
type Route = { project: string; line?: string; ids?: string[]; ready: string[] };
type View = { kind: Kind; space: string; view: string; assigned?: boolean; routes: Route[] };

function lineId(options: unknown[], value: string) {
  const matches = options.map(obj).filter((o) => o.option_id === value || o.option_name === value);
  if (matches.length !== 1 || !word(matches[0].option_id))
    throw new Error("业务线名称或标识无法唯一匹配，请核对项目登记");
  return matches[0].option_id;
}
function selection(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap((x) =>
    typeof x === "string" ? [x] : [obj(x).value].filter(word),
  );
}
async function projectRoutes(v: View, fields: Fields, call: Call) {
  const byLine = new Map<string, Route>();
  const lines = v.routes.filter((r) => r.line !== undefined);
  if (!lines.length) return byLine;
  const metadata = obj(
    await call("workitem", "meta-fields", {
      project_key: v.space,
      work_item_type: v.kind,
      page_num: 1,
      field_keys: [fields.line],
    }),
  );
  const field = Array.isArray(metadata.list)
    ? metadata.list.map(obj).find((f) => f.field_key === fields.line)
    : undefined;
  if (!Array.isArray(field?.option)) throw new Error("业务线字段配置不可读，请核对字段标识和读取权限");
  for (const route of lines) {
    const id = lineId(field.option, route.line!);
    if (byLine.has(id)) throw new Error("同一视图的业务线对应多个项目，请核对登记");
    byLine.set(id, route);
  }
  return byLine;
}
function hasMember(value: unknown, me: string) {
  return (Array.isArray(value) ? value : [value]).some((user) => obj(user).key === me);
}
async function readView(
  v: View,
  me: string,
  scope: ReturnType<typeof scopeForProfile>,
  call: Call,
  forDispatch: boolean,
) {
  const { role, fields, all, owner } = scope;
  const byLine = await projectRoutes(v, fields, call);
  const requested = [
    fields.line,
    ...(owner ? ["current_status_operator"] : []),
    ...(v.kind === "issue" ? [fields.platform] : []),
  ];
  function checkedId(row: Record<string, unknown>) {
    const attr = obj(row.work_item_attribute),
      id = attr.work_item_id;
    if (
      typeof id !== "string" ||
      !/^\d+$/.test(id) ||
      obj(attr.owned_project).simple_name !== v.space ||
      obj(attr.work_item_type).key !== v.kind
    )
      throw new Error("工作项编号、空间或类型与视图不符");
    return id;
  }
  function classify(row: Record<string, unknown>, id: string): Item | undefined {
    const attr = obj(row.work_item_attribute);
    const members = Array.isArray(attr.role_members) ? attr.role_members.map(obj) : [];
    const assigned = members.some(
      (r) => r.key === (v.kind === "story" ? role.storyOwner : fields.issueOwner) && hasMember(r.members, me),
    );
    const f = new Map(
      (Array.isArray(row.work_item_fields) ? row.work_item_fields : []).map(obj).map((f) => [f.key, f.value]),
    );
    const current =
      hasMember(f.get("current_status_operator"), me) ||
      (Array.isArray(row.work_item_current_node) &&
        row.work_item_current_node.some((n) => hasMember(obj(n).owners, me)));
    const platformMatches =
      v.kind === "story" || selection(f.get(fields.platform)).some((p) => role.issuePlatforms.includes(p));
    if (owner && !v.assigned ? !(assigned || current) : !(assigned && platformMatches)) return;
    const matched = [
      ...new Set([
        ...v.routes.filter((r) => v.assigned || r.ids?.includes(id)),
        ...selection(f.get(fields.line))
          .map((line) => byLine.get(line))
          .filter((p) => p !== undefined),
      ]),
    ];
    if (!matched.length && !all) return;
    if (matched.length > 1) throw new Error("同一事项匹配多个项目，无法派发");
    const title = attr.work_item_name,
      status = obj(attr.work_item_status).name,
      description = f.get(fields.description);
    if (!word(title) || !word(status)) throw new Error("飞书工作项缺少名称或状态");
    return {
      id,
      kind: v.kind,
      project: matched[0]?.project,
      space: v.space,
      title,
      status,
      ready: assigned && platformMatches && (matched[0]?.ready.includes(status) ?? false),
      link: `https://project.feishu.cn/${v.space}/${v.kind}/detail/${id}`,
      detail: typeof description === "string" ? description : "",
    };
  }
  const seen = new Set<string>(),
    result = new Map<string, Item>();
  if (v.assigned) {
    if (forDispatch && !v.routes[0].ready.length) return [];
    for (const id of await assignedIssueIds(v.space, fields.issueOwner, call, forDispatch ? v.routes[0].ready : [])) {
      const row = obj(await call("workitem", "get", { project_key: v.space, work_item_id: id, fields: requested }));
      if (checkedId(row) !== id) throw new Error("飞书未返回指定的工作项");
      const item = classify(row, id);
      if (item) result.set(id, item);
    }
  } else
    for (let page = 1; ; page++) {
      const response = obj(
        await call("view", "get", { project_key: v.space, view_id: v.view, page_num: page, fields: requested }),
      );
      const rows = response.work_item_list,
        pagination = obj(response.pagination);
      if (
        !Array.isArray(rows) ||
        typeof pagination.has_more !== "boolean" ||
        (pagination.page_num !== undefined && pagination.page_num !== page)
      )
        throw new Error("无法核对飞书视图的工作项或分页");
      const previous = seen.size;
      for (const row of rows.map(obj)) {
        const id = checkedId(row);
        seen.add(id);
        const item = classify(row, id);
        if (item) result.set(id, item);
        else result.delete(id);
      }
      if (!pagination.has_more) break;
      if (previous === seen.size) throw new Error("飞书视图分页没有前进");
    }
  if (!forDispatch) return [...result.values()];
  const eligible = [];
  for (const listed of result.values()) {
    if (!listed.ready) continue;
    const latest = obj(
      await call("workitem", "get", {
        project_key: v.space,
        work_item_id: listed.id,
        fields: [...requested, fields.description],
      }),
    );
    if (checkedId(latest) !== listed.id) throw new Error("飞书未返回指定的工作项");
    const item = classify(latest, listed.id);
    if (item?.ready && item.project === listed.project) eligible.push(item);
  }
  return eligible;
}
export async function personalItems(config: Settings, call: Call, forDispatch = false) {
  const scope = scopeForProfile(config);
  const me = obj(await call("user", "me", {})).user_key;
  if (!word(me)) throw new Error("飞书未返回当前用户标识");
  if (config.profile.userKey && config.profile.userKey !== me) throw new Error("飞书当前登录身份与个人配置不一致");
  const result = new Map<string, Item>();
  for (const view of scope.views.values()) {
    for (const item of await readView(view, me, scope, call, forDispatch)) {
      const existing = result.get(item.link);
      if (existing?.project && item.project && existing.project !== item.project)
        throw new Error("同一工作项匹配多个本地项目，请核对业务线映射");
      if (!existing?.project || item.project) result.set(item.link, item);
    }
  }
  return [...result.values()];
}
export function eventsFor(items: Item[]) {
  return items
    .filter((x) => x.ready)
    .map((x) => {
      const id = createHash("sha256")
        .update(JSON.stringify([x.space, x.kind, x.id]))
        .digest("hex");
      return parseEvent({
        id,
        subject: "fp-" + id,
        type: x.project + (x.kind === "issue" ? ".bug" : ".feature"),
        summary: [...x.title].slice(0, 200).join(""),
        detail: fitJson({ title: x.title, description: x.detail, status: x.status }),
        link: x.link,
      });
    });
}
