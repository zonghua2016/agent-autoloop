import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { hubClient } from "../../protocol/client.ts";
import { parseResult, type EventInput, type Later } from "../../protocol/validate.ts";
import { receiptBlock } from "../delivery/input.ts";
import { personalItems, eventsFor, type Settings } from "./items.ts";

export function meegle(program = "meegle") {
  const script = /\.[cm]?js$/i.test(program);
  return async (resource: string, method: string, params: Record<string, unknown>) => {
    const args = [
      ...(script ? [program] : []),
      resource,
      method,
      ...(Object.keys(params).length ? ["--params", JSON.stringify(params)] : []),
      "--format",
      "json",
    ];
    let stdout: string;
    try {
      ({ stdout } = await promisify(execFile)(script ? process.execPath : program, args, {
        timeout: 45000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, MEEGLE_HOST: "project.feishu.cn", MEEGLE_NO_UPDATE_CHECK: "1" },
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("未找到飞书官方 meegle 客户端，请安装或在 cli 填写可执行文件路径");
      throw new Error(`飞书项目 ${resource} ${method} 未成功，请检查 meegle auth status、MCP 读取权限及字段映射`);
    }
    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error("飞书官方客户端未返回 JSON");
    }
  };
}
export async function publish(
  events: EventInput[],
  send: (event: EventInput) => Promise<{ event: number; duplicate: boolean; routed: string[] }>,
) {
  let count = 0;
  for (const event of events) {
    const ack = await send(event);
    if (!Number.isSafeInteger(ack?.event) || typeof ack.duplicate !== "boolean" || !Array.isArray(ack.routed))
      throw new Error("中台没有确认事件，下次按同一编号重试");
    if (!ack.routed.length)
      throw new Error("中台已记录事项但没有接单规则，请核对来源、事件类型和规则暂停状态，并在中台复查该事件");
    if (!ack.duplicate) count++;
  }
  return count;
}
export function pollReceipt(events: EventInput[], context: { timers?: Later[]; waiting?: Later[] }) {
  const key = "feishu-project-batch";
  const cursor = [...(context.timers ?? []), ...(context.waiting ?? [])].find((t) => t.key === key)?.about;
  const pending = events
    .filter((e) => !cursor || e.id > cursor)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!pending.length && !cursor) return "没事可做：没有符合开工条件的本人工作项";
  const batch: EventInput[] = [];
  let bytes = 0;
  for (const event of pending) {
    const size = Buffer.byteLength(receiptBlock(event));
    if (batch.length === 100 || bytes + size > 128 * 1024) break;
    batch.push(event);
    bytes += size;
  }
  const later =
    batch.length < pending.length
      ? [{ key, at: new Date(Date.now() + 60000).toISOString(), about: batch.at(-1)!.id }]
      : cursor
        ? [{ key, cancel: true }]
        : undefined;
  const receipt = { events: batch, later };
  parseResult({ outcome: "done", ...receipt });
  return `发现 ${batch.length} 条符合开工条件的本人工作项\n${receiptBlock(receipt)}`;
}
export async function run(config: Settings, op: string) {
  if (!["list", "poll", "receipt"].includes(op))
    throw new Error("请选择 list（个人清单）、poll（直接同步）或 receipt（定时任务回执）");
  const call = meegle(config.cli);
  if (op === "list") return JSON.stringify(await personalItems(config, call), null, 2);
  if (!config.profile?.userKey?.trim()) throw new Error("定时同步前请用 profile.userKey 绑定本人账号");
  if (op === "receipt") {
    const events = eventsFor(await personalItems(config, call, true));
    const path = process.env.AGENT_AUTOLOOP_CONTEXT;
    return pollReceipt(events, path ? JSON.parse(readFileSync(path, "utf8")) : {});
  }
  const target = config.hub;
  const token = target && process.env[target.keyEnv];
  if (!target || !token) throw new Error("定时同步需要配置中台地址及专用来源密钥的环境变量");
  const items = await personalItems(config, call, true);
  const count = await publish(eventsFor(items), hubClient(target.url, token).event);
  return count ? `已派发 ${count} 条本人工作项` : "没事可做：没有新的本人工作项";
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    const [fileOrOp, operation] = process.argv.slice(2);
    const useDefault = !fileOrOp || ["list", "poll", "receipt"].includes(fileOrOp);
    const file = useDefault ? join(homedir(), ".config", "agent-autoloop", "feishu-project.json") : fileOrOp;
    console.log(await run(JSON.parse(readFileSync(file, "utf8")), (useDefault ? fileOrOp : operation) ?? "list"));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
