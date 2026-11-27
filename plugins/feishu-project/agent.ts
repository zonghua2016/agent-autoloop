import { join } from "node:path";
import { stablePath } from "../../host/node-path.ts";
import type { Adapter } from "../../worker/agents.ts";
import command from "../command/agent.ts";

export default {
  command: (turn) => {
    const args = turn.command ?? [];
    if (!args[0] || !(args.length === 1 || (args.length === 2 && args[1] === "receipt")))
      throw new Error("飞书项目插件需要一份个人配置文件，可追加 receipt 使用中台回执");
    return [stablePath(process.execPath), join(import.meta.dirname, "run.ts"), args[0], args[1] ?? "poll"];
  },
  read: command.read,
} satisfies Adapter;
