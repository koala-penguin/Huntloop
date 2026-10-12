import { z } from "zod";
import { processJob } from "../../jobs/pipeline";
import { getJob, updateJob } from "../../repo/jobs";
import { formatTaskError } from "../../errors";
import { registerTaskHandler, type TaskContext } from "../runner";

export const PROCESS_JOB_TASK = "process-job";

const payloadSchema = z.object({
  jobId: z.number().int(),
  transcribe: z.boolean().optional(),
  assessOnly: z.boolean().optional(),
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
      onStage: (stage) => ctx.progress({ stage }),
    });
    return { jobId: result.id, intakeStatus: result.intakeStatus };
  } catch (error) {
    // A job whose analysis already exists keeps showing it; only first-time intake is marked failed.
    const current = getJob(ctx.db, ctx.userId, payload.jobId);
    if (current && !current.analysisId) updateJob(ctx.db, current.id, { intakeStatus: "failed", intakeError: formatTaskError(error) });
    else if (current) updateJob(ctx.db, current.id, { intakeStatus: "ready", intakeError: formatTaskError(error) });
    throw error;
  }
}

registerTaskHandler(PROCESS_JOB_TASK, { run: runProcessJob, maxAttempts: 1 });
