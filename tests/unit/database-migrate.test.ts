import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKUPS_TO_KEEP, MIGRATIONS_DIR, createDatabase, type Db } from "@/server/db/database";
import * as schema from "@/server/db/schema";
import { getLocalUser } from "@/server/repo/users";

let tmp: string;
let migrationsFolder: string;
let backupDir: string;
let file: string;

function closeDb(db: Db) {
  (db as unknown as { $client: Database.Database }).$client.close();
}

function copyMigrations(to: string) {
  fs.mkdirSync(path.join(to, "meta"), { recursive: true });
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (name.endsWith(".sql")) fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(to, name));
  }
  fs.copyFileSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"), path.join(to, "meta", "_journal.json"));
}

/** Appends a migration in the shape drizzle-kit emits; returns its tag. */
function appendMigration(folder: string, name: string, sql: string): string {
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  const idx = journal.entries.length;
  const tag = `${String(idx).padStart(4, "0")}_${name}`;
  const when = Math.max(...journal.entries.map((e) => e.when)) + 1000;
  journal.entries.push({ idx, version: "6", when, tag, breakpoints: true });
  fs.writeFileSync(path.join(folder, `${tag}.sql`), sql);
  fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return tag;
}

/** A drizzle-kit style table rebuild of `jobs` (what a column change or FK change generates). */
function rebuildJobsMigration(dbFile: string): string {
  const raw = new Database(dbFile, { readonly: true });
  const { sql: create } = raw.prepare(`select sql from sqlite_master where type='table' and name='jobs'`).get() as { sql: string };
  const indexes = (
    raw.prepare(`select sql from sqlite_master where type='index' and tbl_name='jobs' and sql is not null`).all() as Array<{ sql: string }>
  ).map((r) => r.sql);
  raw.close();
  const newCreate = create.replace(/^CREATE TABLE [`"]?jobs[`"]?/, "CREATE TABLE `__new_jobs`");
  expect(newCreate).not.toBe(create);
  return [
    "PRAGMA foreign_keys=OFF;",
    `${newCreate};`,
    "INSERT INTO `__new_jobs` SELECT * FROM `jobs`;",
    "DROP TABLE `jobs`;",
    "ALTER TABLE `__new_jobs` RENAME TO `jobs`;",
    ...indexes.map((sql) => `${sql};`),
    "PRAGMA foreign_keys=ON;",
  ].join("--> statement-breakpoint\n");
}

function count(raw: Database.Database, table: string): number {
  return (raw.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
}

function backups(): string[] {
  return fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : [];
}

/** A database at the current schema with rows in every child of `jobs`. */
function seed(): { jobId: number } {
  const db = createDatabase(file, { migrationsFolder, backupDir });
  const user = getLocalUser(db);
  const [job] = db
    .insert(schema.jobs)
    .values([
      { userId: user.id, source: "paste", title: "Data lead" },
      { userId: user.id, source: "paste", title: "Head of data" },
    ])
    .returning()
    .all();
  db.insert(schema.jobEvents)
    .values([1, 2, 3].map((n) => ({ jobId: job.id, type: "note", note: `n${n}` })))
    .run();
  db.insert(schema.jobAttachments).values({ jobId: job.id, kind: "screenshot", path: "a.png", mime: "image/png" }).run();
  const conv = db
    .insert(schema.conversations)
    .values({ userId: user.id, jobId: job.id, model: "m", effort: "low", toolsetVersion: 1, system: "s", tools: [] })
    .returning()
    .get();
  db.insert(schema.chatMessages)
    .values([
      { conversationId: conv.id, seq: 1, role: "user", kind: "user", content: [] },
      { conversationId: conv.id, seq: 2, role: "assistant", kind: "assistant", content: [] },
    ])
    .run();
  db.insert(schema.cvDocuments)
    .values({
      userId: user.id,
      jobId: job.id,
      kind: "cv",
      version: 1,
      profileVersion: 1,
      profileHash: "h",
      language: "en",
      model: "m",
      promptVersion: 1,
      content: {},
      flags: [],
    })
    .run();
  db.insert(schema.jobSightings).values({ jobId: job.id, source: "seek" }).run();
  const board = db
    .insert(schema.watchedBoards)
    .values({ userId: user.id, name: "Acme", atsType: "greenhouse", board: "acme" })
    .returning()
    .get();
  db.insert(schema.boardOpenings)
    .values({
      watchId: board.id,
      externalId: "1",
      title: "Data lead",
      url: "u",
      atsUrl: "a",
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      jobId: job.id,
    })
    .run();
  closeDb(db);
  return { jobId: job.id };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-migrate-"));
  migrationsFolder = path.join(tmp, "migrations");
  backupDir = path.join(tmp, "backups");
  file = path.join(tmp, "huntloop.db");
  copyMigrations(migrationsFolder);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("createDatabase migrations", () => {
  it("rebuilds a parent table without cascading into its children", () => {
    const { jobId } = seed();
    appendMigration(migrationsFolder, "rebuild_jobs", rebuildJobsMigration(file));
    const db = createDatabase(file, { migrationsFolder, backupDir });
    const raw = (db as unknown as { $client: Database.Database }).$client;
    expect(count(raw, "jobs")).toBe(2);
    expect(count(raw, "job_events")).toBe(3);
    expect(count(raw, "chat_messages")).toBe(2);
    expect(count(raw, "conversations")).toBe(1);
    expect(count(raw, "cv_documents")).toBe(1);
    expect(count(raw, "job_sightings")).toBe(1);
    expect(count(raw, "job_attachments")).toBe(1);
    expect((raw.prepare("select job_id from board_openings").get() as { job_id: number | null }).job_id).toBe(jobId);
    expect(raw.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    closeDb(db);
  });

  it("backs up the database before pending migrations, and only then", () => {
    seed();
    expect(backups()).toEqual([]); // fresh file: no tables yet, no backup
    const tag = appendMigration(migrationsFolder, "rebuild_jobs", rebuildJobsMigration(file));
    closeDb(createDatabase(file, { migrationsFolder, backupDir }));
    const made = backups();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(new RegExp(`^huntloop-\\d{8}-\\d{9}-before-${tag}\\.db$`));
    const copy = new Database(path.join(backupDir, made[0]), { readonly: true });
    expect(count(copy, "job_events")).toBe(3);
    const rebuildWhen = Math.max(
      ...(JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ when: number }> }).entries.map(
        (e) => e.when,
      ),
    );
    expect(copy.prepare(`select count(*) as n from __drizzle_migrations where created_at = ?`).get(rebuildWhen)).toEqual({ n: 0 });
    copy.close();
    // Nothing pending → no new backup.
    closeDb(createDatabase(file, { migrationsFolder, backupDir }));
    expect(backups()).toEqual(made);
  });

  it(`keeps the newest ${BACKUPS_TO_KEEP} backups and never deletes other files`, () => {
    seed();
    fs.mkdirSync(backupDir, { recursive: true });
    for (let n = 1; n <= 6; n++) fs.writeFileSync(path.join(backupDir, `huntloop-2000010${n}-000000000-before-x.db`), "old");
    fs.writeFileSync(path.join(backupDir, "keep-me.db"), "mine");
    fs.writeFileSync(path.join(backupDir, "huntloop-manual.db"), "mine");
    appendMigration(migrationsFolder, "rebuild_jobs", rebuildJobsMigration(file));
    closeDb(createDatabase(file, { migrationsFolder, backupDir }));
    const left = backups();
    const managed = left.filter((n) => /^huntloop-\d{8}-\d{9}-before-/.test(n));
    expect(managed).toHaveLength(BACKUPS_TO_KEEP);
    expect(managed.some((n) => n.includes("rebuild_jobs"))).toBe(true);
    expect(managed).not.toContain("huntloop-20000101-000000000-before-x.db");
    expect(managed).not.toContain("huntloop-20000102-000000000-before-x.db");
    expect(left).toContain("keep-me.db");
    expect(left).toContain("huntloop-manual.db");
  });

  it("rolls back migrations that would leave foreign-key violations", () => {
    seed();
    const tag = appendMigration(
      migrationsFolder,
      "bad_fk",
      "INSERT INTO `job_events` (`job_id`, `type`, `note`) VALUES (999999, 'note', 'bogus');",
    );
    expect(() => createDatabase(file, { migrationsFolder, backupDir })).toThrow(/foreign-key violations.*Backup: .*huntloop-.*-before-/s);
    const raw = new Database(file);
    expect(count(raw, "job_events")).toBe(3);
    expect(raw.prepare("select count(*) as n from job_events where note = 'bogus'").get()).toEqual({ n: 0 });
    expect(count(raw, "jobs")).toBe(2);
    const when = (
      JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string; when: number }> }
    ).entries.find((e) => e.tag === tag)!.when;
    expect(raw.prepare("select count(*) as n from __drizzle_migrations where created_at = ?").get(when)).toEqual({ n: 0 });
    raw.close();
    // Still pending: the next start refuses again.
    expect(() => createDatabase(file, { migrationsFolder, backupDir })).toThrow(/foreign-key violations/);
  });

  it("refuses to migrate when the backup can't be written", () => {
    seed();
    const blocked = path.join(tmp, "not-a-dir");
    fs.writeFileSync(blocked, "file in the way");
    appendMigration(migrationsFolder, "add_col", "ALTER TABLE `jobs` ADD `probe` integer;");
    expect(() => createDatabase(file, { migrationsFolder, backupDir: path.join(blocked, "backups") })).toThrow(
      /couldn't back up the database before migrating .*nothing was changed/,
    );
    const raw = new Database(file);
    const cols = (raw.pragma("table_info(jobs)") as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("probe");
    raw.close();
  });

  it("keeps drizzle's bookkeeping (same hash and created_at rows)", () => {
    const a = path.join(tmp, "a.db");
    const b = path.join(tmp, "b.db");
    const sqliteA = new Database(a);
    migrate(drizzle(sqliteA, { schema }), { migrationsFolder });
    const rowsA = sqliteA.prepare("select hash, created_at from __drizzle_migrations order by created_at").all();
    const ddlA = (sqliteA.prepare("select sql from sqlite_master where name='__drizzle_migrations'").get() as { sql: string }).sql;
    sqliteA.close();
    const dbB = createDatabase(b, { migrationsFolder, backupDir: false });
    const rawB = (dbB as unknown as { $client: Database.Database }).$client;
    const rowsB = rawB.prepare("select hash, created_at from __drizzle_migrations order by created_at").all();
    const ddlB = (rawB.prepare("select sql from sqlite_master where name='__drizzle_migrations'").get() as { sql: string }).sql;
    closeDb(dbB);
    expect(rowsB).toEqual(rowsA);
    expect(rowsB.length).toBeGreaterThan(0);
    expect(ddlB.replace(/\s+/g, " ").trim()).toBe(ddlA.replace(/\s+/g, " ").trim());
    // A database migrated by drizzle opens without re-applying anything (and without a backup).
    closeDb(createDatabase(a, { migrationsFolder, backupDir }));
    expect(backups()).toEqual([]);
  });

  it("adds the deleted-jobs table to a database that already has jobs", () => {
    // Start from the schema before 0013: drop it from the copied journal, seed, then put it back.
    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const full = fs.readFileSync(journalPath, "utf8");
    const journal = JSON.parse(full) as { entries: Array<{ tag: string }> };
    const tag = "0013_dismissed_jobs";
    expect(journal.entries.map((e) => e.tag)).toContain(tag);
    fs.writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.filter((e) => e.tag < tag) }));
    seed();
    const before = new Database(file, { readonly: true });
    expect(before.prepare("select name from sqlite_master where name = 'dismissed_jobs'").get()).toBeUndefined();
    before.close();
    fs.writeFileSync(journalPath, full);

    const db = createDatabase(file, { migrationsFolder, backupDir });
    const raw = (db as unknown as { $client: Database.Database }).$client;
    expect(count(raw, "jobs")).toBe(2);
    expect(count(raw, "job_events")).toBe(3);
    expect(count(raw, "dismissed_jobs")).toBe(0);
    const indexes = (raw.prepare("select name from sqlite_master where type = 'index' and tbl_name = 'dismissed_jobs'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toEqual(["dismissed_jobs_user_source_url"]);
    expect(raw.pragma("foreign_key_check")).toEqual([]);
    expect(backups().some((n) => n.includes(`before-${tag}`))).toBe(true);
    closeDb(db);
  });

  it("still opens in-memory databases", () => {
    const db = createDatabase(":memory:");
    expect(getLocalUser(db).id).toBeGreaterThan(0);
  });
});

describe("getDb", () => {
  it("remembers a failed open instead of migrating again", async () => {
    vi.resetModules();
    const g = globalThis as unknown as { huntloopDb?: unknown; huntloopDbError?: unknown };
    const saved = { db: g.huntloopDb, error: g.huntloopDbError };
    delete g.huntloopDb;
    delete g.huntloopDbError;
    const failing = vi.fn(() => {
      throw new Error("migration rolled back");
    });
    vi.doMock("@/server/db/database", () => ({ createDatabase: failing }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { getDb } = await import("@/server/db/client");
      expect(() => getDb()).toThrow("migration rolled back");
      expect(() => getDb()).toThrow("migration rolled back");
      expect(failing).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@/server/db/database");
      g.huntloopDb = saved.db;
      g.huntloopDbError = saved.error;
      if (saved.error === undefined) delete g.huntloopDbError;
      if (saved.db === undefined) delete g.huntloopDb;
    }
  });
});
