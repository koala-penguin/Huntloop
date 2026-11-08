import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/database";
import { tasks, type JobRow } from "../db/schema";
import { PROCESS_JOB_TASK } from "../tasks/handlers/process-job";
import { FIND_EMPLOYER_POSTING_TASK } from "../tasks/handlers/find-employer-posting";
import { TAILOR_CV_TASK } from "../tasks/handlers/tailor-cv";
import { activeJobTask, activeTaskForJob } from "./intake";
import { activeResearchTask, COMPANY_RESEARCH_TASK } from "../research/company";
import type { JobTaskRefs, TaskRef, TaskStatus } from "@/shared/job-tasks";

function ref(db: Db, userId: number, kind: string, key: "jobId" | "companyId", value: number, active: number | null): TaskRef {
  const row = db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.kind, kind), sql`json_extract(${tasks.payload}, ${`$.${key}`}) = ${value}`))
    .orderBy(desc(tasks.id))
    .get();
  return { active, latest: row?.id ?? null, latestStatus: (row?.status as TaskStatus | undefined) ?? null };
}

const NONE: TaskRef = { active: null, latest: null, latestStatus: null };

/**
 * The tasks a job page shows progress for. The page renders with these, and its task controls ask
 * for them again (GET /api/jobs/[id]/tasks) when they mount, because a page restored from the
 * browser's history can predate a task.
 */
export function jobTaskRefs(db: Db, userId: number, job: JobRow): JobTaskRefs {
  return {
    intake: ref(db, userId, PROCESS_JOB_TASK, "jobId", job.id, activeJobTask(db, userId, job)),
    research: job.companyId ? ref(db, userId, COMPANY_RESEARCH_TASK, "companyId", job.companyId, activeResearchTask(db, userId, job.companyId)) : NONE,
    findEmployer: ref(db, userId, FIND_EMPLOYER_POSTING_TASK, "jobId", job.id, activeTaskForJob(db, userId, FIND_EMPLOYER_POSTING_TASK, job.id)),
    tailoring: ref(db, userId, TAILOR_CV_TASK, "jobId", job.id, activeTaskForJob(db, userId, TAILOR_CV_TASK, job.id)),
  };
}
