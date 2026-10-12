import "server-only";
import { createDatabase, type Db } from "./database";
import { dataDir } from "../config/env";
import path from "node:path";

const globalForDb = globalThis as unknown as { huntloopDb?: Db };

/** The app's single database connection (kept on globalThis so dev hot reload doesn't reopen it). */
export function getDb(): Db {
  if (!globalForDb.huntloopDb) {
    globalForDb.huntloopDb = createDatabase(path.join(dataDir(), "huntloop.db"));
  }
  return globalForDb.huntloopDb;
}
