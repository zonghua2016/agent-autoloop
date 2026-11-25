import type { Project } from "./settings.ts";

export class ApiError extends Error {
  status: number;
  method: string;
  constructor(status: number, method = "GET") {
    super(`云效 API 请求失败（HTTP ${status}），请核对权限和接口配置`);
    this.status = status;
    this.method = method;
  }
}
export class ReadError extends Error {
  constructor(cause: unknown) {
    super("云效读取暂时失败", { cause });
  }
}
export const transientFailure = (error: unknown): boolean => {
  if (error instanceof ApiError) return error.status === 408 || error.status === 429 || error.status >= 500;
  if (error instanceof Error)
    return (
      ["AbortError", "TimeoutError"].includes(error.name) ||
      /^(?:fetch failed|connect |socket |network )/i.test(error.message) ||
      transientFailure(error.cause)
    );
  return false;
};
export const wasRejected = (error: unknown) =>
  error instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(error.status);
export class Codeup {
  project: Project;
  token: string;
  request: typeof fetch;
  constructor(project: Project, token: string, request: typeof fetch = fetch) {
    if (!token) throw new Error(`缺少云效令牌，请配置环境变量 ${project.tokenEnv}`);
    this.project = project;
    this.token = token;
    this.request = request;
  }
  root(product: "codeup" | "flow") {
    return `/oapi/v1/${product}/organizations/${encodeURIComponent(this.project.organization)}`;
  }
  repo() {
    return `${this.root("codeup")}/repositories/${encodeURIComponent(this.project.repository)}`;
  }
  async call(path: string, body?: object, method = body === undefined ? "GET" : "POST"): Promise<any> {
    if (!path.startsWith("/oapi/v1/") || path.startsWith("//")) throw new Error("云效请求路径无效");
    const response = await this.request(new URL(path, this.project.api), {
      method,
      headers: { "x-yunxiao-token": this.token, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    }).catch((error) => {
      if (method === "GET") throw new ReadError(error);
      throw error;
    });
    if (!response.ok) throw new ApiError(response.status, method);
    if (response.status === 204) return null;
    return response.json();
  }
  async pages(path: string): Promise<any[]> {
    const result: any[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.call(`${path}${path.includes("?") ? "&" : "?"}page=${page}&perPage=100`);
      if (!Array.isArray(rows)) throw new Error("云效列表接口未返回数组");
      result.push(...rows);
      if (rows.length < 100) return result;
    }
  }
  mrs(state = "opened") {
    return this.pages(
      `${this.root("codeup")}/changeRequests?projectIds=${encodeURIComponent(this.project.repository)}&state=${state}`,
    );
  }
  mr(number: number) {
    return this.call(`${this.repo()}/changeRequests/${number}`);
  }
  checks(head: string) {
    return this.pages(`${this.repo()}/checkRuns?ref=${head}`);
  }
  async check(head: string, name: string, conclusion: string, summary: string) {
    if (!this.project.serviceUserId) throw new Error("项目缺少 serviceUserId，无法核对检查结果写入者");
    const externalId = `autoloop-${name}-${head}`;
    const existing = (await this.checks(head)).find(
      (c) => c.externalId === externalId && c.name === name && String(c.writer?.id) === this.project.serviceUserId,
    );
    const body = {
      name,
      externalId,
      headSha: head,
      status: "completed",
      conclusion,
      completedAt: new Date().toISOString(),
      output: { title: name, summary: summary.slice(0, 60000) },
    };
    return this.call(`${this.repo()}/checkRuns${existing ? `/${existing.id}` : ""}`, body);
  }
  flow(pipeline: string, run?: string) {
    return `${this.root("flow")}/pipelines/${pipeline}/runs${run ? `/${run}` : ""}`;
  }
}
