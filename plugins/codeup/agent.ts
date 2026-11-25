import { join } from "node:path";
import { stablePath } from "../../host/node-path.ts";
import command from "../command/agent.ts";
import type { Adapter } from "../../worker/agents.ts";

export default {
  command: (turn) => [stablePath(process.execPath), join(import.meta.dirname, "run.ts"), ...(turn.command ?? [])],
  read: command.read,
} satisfies Adapter;
