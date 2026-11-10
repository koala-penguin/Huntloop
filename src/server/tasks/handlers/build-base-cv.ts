import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/database";
import { tasks } from "../../db/schema";
import { blockingCount } from "@/shared/schemas/cv";
import { generateBaseCv } from "../../cv/cv-builder-build";
import { getCvBuilder } from "../../repo/cv-builder";
import { UserFacingError } from "../../errors";
import { enqueueTask, registerTaskHandler, type TaskContext } from "../runner";
import { EXTRACT_PROFILE_TASK } from "./extract-profile";

export const BUILD_BASE_CV_TASK = "build-base-cv";

const payloadSchema = z.object({ cvBuilderId: z.number().int() });

/** CV builder → Generate: profile version from the CV-builder session, then the base CV, then its checks. */
export async function runBuildBaseCv(ctx: TaskContext): Promise<{ docId: number; version: number; blocking: number }> {
  const { cvBuilderId } = payloadSchema.parse(ctx.payload);
  ctx.progress({ stage: "building" });
  const doc = await generateBaseCv({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, cvBuilderId, { onStage: (stage) => ctx.progress({ stage }) });
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

/** The Generate run in progress, if any (the review page follows it after a reload). */
export function runningBuildBaseCv(db: Db, userId: number): number | null {
  return activeTask(db, userId, BUILD_BASE_CV_TASK);
}

/**
 * Queues Generate (or returns the run already in progress). Refused while a CV upload is being read:
 * both write a new profile version.
 */
export function startBuildBaseCv(db: Db, userId: number, cvBuilderId: number): number {
  if (!getCvBuilder(db, userId, cvBuilderId)) throw new UserFacingError("not_found");
  const running = activeTask(db, userId, BUILD_BASE_CV_TASK);
  if (running) return running;
  if (activeTask(db, userId, EXTRACT_PROFILE_TASK)) throw new UserFacingError("task_running");
  return enqueueTask(db, userId, BUILD_BASE_CV_TASK, { cvBuilderId }).id;
}
