import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLine } from "../../host/command.ts";
import { adapterFor } from "../../worker/agents.ts";

export type JsonAgent = { use: string; program?: string; model?: string; command?: string[]; effort?: string };
export type ModelImage = { bytes: Buffer; extension: "png" | "jpg" | "webp" | "gif" };

export function modelEnvironment(credentials: string[] = []) {
  const allowed = new Set([
    "PATH",
    "USER",
    "LOGNAME",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "APPDATA",
    "LOCALAPPDATA",
    ...credentials,
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.has(key) && !key.startsWith("AGENT_AUTOLOOP_")),
  );
}

export class ModelsUnavailable extends Error {
  constructor(operation: string, names: string[], failures: string[] = []) {
    super(
      `${operation}：${names.length ? `所有候选模型均未返回结果（${names.join(" → ")}）` : "没有其他可用模型"}${failures.length ? `；${failures.join("；")}` : ""}`,
    );
  }
}

function failureReason(error: unknown) {
  // Child-process errors can contain full prompts and stderr; only expose known codes, never their messages.
  if (error instanceof SyntaxError) return "JSON 格式无效";
  if (!error || typeof error !== "object") return "调用或结果校验失败";
  const { code, killed } = error as { code?: unknown; killed?: boolean };
  if (typeof code === "number" && Number.isSafeInteger(code)) return `进程退出 ${code}`;
  if (["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ABORT_ERR"].includes(String(code)))
    return String(code);
  return killed ? "进程超时或被终止" : "调用或结果校验失败";
}

export async function firstAvailable<Name extends string, T>(
  operation: string,
  names: Name[],
  attempt: (name: Name) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const failures: string[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    try {
      return await attempt(name);
    } catch (error) {
      signal?.throwIfAborted();
      failures.push(`${name}: ${failureReason(error)}`);
    }
  }
  signal?.throwIfAborted();
  throw new ModelsUnavailable(operation, names, failures);
}

export async function readJson(
  config: JsonAgent,
  input: unknown,
  instructions: (file: string, image?: string) => string,
  options: {
    env: NodeJS.ProcessEnv;
    timeout: number;
    signal?: AbortSignal;
    requireFinished?: boolean;
    image?: ModelImage;
  },
): Promise<unknown> {
  const folder = mkdtempSync(join(tmpdir(), "autoloop-model-"));
  try {
    const file = join(folder, "input.json");
    writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    const image = options.image && join(folder, `image.${options.image.extension}`);
    if (image) writeFileSync(image, options.image!.bytes, { mode: 0o600 });
    const adapter = await adapterFor(config.use);
    const argv = adapter.command({
      ...config,
      cwd: folder,
      folder,
      contextFile: file,
      session: randomUUID(),
      resume: null,
      access: "read",
      prompt: instructions(file, image),
    });
    if (image && config.use === "codex") argv.splice(-1, 0, "--image", image, "--");
    const { env, timeout, signal, requireFinished } = options;
    const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile(
        ...commandLine(argv),
        { cwd: folder, env, timeout, signal, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
        (error, stdout, stderr) => (error ? reject(error) : resolve({ stdout, stderr })),
      );
      child.stdin?.on("error", () => {});
      child.stdin?.end();
    });
    const answer = adapter.read(result.stdout, 0, result.stderr);
    if (answer.error || !answer.text || (requireFinished && !answer.finished)) throw new Error("模型未返回有效结果");
    return JSON.parse(
      answer.text
        .trim()
        .replace(/^```(?:json)?\s*/, "")
        .replace(/\s*```$/, ""),
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
