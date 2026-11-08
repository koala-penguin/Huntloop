import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import fs from "node:fs";
import path from "node:path";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export const MIGRATIONS_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "drizzle");

export interface CreateDatabaseOptions {
  /** Default: MIGRATIONS_DIR. Tests point this at a temp folder. */
  migrationsFolder?: string;
  /** Default: <dir of file>/backups. `false` disables. Ignored for ":memory:". */
  backupDir?: string | false;
}

/** How many automatic pre-migration backups stay in the backup folder. */
export const BACKUPS_TO_KEEP = 5;

/** Names of the backups this module writes (and the only files its pruning may delete). */
const BACKUP_NAME = /^huntloop-\d{8}-\d{9}-before-[\w-]+\.db$/;

const MIGRATIONS_TABLE = "__drizzle_migrations";

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(migrationsFolder: string): JournalEntry[] {
  const journal = JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ migrationsFolder, "meta", "_journal.json"), "utf8")) as {
    entries: JournalEntry[];
  };
  return journal.entries;
}

function lastAppliedAt(sqlite: Database.Database): number | null {
  const table = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(MIGRATIONS_TABLE);
  if (!table) return null;
  const row = sqlite.prepare(`SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`).get() as
    | { created_at: number | string | null }
    | undefined;
  return row ? Number(row.created_at) : null;
}

/** Tags of the migrations drizzle would apply: journal entries newer than the last applied one. */
export function pendingMigrationTags(sqlite: Database.Database, migrationsFolder: string): string[] {
  const last = lastAppliedAt(sqlite);
  return readJournal(migrationsFolder)
    .filter((entry) => last === null || last < entry.when)
    .map((entry) => entry.tag);
}

function hasUserTables(sqlite: Database.Database): boolean {
  const row = sqlite
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '${MIGRATIONS_TABLE}'`,
    )
    .get() as { n: number };
  return row.n > 0;
}

/** UTC, with milliseconds, so names sort in time order across daylight-saving changes. */
export function backupTimestamp(now = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}${pad(now.getUTCMilliseconds(), 3)}`
  );
}

function safeTag(tag: string): string {
  return tag.replace(/[^\w-]/g, "_") || "migration";
}

/** Deletes all but the newest BACKUPS_TO_KEEP backups (by name). `keep` is never deleted. */
function pruneBackups(backupDir: string, keep: string): void {
  const names = fs
    .readdirSync(backupDir)
    .filter((name) => BACKUP_NAME.test(name))
    .sort();
  const keepName = path.basename(keep);
  const others = names.filter((name) => name !== keepName);
  // The new backup counts as one of the kept ones.
  const surplus = others.length + 1 - BACKUPS_TO_KEEP;
  for (const name of others.slice(0, Math.max(0, surplus))) {
    try {
      fs.unlinkSync(path.join(/*turbopackIgnore: true*/ backupDir, name));
    } catch (error) {
      console.warn(`[huntloop] couldn't delete old database backup ${name}`, error);
    }
  }
}

/**
 * Writes a consistent copy of the database (`VACUUM INTO`), verifies it, then prunes old copies.
 * Throws — without touching the database — when the copy can't be made or doesn't check out.
 */
export function backupBeforeMigrations(
  sqlite: Database.Database,
  file: string,
  backupDir: string,
  firstPendingTag: string,
): string {
  const target = path.join(/*turbopackIgnore: true*/ backupDir, `huntloop-${backupTimestamp()}-before-${safeTag(firstPendingTag)}.db`);
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    sqlite.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const copy = new Database(target, { readonly: true, fileMustExist: true });
    try {
      const result = copy.pragma("quick_check", { simple: true });
      if (result !== "ok") throw new Error(`quick_check on the copy returned ${String(result)}`);
    } finally {
      copy.close();
    }
  } catch (error) {
    try {
      if (fs.existsSync(target)) fs.unlinkSync(target);
    } catch {
      // The partial file stays; it doesn't match a good backup's contents but is harmless.
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`[huntloop] couldn't back up the database before migrating (${reason}); nothing was changed.`, {
      cause: error,
    });
  }
  pruneBackups(backupDir, target);
  void file;
  return target;
}

function summarizeViolations(rows: Array<{ table: string; parent: string }>): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.table} → ${row.parent}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, n]) => `${key} ×${n}`).join(", ");
}

/**
 * Applies pending migrations with foreign keys OFF, in one `BEGIN IMMEDIATE` transaction, and
 * runs `foreign_key_check` before COMMIT. Bookkeeping (table, DDL, hash, created_at) matches
 * drizzle's own migrator, so either can pick up where the other left off.
 */
function applyMigrations(sqlite: Database.Database, migrationsFolder: string, backup: string | null): void {
  // SQLite ignores this pragma inside a transaction, so it is set before BEGIN.
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at numeric
			)`);
    const migrations = readMigrationFiles({ migrationsFolder });
    const apply = sqlite.transaction(() => {
      // Read inside the transaction: a second process that waited on the lock sees our rows.
      const last = sqlite.prepare(`SELECT created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC LIMIT 1`).get() as
        | { created_at: number | string | null }
        | undefined;
      for (const migration of migrations) {
        if (last && !(Number(last.created_at) < migration.folderMillis)) continue;
        for (const stmt of migration.sql) {
          if (stmt.trim()) sqlite.exec(stmt);
        }
        sqlite
          .prepare(`INSERT INTO "${MIGRATIONS_TABLE}" ("hash", "created_at") VALUES (?, ?)`)
          .run(migration.hash, migration.folderMillis);
      }
      const bad = sqlite.pragma("foreign_key_check") as Array<{ table: string; parent: string }>;
      if (bad.length) {
        throw new Error(
          `[huntloop] migrations would leave ${bad.length} foreign-key violations (${summarizeViolations(bad)}); ` +
            `rolled back, nothing was changed. Backup: ${backup ?? "none"} (see "Database backups" in docs/guide.md).`,
        );
      }
    });
    apply.immediate();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }
}

/** Opens (or creates) a database file — or ":memory:" — and applies all migrations. */
export function createDatabase(file: string, options: CreateDatabaseOptions = {}): Db {
  const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_DIR;
  const inMemory = file === ":memory:";
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
    const pending = pendingMigrationTags(sqlite, migrationsFolder);
    let backup: string | null = null;
    if (pending.length) {
      const backupDir =
        options.backupDir === undefined ? path.join(/*turbopackIgnore: true*/ path.dirname(file), "backups") : options.backupDir;
      if (!inMemory && backupDir !== false && hasUserTables(sqlite)) {
        backup = backupBeforeMigrations(sqlite, file, backupDir, pending[0]);
        console.log(`[huntloop] database backup before migrations ${pending.join(", ")}: ${backup}`);
      }
      applyMigrations(sqlite, migrationsFolder, backup);
    } else {
      sqlite.pragma("foreign_keys = ON");
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }
  return drizzle(sqlite, { schema });
}
