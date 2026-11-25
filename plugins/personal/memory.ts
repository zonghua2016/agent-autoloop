import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const kinds = [
  "raw",
  "daily",
  "monthly",
  "concept",
  "decision",
  "preference",
  "study",
  "dream",
  "experience",
  "todo",
  "care",
  "care-message",
  "feedback",
  "procedure",
  "plan-input",
  "plan-output",
] as const;
type Kind = (typeof kinds)[number];
export type Entry = {
  scope: string;
  kind: Kind;
  text: string;
  at: string;
  expires?: string;
  parents?: string[];
  approved?: boolean;
  tags?: string[];
  authorModel?: string;
  relations?: { target: string; type: string }[];
  vector?: number[];
  id?: string;
};
type Record = Entry & {
  id: string;
  approved: boolean;
  evaluation?: string;
  declined?: boolean;
  interval?: number;
  due?: string;
};

function tokens(text: string) {
  const words =
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
  const bigrams = [...text.normalize("NFKC").matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap((match) =>
    Array.from({ length: match[0].length - 1 }, (_, i) => match[0].slice(i, i + 2)),
  );
  return new Set([...words, ...bigrams]);
}
// Lexical vectors are local; a configured embedding can replace them when semantic recall is needed.
export function localVector(text: string) {
  const vector = Array<number>(256).fill(0);
  for (const word of tokens(text)) {
    let bucket = 0;
    for (const letter of word) bucket = (Math.imul(bucket, 31) + letter.codePointAt(0)!) >>> 0;
    vector[bucket % vector.length]++;
  }
  return vector;
}
function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;
  return a.reduce((n, x, i) => n + x * b[i], 0) / (Math.hypot(...a) * Math.hypot(...b)) || 0;
}
function timestamp(value: string) {
  return new Date(value).toISOString();
}

export class Memory implements Disposable {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS memory (scope TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(scope,id));
      CREATE TABLE IF NOT EXISTS provenance (scope TEXT, child TEXT, parent TEXT, PRIMARY KEY(scope,child,parent));
      CREATE TABLE IF NOT EXISTS planning (scope TEXT, subject TEXT, input TEXT NOT NULL, turn TEXT NOT NULL,
        waiting INTEGER NOT NULL, PRIMARY KEY(scope,subject));
      CREATE TABLE IF NOT EXISTS extraction (scope TEXT, parent TEXT, done INTEGER DEFAULT 0, PRIMARY KEY(scope,parent));
      CREATE TABLE IF NOT EXISTS extraction_failures (scope TEXT, parent TEXT, attempts INTEGER NOT NULL, PRIMARY KEY(scope,parent));`);
  }
  [Symbol.dispose]() {
    this.db.close();
  }
  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private write(row: Record) {
    this.db.prepare("INSERT OR REPLACE INTO memory VALUES (?, ?, ?)").run(row.scope, row.id, JSON.stringify(row));
  }
  private decode(data: unknown): Record {
    return JSON.parse(String(data));
  }
  get(scope: string, id: string, now: string) {
    const row = this.db.prepare("SELECT data FROM memory WHERE scope=? AND id=?").get(scope, id);
    if (!row) return;
    const item = this.decode(row.data);
    return !item.expires || item.expires > timestamp(now) ? item : undefined;
  }
  list(scope: string, now: string, kind?: Kind) {
    const date = timestamp(now);
    return this.db
      .prepare("SELECT data FROM memory WHERE scope=? ORDER BY rowid DESC")
      .all(scope)
      .map((row) => this.decode(row.data))
      .filter((row) => (!row.expires || row.expires > date) && (!kind || row.kind === kind))
      .sort((a, b) => b.at.localeCompare(a.at));
  }
  add(input: Entry) {
    return this.transaction(() => this.insert(input));
  }
  enqueue(scope: string, parent: string) {
    this.db.prepare("INSERT OR IGNORE INTO extraction(scope,parent) VALUES (?,?)").run(scope, parent);
  }
  pending(scope: string, now: string) {
    return this.db
      .prepare(
        `SELECT e.parent FROM extraction e JOIN memory m ON m.scope=e.scope AND m.id=e.parent
        WHERE e.scope=? AND e.done=0 AND (json_extract(m.data,'$.expires') IS NULL OR json_extract(m.data,'$.expires')>?)
        ORDER BY e.rowid LIMIT 5`,
      )
      .all(scope, timestamp(now))
      .map((row) => this.get(scope, String(row.parent), now))
      .filter((row): row is Record => !!row);
  }
  extracted(scope: string, parent: string) {
    this.transaction(() => {
      this.db.prepare("UPDATE extraction SET done=1 WHERE scope=? AND parent=?").run(scope, parent);
      this.db.prepare("DELETE FROM extraction_failures WHERE scope=? AND parent=?").run(scope, parent);
    });
  }
  deferExtraction(scope: string, parent: string) {
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO extraction_failures VALUES (?,?,1) ON CONFLICT(scope,parent) DO UPDATE SET attempts=attempts+1",
        )
        .run(scope, parent);
      const attempts = Number(
        this.db.prepare("SELECT attempts FROM extraction_failures WHERE scope=? AND parent=?").get(scope, parent)!
          .attempts,
      );
      if (attempts >= 3) {
        this.db.prepare("UPDATE extraction SET done=-1 WHERE scope=? AND parent=?").run(scope, parent);
        return;
      }
      this.db.prepare("DELETE FROM extraction WHERE scope=? AND parent=? AND done=0").run(scope, parent);
      if (this.db.prepare("SELECT 1 FROM memory WHERE scope=? AND id=?").get(scope, parent))
        this.enqueue(scope, parent);
    });
  }
  failedExtractions(scope: string) {
    return this.db
      .prepare(
        "SELECT e.parent,f.attempts FROM extraction e JOIN extraction_failures f ON f.scope=e.scope AND f.parent=e.parent WHERE e.scope=? AND e.done=-1",
      )
      .all(scope);
  }
  retryExtractions(scope: string) {
    return this.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM extraction_failures WHERE scope=? AND parent IN (SELECT parent FROM extraction WHERE scope=? AND done=-1)",
        )
        .run(scope, scope);
      return this.db.prepare("UPDATE extraction SET done=0 WHERE scope=? AND done=-1").run(scope).changes;
    });
  }
  plan(scope: string, subject: string, now: string) {
    const row = this.db
      .prepare("SELECT input, turn, waiting FROM planning WHERE scope=? AND subject=?")
      .get(scope, subject);
    const input = row && this.get(scope, String(row.input), now);
    return input && { input, turn: String(row!.turn), waiting: !!row!.waiting };
  }
  savePlan(scope: string, subject: string, input: string, turn: string, waiting: boolean) {
    this.db
      .prepare("INSERT OR REPLACE INTO planning VALUES (?, ?, ?, ?, ?)")
      .run(scope, subject, input, turn, Number(waiting));
  }
  private insert(input: Entry) {
    if (
      !/^[\w.-]{1,90}$/.test(input.scope) ||
      !kinds.includes(input.kind) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 100_000
    )
      throw new Error("记忆范围、种类或内容无效");
    if (input.kind === "care" && !input.expires) throw new Error("个人近况需指定到期时间");
    const at = timestamp(input.at);
    if (
      input.kind === "care" &&
      (Date.parse(input.expires!) <= Date.parse(at) || Date.parse(input.expires!) - Date.parse(at) > 90 * 86400_000)
    )
      throw new Error("个人近况须在 90 天内到期");
    if (
      input.vector &&
      (!Array.isArray(input.vector) || input.vector.length > 4096 || !input.vector.every(Number.isFinite))
    )
      throw new Error("记忆向量无效");
    const id = input.id ?? randomUUID();
    const stored = this.db.prepare("SELECT 1 FROM memory WHERE scope=? AND id=?").get(input.scope, id);
    if (stored) return id;
    const parents = [...new Set([...(input.parents ?? []), ...(input.relations ?? []).map((r) => r.target)])];
    let expires = input.expires ? timestamp(input.expires) : undefined;
    for (const parent of parents) {
      const origin = this.get(input.scope, parent, at);
      if (!origin) throw new Error("记忆来源不存在、已过期或不在同一范围");
      if (origin.expires && (!expires || origin.expires < expires)) expires = origin.expires;
    }
    this.write({
      ...input,
      id,
      at,
      expires,
      parents,
      approved: input.kind !== "experience" && input.kind !== "procedure" && !!input.approved,
      ...(input.kind === "study" || input.kind === "todo" ? { due: at, interval: 0 } : {}),
    });
    for (const parent of parents)
      this.db.prepare("INSERT INTO provenance VALUES (?, ?, ?)").run(input.scope, id, parent);
    return id;
  }
  search(scope: string, query: string, now: string, vector?: number[], limit = 12) {
    const q = tokens(query);
    return this.list(scope, now)
      .filter(
        (e) =>
          ![
            "dream",
            "experience",
            "procedure",
            "decision",
            "preference",
            "plan-input",
            "plan-output",
            "care-message",
          ].includes(e.kind) || e.approved,
      )
      .map((e) => {
        const words = tokens([e.text, ...(e.tags ?? [])].join(" "));
        const score = [...q].filter((word) => words.has(word)).length / Math.max(1, q.size);
        const age = Math.max(0, Date.parse(now) - Date.parse(e.at)) / 86400_000;
        const decay = ["preference", "decision"].includes(e.kind) ? 1 : 0.7 + 0.3 * Math.exp(-age / 90);
        return { e, score: (score + (vector && e.vector ? Math.max(0, cosine(vector, e.vector)) : 0)) * decay };
      })
      .filter((x) => (q.size ? x.score > 0 : true))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.e);
  }
  graph(scope: string, id: string, now: string) {
    const item = this.get(scope, id, now);
    if (!item) return;
    return {
      item,
      origins: (item.parents ?? []).map((parent) => this.get(scope, parent, now)).filter(Boolean),
      related: this.list(scope, now).filter((row) => row.parents?.includes(id)),
    };
  }
  private remove(scope: string, id: string) {
    const ids = this.db
      .prepare(
        `WITH RECURSIVE descendants(id) AS (
      VALUES (?) UNION SELECT child FROM provenance JOIN descendants ON parent=descendants.id WHERE scope=?
    ) SELECT id FROM descendants`,
      )
      .all(id, scope);
    for (const row of ids) {
      const key = String(row.id);
      this.db.prepare("DELETE FROM memory WHERE scope=? AND id=?").run(scope, key);
      this.db.prepare("DELETE FROM provenance WHERE scope=? AND child=?").run(scope, key);
      this.db.prepare("DELETE FROM planning WHERE scope=? AND input=?").run(scope, key);
      this.db.prepare("DELETE FROM extraction WHERE scope=? AND parent=?").run(scope, key);
      this.db.prepare("DELETE FROM extraction_failures WHERE scope=? AND parent=?").run(scope, key);
    }
  }
  forget(scope: string, id: string) {
    this.transaction(() => this.remove(scope, id));
  }
  prune(scope: string, now: string) {
    const date = timestamp(now);
    this.transaction(() => {
      const expired = this.db
        .prepare("SELECT data FROM memory WHERE scope=? ORDER BY rowid DESC")
        .all(scope)
        .map((row) => this.decode(row.data))
        .filter((row) => row.expires && row.expires <= date);
      for (const row of expired) this.remove(scope, row.id);
    });
  }
  replace(scope: string, id: string, input: Entry) {
    return this.transaction(() => {
      const old = this.get(scope, id, input.at);
      if (!old || input.scope !== scope || input.kind !== old.kind) throw new Error("待更新记忆不在当前范围");
      this.remove(scope, id);
      return this.insert(input);
    });
  }
  correct(scope: string, id: string, text: string, now: string, vector = localVector(text)) {
    return this.transaction(() => {
      const old = this.get(scope, id, now);
      if (!old) throw new Error("没有可纠正的记忆");
      this.remove(scope, id);
      return this.insert({
        scope,
        kind: old.kind,
        text,
        at: now,
        expires: old.expires,
        approved: old.approved,
        vector,
      });
    });
  }
  evaluate(scope: string, id: string, passed: boolean, evidence: string, now: string) {
    this.transaction(() => {
      const row = this.get(scope, id, now);
      if (!row || !["experience", "procedure"].includes(row.kind) || !evidence.trim())
        throw new Error("缺少候选经验或评估证据");
      this.write({ ...row, approved: false, evaluation: passed ? evidence : undefined });
    });
  }
  decline(scope: string, id: string, now: string) {
    this.transaction(() => {
      const row = this.get(scope, id, now);
      if (!row || !["experience", "procedure"].includes(row.kind)) throw new Error("候选经验不存在");
      this.write({ ...row, approved: false, declined: true });
    });
  }
  approve(scope: string, id: string, now: string) {
    this.transaction(() => {
      const row = this.get(scope, id, now);
      if (!row || !["experience", "procedure"].includes(row.kind) || !row.evaluation || row.declined)
        throw new Error("候选经验尚未通过评估");
      this.write({ ...row, approved: true });
    });
  }
  due(scope: string, now: string) {
    return this.list(scope, now).filter((row) => row.due && row.due <= timestamp(now));
  }
  finish(scope: string, id: string, now: string) {
    this.transaction(() => {
      const row = this.get(scope, id, now);
      if (!row || row.kind !== "todo") throw new Error("待办不存在");
      this.write({ ...row, due: undefined });
    });
  }
  revise(scope: string, id: string, recalled: boolean, now: string) {
    this.transaction(() => {
      const row = this.get(scope, id, now);
      if (!row || row.kind !== "study") throw new Error("复习条目不存在");
      const interval = recalled ? Math.min((row.interval ?? 0) + 1, 5) : 0;
      const days = [1, 2, 4, 7, 15, 30][interval];
      this.write({ ...row, interval, due: new Date(Date.parse(now) + days * 86_400_000).toISOString() });
    });
  }
}
