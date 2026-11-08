import "server-only";
import { createDatabase, type Db } from "./database";
import { dataPath } from "../config/env";

const globalForDb = globalThis as unknown as { huntloopDb?: Db; huntloopDbError?: unknown };

/**
 * The app's single database connection (kept on globalThis so dev hot reload doesn't reopen it).
 * A failed open (a migration that rolled back, a backup that couldn't be written) is remembered:
 * later calls rethrow it instead of running the migration — and taking a backup — again.
 */
export function getDb(): Db {
  if (globalForDb.huntloopDbError !== undefined) throw globalForDb.huntloopDbError;
  if (!globalForDb.huntloopDb) {
    try {
      globalForDb.huntloopDb = createDatabase(dataPath("huntloop.db"), { backupDir: dataPath("backups") });
    } catch (error) {
      globalForDb.huntloopDbError = error;
      console.error("[huntloop] couldn't open the database; restart the app after fixing the cause", error);
      throw error;
    }
  }
  return globalForDb.huntloopDb;
}
