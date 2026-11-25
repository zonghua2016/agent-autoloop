import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS codeup_items (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
    );
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT data FROM codeup_items WHERE key=?").get(key);
    return row ? JSON.parse(String(row.data)) : fallback;
  }
  put(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO codeup_items VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(key, JSON.stringify(value));
  }
  putIfAbsent(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO codeup_items VALUES (?,?) ON CONFLICT(key) DO NOTHING")
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
  }
}
