import { execFile } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandLine } from "../../host/command.ts";
import type { ModelImage } from "../command/model.ts";
import type { Message } from "./inbox.ts";

export async function readMessageImage(program: string, message: Message, signal: AbortSignal): Promise<ModelImage> {
  let key = message.content;
  if (key.startsWith("{")) key = JSON.parse(key).image_key;
  else key = /^\[Image:\s*(img_[a-zA-Z0-9_-]+)\]$/.exec(key)?.[1] ?? key;
  if (typeof key !== "string" || !/^img_[a-zA-Z0-9_-]+$/.test(key)) throw new Error("飞书消息没有可读取的图片标识");
  const cwd = mkdtempSync(join(tmpdir(), "autoloop-feishu-image-"));
  const name = "incoming.bin";
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        ...commandLine([
          program,
          "im",
          "+messages-resources-download",
          "--as",
          "bot",
          "--message-id",
          message.message_id,
          "--file-key",
          key,
          "--type",
          "image",
          "--output",
          name,
        ]),
        { cwd, signal, timeout: 30_000, maxBuffer: 256 * 1024 },
        (error) => (error ? reject(error) : resolve()),
      );
    });
    const file = join(cwd, name);
    const info = lstatSync(file);
    if (!info.isFile() || info.size < 12 || info.size > 10 * 1024 * 1024) throw new Error("飞书图片大小无效");
    const bytes = readFileSync(file);
    if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return { bytes, extension: "png" };
    if (bytes.subarray(0, 3).toString("hex") === "ffd8ff") return { bytes, extension: "jpg" };
    if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP")
      return { bytes, extension: "webp" };
    if (/^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return { bytes, extension: "gif" };
    throw new Error("飞书图片格式不受支持");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
