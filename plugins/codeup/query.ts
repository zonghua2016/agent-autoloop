import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { State } from "./delivery.ts";

export type WorkRecord = { mr?: number; branch: string; gate?: State };

/** A detached, read-only delivery view. Storage keys stay inside the owning plugin. */
export function deliveryRecord(home: string, project: string, subject: string) {
  const file = join(home, "codeup.db");
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const query = db.prepare("SELECT data FROM codeup_items WHERE key=?");
    const get = (id: string) => JSON.parse(String(query.get(id)?.data ?? "null"));
    const key = project + ":" + subject;
    const work: WorkRecord | null = get("work:" + key);
    if (!work) return;
    if (!work.mr) return { work };
    if (!Number.isSafeInteger(work.mr) || work.mr < 1 || get(`mr:${project}:${work.mr}`) !== key)
      throw new Error("MR 绑定待核实");
    const state: State = get(`delivery:${project}:${work.mr}`) ?? {};
    return { work, state };
  } finally {
    db.close();
  }
}
