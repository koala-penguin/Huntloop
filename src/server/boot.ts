import { getDb } from "./db/client";
import { getLocalUser } from "./repo/users";
import { startTaskRunner } from "./tasks/runner";
import { startScheduler } from "./tasks/scheduler";
import { readEnv } from "./config/env";
import { getClaudeCodeStatus } from "./ai/claude-code/status";
import "./tasks/handlers";
import { failOrphanedProcessingJobs } from "./tasks/handlers/process-job";

/**
 * Runs once per server process (from instrumentation.ts): check the Claude Code CLI (for the
 * subscription connection), migrate, seed the local user, start the worker and the daily checks.
 */
export async function boot(): Promise<void> {
  if (readEnv().HUNTLOOP_AI !== "fake") {
    await getClaudeCodeStatus().catch((error) => console.warn("[huntloop] couldn't check Claude Code", error));
  }
  const db = getDb();
  getLocalUser(db);
  startTaskRunner(db);
  // Right after start() has recovered stale tasks and before its first tick claims anything new.
  failOrphanedProcessingJobs(db);
  startScheduler(db);
}
