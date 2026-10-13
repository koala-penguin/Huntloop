import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/database";
import { tasks } from "../db/schema";
import type { CvLanguage } from "@/shared/schemas/cv";
import { enqueueTask } from "../tasks/runner";
import { LINKEDIN_PROFILE_TASK, TAILOR_CV_TASK } from "../tasks/handlers/tailor-cv";
import { getJob, setJobStatus } from "../repo/jobs";
import { getCurrentProfile } from "../repo/profile";
import { latestCvDocument } from "../repo/cv-documents";
import { startCompanyResearch } from "../research/company";
import { UserFacingError } from "../errors";
import { activeTaskForJob } from "./intake";

const PAST_PROCEED = ["applying", "applied", "interviewing", "offer"];

/**
 * The user decided to go for this job (Proceed button, or accepting the AI's proposal in chat):
 * status → Applying, employer research if there's none, and a tailored CV draft.
 */
export function proceedWithJob(db: Db, userId: number, jobId: number, via: "button" | "chat"): { taskId: number | null } {
  const job = getJob(db, userId, jobId);
  if (!job) throw new UserFacingError("not_found");
  if (!PAST_PROCEED.includes(job.status)) setJobStatus(db, userId, jobId, "applying", via === "chat" ? "Agreed in chat" : "Proceed");
  startCompanyResearch(db, userId, job);
  return { taskId: startTailoring(db, userId, jobId, { onlyIfNoDraft: true }) };
}

/** Queues a tailored CV (or returns the one already being written). */
export function startTailoring(
  db: Db,
  userId: number,
  jobId: number,
  options: { onlyIfNoDraft?: boolean; revise?: { fromDocId: number; instructions: string } } = {},
): number | null {
  const running = activeTaskForJob(db, userId, TAILOR_CV_TASK, jobId);
  if (running) return running;
  if (!getCurrentProfile(db, userId)) return null;
  const job = getJob(db, userId, jobId);
  if (!job?.analysisId) return null;
  if (options.onlyIfNoDraft && latestCvDocument(db, userId, "cv", jobId)) return null;
  return enqueueTask(db, userId, TAILOR_CV_TASK, { jobId, revise: options.revise ?? null }).id;
}

/** Queues LinkedIn profile text (or returns the run already in progress). */
export function startLinkedinDraft(db: Db, userId: number, language: CvLanguage): number {
  if (!getCurrentProfile(db, userId)) throw new UserFacingError("no_profile");
  const last = db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.kind, LINKEDIN_PROFILE_TASK)))
    .orderBy(desc(tasks.id))
    .get();
  if (last && ["queued", "running"].includes(last.status)) return last.id;
  return enqueueTask(db, userId, LINKEDIN_PROFILE_TASK, { language }).id;
}
