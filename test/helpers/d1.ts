/**
 * A D1Database stand-in over better-sqlite3, for tests only.
 *
 * It implements the part of the D1 client API that src/worker uses:
 * prepare(sql).bind(...).run() / .first() / .all(), with D1's numbered
 * parameters (?1, ?2, ...) and its result shapes ({ results }, { meta }).
 * The schema comes from migrations/, applied in order, so the Worker code
 * runs against the same tables production does.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

export function applyMigrations(db: Database.Database, upTo?: string): void {
  for (const f of migrationFiles()) {
    if (upTo && f > upTo) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }
}

// better-sqlite3 binds ?NNN positionally only for bare "?", so rewrite D1's
// numbered parameters as named ones and bind an object.
function toNamed(sql: string): string {
  return sql.replace(/\?(\d+)/g, "@p$1");
}

class Statement {
  private params: Record<string, unknown> = {};
  constructor(private db: Database.Database, private sql: string) {}

  bind(...values: unknown[]): Statement {
    const s = new Statement(this.db, this.sql);
    values.forEach((v, i) => (s.params[`p${i + 1}`] = v === undefined ? null : v));
    return s;
  }

  private stmt() {
    return this.db.prepare(toNamed(this.sql));
  }

  async run() {
    const r = this.stmt().run(this.params);
    return { success: true, results: [], meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.stmt().get(this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    const results = this.stmt().all(this.params) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }
}

export class FakeD1 {
  readonly sqlite: Database.Database;
  constructor(opts: { migrate?: boolean; upTo?: string } = {}) {
    this.sqlite = new Database(":memory:");
    if (opts.migrate !== false) applyMigrations(this.sqlite, opts.upTo);
  }
  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }
  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }
  async batch(statements: Statement[]) {
    const out = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }
}

/** The Worker's types want a D1Database; the fake covers what the code calls. */
export function fakeD1(opts?: { migrate?: boolean; upTo?: string }): D1Database & { sqlite: Database.Database } {
  return new FakeD1(opts) as unknown as D1Database & { sqlite: Database.Database };
}
