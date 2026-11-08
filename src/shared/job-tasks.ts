/** The background tasks a job page follows. */
export type JobTaskKind = "intake" | "research" | "findEmployer" | "tailoring";

export type TaskStatus = "queued" | "running" | "needs_user_action" | "succeeded" | "failed" | "cancelled";

/** One kind of task for a job: the one still running (if any) and the newest one ever started. */
export interface TaskRef {
  active: number | null;
  latest: number | null;
  latestStatus: TaskStatus | null;
}

export type JobTaskRefs = Record<JobTaskKind, TaskRef>;
