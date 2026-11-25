import { loadProject, context, runDelivery, numberFor } from "./runtime.ts";
import { receiptBlock } from "../delivery/input.ts";

import { transientFailure } from "./api.ts";

let about = "恢复本项目交付，不重新开发";
try {
  const [registry, id] = process.argv.slice(2);
  if (!registry || !id) throw new Error("用法：run.ts <项目登记文件> <项目编号>");
  const p = loadProject(registry, id),
    c = context();
  about = JSON.stringify({ kind: "codeup-recovery", project: id, mr: numberFor(p, c) });
  console.log(await runDelivery(p, c));
} catch (error) {
  if (transientFailure(error)) {
    console.error("云效暂时不可用，交付状态已保留，等待中台重试");
    process.exitCode = 1;
  } else
    console.log(
      `待你处理：${(error as Error).message}\n${receiptBlock({ ask: [{ key: "codeup-setup", title: "Codeup 接入需要处理", text: (error as Error).message, options: ["已配置，继续", "暂不处理"], about }] })}`,
    );
}
