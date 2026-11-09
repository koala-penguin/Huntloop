import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/database";
import { tasks } from "../../db/schema";
import { blockingCount } from "@/shared/schemas/cv";
import { generateBaseCv } from "../../cv/interview-build";
import { getInterview } from "../../repo/interviews";
import { UserFacingError } from "../../errors";
import { enqueueTask, registerTaskHandler, type TaskContext } from "../runner";
import { EXTRACT_PROFILE_TASK } from "./extract-profile";

export const BUILD_BASE_CV_TASK = "build-base-cv";

const payloadSchema = z.object({ interviewId: z.number().int() });

/** CV builder → Generate: profile version from the interview, then the base CV, then its checks. */
export async function runBuildBaseCv(ctx: TaskContext): Promise<{ docId: number; version: number; blocking: number }> {
  const { interviewId } = payloadSchema.parse(ctx.payload);
  ctx.progress({ stage: "building" });
  const doc = await generateBaseCv({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, interviewId, { onStage: (stage) => ctx.progress({ stage }) });
  return { docId: doc.id, version: doc.version, blocking: blockingCount(doc.flags) };
}

registerTaskHandler(BUILD_BASE_CV_TASK, { run: runBuildBaseCv, maxAttempts: 1 });

function activeTask(db: Db, userId: number, kind: string): number | null {
  const last = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.kind, kind), inArray(tasks.status, ["queued", "running"])))
    .orderBy(desc(tasks.id))
    .get();
  return last?.id ?? null;
}

/**
 * Queues Generate (or returns the run already in progress). Refused while a CV upload is being read:
 * both write a new profile version.
 */
export function startBuildBaseCv(db: Db, userId: number, interviewId: number): number {
  if (!getInterview(db, userId, interviewId)) throw new UserFacingError("not_found");
  const running = activeTask(db, userId, BUILD_BASE_CV_TASK);
  if (running) return running;
  if (activeTask(db, userId, EXTRACT_PROFILE_TASK)) throw new UserFacingError("task_running");
  return enqueueTask(db, userId, BUILD_BASE_CV_TASK, { interviewId }).id;
}
