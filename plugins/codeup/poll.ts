import { loadProject, subjectFor } from "./runtime.ts";
import { Codeup } from "./api.ts";
import { remoteHead } from "./git.ts";
import { receiptBlock } from "../delivery/input.ts";

const [registry, id] = process.argv.slice(2);
try {
  const p = loadProject(registry, id),
    api = new Codeup(p, process.env[p.tokenEnv] ?? "");
  const events = [];
  for (const mr of await api.mrs()) {
    if (mr.targetBranch !== p.branch || !String(mr.sourceBranch).startsWith("autoloop/")) continue;
    const sha = remoteHead(p, mr.sourceBranch);
    events.push({
      id: `poll-${id}-${mr.localId}-${sha}`,
      type: "delivery.requested",
      subject: subjectFor(p, mr.localId),
      summary: "Codeup MR 等待交付",
    });
  }
  console.log(`发现 ${events.length} 项待交付 MR\n${receiptBlock({ events })}`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
