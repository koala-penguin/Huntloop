"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appContext } from "@/server/context";
import { errorCodeOf } from "@/server/errors";
import { getJob } from "@/server/repo/jobs";
import { enqueueTask } from "@/server/tasks/runner";
import { WATCH_CHECK_TASK } from "@/server/tasks/handlers/watch-check";
import { addWatch, getWatch, importMatches, importOpening, removeWatch, setAutoCheck } from "@/server/watchlist/watchlist";
import type { ActionResult } from "@/app/profile/actions";

/** Server actions for the employer watchlist (Search → Employers you watch). */

function fail(error: unknown): { ok: false; error: string } {
  const code = errorCodeOf(error);
  if (!code) throw error;
  return { ok: false, error: code };
}

const MAX_BULK_IMPORT = 10;

/** Watch a board by link, then check it straight away. */
export async function addWatchAction(url: string): Promise<ActionResult<{ watchId: number; taskId: number }>> {
  if (!z.string().max(2000).safeParse(url).success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  try {
    const watch = addWatch(db, user.id, { url });
    const task = enqueueTask(db, user.id, WATCH_CHECK_TASK, { watchId: watch.id });
    revalidatePath("/search", "layout");
    return { ok: true, value: { watchId: watch.id, taskId: task.id } };
  } catch (error) {
    return fail(error);
  }
}

/** "Watch this employer's job board" from a job whose company Huntloop knows the board of. */
export async function watchJobCompanyAction(jobId: number): Promise<ActionResult<{ watchId: number }>> {
  const { db, user } = appContext();
  const job = getJob(db, user.id, jobId);
  if (!job?.companyId) return { ok: false, error: "unsupported_board" };
  try {
    const watch = addWatch(db, user.id, { companyId: job.companyId });
    enqueueTask(db, user.id, WATCH_CHECK_TASK, { watchId: watch.id });
    revalidatePath("/", "layout");
    return { ok: true, value: { watchId: watch.id } };
  } catch (error) {
    return fail(error);
  }
}

export async function checkWatchAction(watchId: number): Promise<ActionResult<{ taskId: number }>> {
  const { db, user } = appContext();
  if (!getWatch(db, user.id, watchId)) return { ok: false, error: "not_found" };
  return { ok: true, value: { taskId: enqueueTask(db, user.id, WATCH_CHECK_TASK, { watchId }).id } };
}

export async function setAutoCheckAction(watchId: number, autoCheck: boolean): Promise<ActionResult<null>> {
  const { db, user } = appContext();
  setAutoCheck(db, user.id, watchId, autoCheck === true);
  revalidatePath("/search", "layout");
  return { ok: true, value: null };
}

export async function removeWatchAction(watchId: number): Promise<ActionResult<null>> {
  const { db, user } = appContext();
  removeWatch(db, user.id, watchId);
  revalidatePath("/search", "layout");
  return { ok: true, value: null };
}

export async function importOpeningAction(openingId: number): Promise<ActionResult<{ jobId: number }>> {
  const { db, user } = appContext();
  try {
    const { jobId } = await importOpening(db, user.id, openingId);
    revalidatePath("/", "layout");
    return { ok: true, value: { jobId } };
  } catch (error) {
    return fail(error);
  }
}

export async function importMatchesAction(watchId: number): Promise<ActionResult<{ count: number }>> {
  const { db, user } = appContext();
  try {
    const count = await importMatches(db, user.id, watchId, MAX_BULK_IMPORT);
    revalidatePath("/", "layout");
    return { ok: true, value: { count } };
  } catch (error) {
    return fail(error);
  }
}
