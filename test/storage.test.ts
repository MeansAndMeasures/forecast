/**
 * Regression net for storage: the migrations, append-only observation
 * storage, and the Worker's D1 collation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appendSnapshot, latestSnapshot } from "../src/worker/store";
import { collate } from "../src/worker/collate";
import { applyMigrations, fakeD1, migrationFiles, MIGRATIONS_DIR } from "./helpers/d1";

test("migrations are numbered 0001 upward with no gaps", () => {
  const nums = migrationFiles().map((f) => Number(f.slice(0, 4)));
  assert.deepEqual(nums, nums.map((_, i) => i + 1));
});

test("every migration can run twice, so a stale d1_migrations ledger is safe to reapply", () => {
  const db = new Database(":memory:");
  applyMigrations(db);
  assert.doesNotThrow(() => applyMigrations(db));
});

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

test("the Node store creates the same core tables as the D1 migrations", () => {
  const d1 = new Database(":memory:");
  applyMigrations(d1);
  const nodeDdl = readFileSync(join(__dirname, "..", "src", "store.ts"), "utf8");
  const block = nodeDdl.slice(nodeDdl.indexOf("db.exec(`") + "db.exec(`".length);
  const node = new Database(":memory:");
  node.exec(block.slice(0, block.indexOf("`)")));
  for (const t of ["snapshots", "collations", "latents", "place_signals"]) {
    assert.deepEqual(columns(node, t), columns(d1, t), t);
  }
});

test("observations are append-only: no code path updates or deletes snapshots, collations or latents", () => {
  for (const f of ["src/store.ts", "src/worker/store.ts"]) {
    const src = readFileSync(join(__dirname, "..", f), "utf8");
    for (const t of ["snapshots", "collations", "latents"]) {
      assert.doesNotMatch(src, new RegExp(`(UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO|DROP\\s+TABLE)\\s+${t}\\b`, "i"), `${f} ${t}`);
    }
  }
  for (const f of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
    assert.doesNotMatch(sql, /\b(DELETE\s+FROM|DROP\s+TABLE|UPDATE\s+\w+\s+SET)\b/i, f);
  }
});

test("appending a snapshot keeps the earlier one, and latest returns the newest", async () => {
  const db = fakeD1();
  const a = await appendSnapshot(db, { source: "METAR", fetched_at: 1000, observed_at_min: 1, observed_at_max: 2, data: [1] });
  const b = await appendSnapshot(db, { source: "METAR", fetched_at: 2000, observed_at_min: 3, observed_at_max: 4, data: [2] });
  assert.ok(b > a);
  const count = db.sqlite.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
  assert.equal(count.n, 2);
  assert.equal((await latestSnapshot(db, "METAR"))?.fetched_at, 2000);
});

test("D1 collation takes the newest fresh snapshot per source and drops stale ones", async () => {
  const db = fakeD1();
  const now = 10_000_000;
  assert.equal(await collate(db, 60_000, now), null);

  await appendSnapshot(db, { source: "METAR", fetched_at: now - 120_000, observed_at_min: 10, observed_at_max: 20, data: [1] });
  await appendSnapshot(db, { source: "METAR", fetched_at: now - 30_000, observed_at_min: 100, observed_at_max: 200, data: [1, 2] });
  await appendSnapshot(db, { source: "AIRNOW", fetched_at: now - 10_000, observed_at_min: 150, observed_at_max: 300, data: [1] });
  await appendSnapshot(db, { source: "NEXRAD", fetched_at: now - 90_000, observed_at_min: 5, observed_at_max: 6, data: [1] });

  const c = await collate(db, 60_000, now);
  assert.ok(c && c.id !== undefined);
  assert.deepEqual(Object.keys(c.sources).sort(), ["AIRNOW", "METAR"]);
  assert.equal(c.sources.METAR?.record_count, 2);
  assert.equal(c.observed_at_min, 100);
  assert.equal(c.observed_at_max, 300);
  assert.equal(c.collated_at, now);
});

test("the Worker keeps its five-minute cron, its D1 binding and its public route", () => {
  const toml = readFileSync(join(__dirname, "..", "wrangler.toml"), "utf8");
  assert.match(toml, /crons\s*=\s*\["\*\/5 \* \* \* \*"\]/);
  assert.match(toml, /binding\s*=\s*"DB"/);
  assert.match(toml, /database_id\s*=\s*"f38eae1e-efe7-41d3-980a-aeb73480a76a"/);
  assert.match(toml, /pattern\s*=\s*"forecast\.meansandmeasures\.com\/\*"/);
});
