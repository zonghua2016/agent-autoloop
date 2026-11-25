// Optional chat intake alongside the existing card channel. Both consumers share lark-cli's one event bus connection.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { commandLine } from "../../host/command.ts";
import { HOME } from "../../host/home.ts";
import { eachLine } from "../../host/lines.ts";
import { hubClient } from "../../protocol/client.ts";
import feishu from "../feishu/channel.ts";
import { createInbox, TaskStore, type TaskConfig } from "./inbox.ts";
import { interpretMessage, parseTask, type ParserConfig } from "./parser.ts";
import { readMessageImage } from "./image.ts";
import type { Config as PersonalConfig } from "../personal/run.ts";
import { renderProposal } from "./card.ts";

import type { ResultConfig } from "../codeup/task-result.ts";

export type InboxConfig = TaskConfig & {
  url: string;
  sourceKey: string;
  parser: ParserConfig;
  modelRouting?: boolean;
  database?: string;
  delivery?: ResultConfig;
  personal?: { owner: string; config: string; rules?: string[] };
};

export async function runInbox(
  config: InboxConfig,
  program: string,
  log: ChannelContext["log"],
  signal: AbortSignal,
  registerAction?: (handler: (event: unknown) => boolean) => void,
  registerDelivered?: (handler: (card: Card, ref: string, owner: string) => void) => void,
) {
  if (!config.url || !config.sourceKey || !config.parser) throw new Error("飞书任务入口缺少中台来源或解析器配置");
  const stop = new AbortController();
  signal = AbortSignal.any([signal, stop.signal]);
  const store = new TaskStore(config.database ?? join(HOME, "feishu-tasks.db"));
  try {
    const source = hubClient(config.url, config.sourceKey);
    const lark = (args: string[], input: object, timeout = 60_000) =>
      new Promise<any>((resolve, reject) => {
        const child = execFile(
          ...commandLine([program, ...args]),
          { encoding: "utf8", timeout, signal },
          (error, stdout) => {
            if (error) return reject(new Error("飞书消息回复失败，请检查 CLI 权限和连接"));
            try {
              const result = JSON.parse(stdout);
              if (result.ok === false || result.error) throw new Error("飞书未接受消息回复");
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
        );
        child.stdin!.on("error", () => {});
        child.stdin!.end(JSON.stringify(input));
      });
    const personal = config.personal;
    const personalConfig: PersonalConfig | undefined = personal
      ? JSON.parse(readFileSync(personal.config, "utf8"))
      : undefined;
    const runPersonal = personalConfig ? (await import("../personal/run.ts")).run : undefined;
    const codeupTaskResults = config.delivery
      ? (await import("../codeup/task-result.ts")).codeupTaskResults
      : undefined;
    const personalRules = new Set(personal?.rules ?? ["private morning", "private care", "private 巡检"]);
    registerDelivered?.((card, ref, owner) => {
      if (owner !== personal?.owner || card.kind !== "notice" || !card.rule || !personalRules.has(card.rule)) return;
      const message = store.ownerMessage(owner);
      if (message) store.outbound(message, ref, [card.title, card.text].filter(Boolean).join("\n"));
    });
    const inbox = createInbox(config, store, {
      reaction: async (message, previous) => {
        const base = `/open-apis/im/v1/messages/${encodeURIComponent(message)}/reactions`;
        const response = await lark(
          [
            "api",
            previous ? "DELETE" : "POST",
            base + (previous ? "/" + encodeURIComponent(previous) : ""),
            "--as",
            "bot",
            "--data",
            "-",
          ],
          previous ? {} : { reaction_type: { emoji_type: "OnIt" } },
          3000,
        );
        return previous ? undefined : response.data?.reaction_id;
      },
      delivery:
        config.delivery &&
        codeupTaskResults!(config.delivery, HOME, log, { url: config.url, sourceKey: config.sourceKey }),
      ...(personal &&
        personalConfig && {
          personal: async (message, query) =>
            message.sender_id === personal.owner
              ? runPersonal!(
                  personalConfig,
                  "chat",
                  [],
                  {
                    conversation: store.conversation(message),
                    events: [
                      {
                        id: message.message_id,
                        type: "personal.chat",
                        subject: "private",
                        summary: "个人聊天",
                        detail: query,
                      },
                    ],
                  },
                  new Date().toISOString(),
                  undefined,
                  signal,
                )
              : undefined,
        }),
      parse: (input) => parseTask(input, config.parser, signal),
      ...(config.modelRouting && {
        interpret: async (input, _message, selected, image) =>
          interpretMessage(
            input,
            config.parser,
            signal,
            image ? await readMessageImage(program, image, signal) : undefined,
            selected,
          ),
      }),
      dispatch: (event) => source.event(event),
      outcome: async (event) => {
        const response = await fetch(`${config.url.replace(/\/$/, "")}/v1/events/${event}`, {
          headers: { authorization: `Bearer ${config.sourceKey}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        if (!response.ok) throw new Error(`任务结果查询失败：${response.status}`);
        return response.json();
      },
      reply: async (message, text, key, proposal) => {
        const result = await lark(
          ["api", "POST", `/open-apis/im/v1/messages/${message}/reply`, "--as", "bot", "--data", "-"],
          {
            msg_type: proposal ? "interactive" : "text",
            content: JSON.stringify(proposal ? renderProposal(proposal) : { text }),
            uuid: key,
          },
        );
        const ref = result.data?.message_id;
        if (typeof ref !== "string" || !ref.startsWith("om_")) throw new Error("飞书回复没有返回消息编号");
        return ref;
      },
      updateProposal: async (ref, proposal) => {
        await lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], {
          content: JSON.stringify(renderProposal(proposal)),
        });
      },
    });
    registerAction?.(inbox.action);
    async function listen() {
      while (!signal.aborted) {
        const child = spawn(...commandLine([program, "event", "consume", "im.message.receive_v1", "--as", "bot"]), {
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.on("error", () => log("飞书收消息进程无法启动，请检查 lark-cli 路径"));
        const stop = () => child.kill();
        signal.addEventListener("abort", stop, { once: true });
        eachLine(child.stderr, log);
        eachLine(child.stdout, (line) => {
          try {
            if (inbox.receive(JSON.parse(line))) log("收到一条已授权的飞书任务消息");
          } catch {
            log("飞书消息没有保存成功，未派发任务");
          }
        });
        if (signal.aborted) child.kill();
        await new Promise((resolve) => child.on("close", resolve));
        signal.removeEventListener("abort", stop);
        if (!signal.aborted) await delay(10_000, undefined, { signal }).catch(() => {});
      }
    }
    async function work() {
      const jobs = new Set<Promise<void>>();
      while (!signal.aborted) {
        const job = inbox
          .tick()
          .catch((error) => {
            if (!signal.aborted) log(`飞书任务入口等待恢复：${(error as Error).message}`);
          })
          .finally(() => jobs.delete(job));
        jobs.add(job);
        if (!signal.aborted) await delay(300, undefined, { signal }).catch(() => {});
      }
      await Promise.allSettled(jobs);
    }
    async function extract() {
      while (!signal.aborted) {
        if (personalConfig && runPersonal)
          try {
            await runPersonal(personalConfig, "extract", [], {}, new Date().toISOString(), undefined, signal);
          } catch {
            log("个人记忆提取暂不可用，保留记录稍后重试");
          }
        await delay(30_000, undefined, { signal }).catch(() => {});
      }
    }
    const jobs = [listen(), work(), extract()];
    try {
      await Promise.all(jobs);
    } finally {
      stop.abort();
      await Promise.allSettled(jobs);
      await inbox.drain();
    }
  } finally {
    store.close();
  }
}

export default async function channel(context: ChannelContext) {
  const tasks = context.options.tasks as InboxConfig | undefined;
  if (!tasks) return feishu(context);
  const stop = new AbortController();
  const signal = AbortSignal.any([context.signal, stop.signal]);
  let action: (event: unknown) => boolean = () => false;
  let delivered: (card: Card, ref: string, owner: string) => void = () => {};
  const ready = Promise.withResolvers<void>();
  const jobs = [
    runInbox(
      tasks,
      (context.options.lark as string | undefined) ?? "lark-cli",
      context.log,
      signal,
      (handler) => {
        action = handler;
        ready.resolve();
      },
      (handler) => {
        delivered = handler;
      },
    ).catch((error) => {
      ready.reject(error);
      throw error;
    }),
    ready.promise.then(() =>
      feishu(
        { ...context, signal },
        (event) => action(event),
        (card, ref, owner) => delivered(card, ref, owner),
      ),
    ),
  ];
  try {
    await Promise.all(jobs);
  } finally {
    stop.abort();
    await Promise.allSettled(jobs);
  }
}
