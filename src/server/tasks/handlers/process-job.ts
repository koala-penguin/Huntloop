import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/database";
import { jobs, tasks } from "../../db/schema";
import { processJob } from "../../jobs/pipeline";
import { getJob, updateJob } from "../../repo/jobs";
import { formatTaskError, UserFacingError } from "../../errors";
import { registerTaskHandler, type TaskContext } from "../runner";

export const PROCESS_JOB_TASK = "process-job";

const payloadSchema = z.object({
  jobId: z.number().int(),
  transcribe: z.boolean().optional(),
  assessOnly: z.boolean().optional(),
  preferUrl: z.boolean().optional(),
});
export type ProcessJobPayload = z.infer<typeof payloadSchema>;

export async function runProcessJob(ctx: TaskContext): Promise<{ jobId: number; intakeStatus: string }> {
  const payload = payloadSchema.parse(ctx.payload);
  const job = getJob(ctx.db, ctx.userId, payload.jobId);
  if (!job) throw new Error(`Job ${payload.jobId} not found`);
  try {
    const result = await processJob({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, job, {
      transcribe: payload.transcribe,
      assessOnly: payload.assessOnly,
      preferUrl: payload.preferUrl,
      waitForUser: ctx.waitForUser,
      onStage: (stage) => ctx.progress({ stage }),
    });
    return { jobId: result.id, intakeStatus: result.intakeStatus };
  } catch (error) {
    markInterrupted(ctx.db, ctx.userId, payload.jobId, error);
    throw error;
  }
}

/** Records why intake stopped. A job whose analysis already exists keeps showing it; only first-time intake is marked failed. */
export function markInterrupted(db: Db, userId: number, jobId: number, error: unknown): void {
  const current = getJob(db, userId, jobId);
  if (current && !current.analysisId) updateJob(db, current.id, { intakeStatus: "failed", intakeError: formatTaskError(error) });
  else if (current) updateJob(db, current.id, { intakeStatus: "ready", intakeError: formatTaskError(error) });
}

const interrupted = () => new UserFacingError("interrupted");

/**
 * At startup: jobs still marked "processing" with no live task behind them (their task was lost
 * with the previous process, or they were being screened by a search that died) are marked
 * interrupted so the page offers a retry instead of spinning forever. Returns how many.
 */
export function failOrphanedProcessingJobs(db: Db): number {
  const processing = db.select({ id: jobs.id, userId: jobs.userId }).from(jobs).where(eq(jobs.intakeStatus, "processing")).all();
  if (!processing.length) return 0;
  const active = db
    .select({ payload: tasks.payload })
    .from(tasks)
    .where(inArray(tasks.status, ["queued", "running", "needs_user_action"]))
    .all();
  const covered = new Set<number>();
  for (const { payload } of active) {
    const jobId = (payload as { jobId?: unknown } | null)?.jobId;
    if (typeof jobId === "number") covered.add(jobId);
  }
  let count = 0;
  for (const job of processing) {
    if (covered.has(job.id)) continue;
    markInterrupted(db, job.userId, job.id, interrupted());
    count++;
  }
  return count;
}

registerTaskHandler(PROCESS_JOB_TASK, {
  run: runProcessJob,
  maxAttempts: 1,
  onAbandoned: (db, task) => {
    const payload = payloadSchema.safeParse(task.payload);
    if (payload.success) markInterrupted(db, task.userId, payload.data.jobId, interrupted());
  },
});
