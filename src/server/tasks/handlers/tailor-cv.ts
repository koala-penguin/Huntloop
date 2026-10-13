import { z } from "zod";
import { blockingCount, CV_LANGUAGES } from "@/shared/schemas/cv";
import { tailorCvForJob, writeLinkedinForUser } from "../../cv/tailor";
import { registerTaskHandler, type TaskContext } from "../runner";

export const TAILOR_CV_TASK = "tailor-cv";
export const LINKEDIN_PROFILE_TASK = "linkedin-profile";

const tailorPayload = z.object({
  jobId: z.number().int(),
  revise: z.object({ fromDocId: z.number().int(), instructions: z.string().min(1).max(2000) }).nullable().optional(),
});

/** Plans and writes a tailored CV for one job (or revises the latest draft), then checks it. */
export async function runTailorCv(ctx: TaskContext): Promise<{ docId: number; version: number; blocking: number }> {
  const { jobId, revise } = tailorPayload.parse(ctx.payload);
  ctx.progress({ stage: revise ? "writing" : "planning" });
  const doc = await tailorCvForJob({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, jobId, {
    revise: revise ?? undefined,
    onStage: (stage) => ctx.progress({ stage }),
  });
  return { docId: doc.id, version: doc.version, blocking: blockingCount(doc.flags) };
}

const linkedinPayload = z.object({ language: z.enum(CV_LANGUAGES) });

export async function runLinkedinProfile(ctx: TaskContext): Promise<{ docId: number; version: number; blocking: number }> {
  const { language } = linkedinPayload.parse(ctx.payload);
  ctx.progress({ stage: "writing" });
  const doc = await writeLinkedinForUser({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, language);
  return { docId: doc.id, version: doc.version, blocking: blockingCount(doc.flags) };
}

registerTaskHandler(TAILOR_CV_TASK, { run: runTailorCv, maxAttempts: 1 });
registerTaskHandler(LINKEDIN_PROFILE_TASK, { run: runLinkedinProfile, maxAttempts: 1 });
