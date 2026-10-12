import { getDb } from "./db/client";
import { getLocalUser } from "./repo/users";
import { startTaskRunner } from "./tasks/runner";
import "./tasks/handlers";

/** Runs once per server process (from instrumentation.ts): migrate, seed the local user, start the worker. */
export function boot(): void {
  const db = getDb();
  getLocalUser(db);
  startTaskRunner(db);
}
