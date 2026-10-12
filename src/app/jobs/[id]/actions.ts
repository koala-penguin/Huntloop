"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { JOB_STATUSES } from "@/shared/schemas/job";
import { WORK_RIGHT_STATUSES } from "@/shared/schemas/profile";
import { marketPack } from "@/shared/markets";
import { isCountryCode } from "@/shared/countries";
import { appContext } from "@/server/context";
import { deleteJob, setJobAnswer, setJobStatus } from "@/server/repo/jobs";
import { getCurrentProfile, saveProfileVersion } from "@/server/repo/profile";
import { rescoreAllJobs } from "@/server/jobs/fit";
import { reassessJob, saveJobText } from "@/server/jobs/intake";
import { errorCodeOf } from "@/server/errors";
import type { ActionResult } from "@/app/profile/actions";

function fail(error: unknown): { ok: false; error: string } {
  const code = errorCodeOf(error);
  if (!code) throw error;
  return { ok: false, error: code };
}

export async function setJobStatusAction(jobId: number, status: string): Promise<ActionResult<null>> {
  const parsed = z.enum(JOB_STATUSES).safeParse(status);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  setJobStatus(db, user.id, jobId, parsed.data);
  revalidatePath("/", "layout");
  return { ok: true, value: null };
}

export async function answerRequirementAction(jobId: number, requirementId: string, answer: "yes" | "no" | null): Promise<ActionResult<null>> {
  const parsed = z.object({ requirementId: z.string().max(20), answer: z.enum(["yes", "no"]).nullable() }).safeParse({ requirementId, answer });
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  setJobAnswer(db, user.id, jobId, parsed.data.requirementId, parsed.data.answer);
  revalidatePath("/", "layout");
  return { ok: true, value: null };
}

/** Answers "Do you have work rights in {country}?" — saved to the profile; every job re-tiers in code. */
export async function setWorkRightAction(country: string, optionId: string): Promise<ActionResult<null>> {
  if (!isCountryCode(country)) return { ok: false, error: "invalid" };
  const pack = marketPack(country);
  const option = optionId === "unknown" ? null : pack.workRightOptions.find((o) => o.id === optionId);
  if (optionId !== "unknown" && !option) return { ok: false, error: "invalid" };
  const status = option ? option.status : ("unknown" as (typeof WORK_RIGHT_STATUSES)[number]);
  const { db, user } = appContext();
  const profile = getCurrentProfile(db, user.id);
  if (!profile) return { ok: false, error: "no_profile" };
  const workRights = profile.data.workRights.filter((w) => w.country !== country);
  workRights.push({ country, status, option: option?.id ?? null, expires: null, note: null });
  saveProfileVersion(db, user.id, { cvText: profile.cvText, data: { ...profile.data, workRights } });
  rescoreAllJobs(db, user.id);
  revalidatePath("/", "layout");
  return { ok: true, value: null };
}

export async function reassessJobAction(jobId: number): Promise<ActionResult<{ taskId: number }>> {
  const { db, user } = appContext();
  try {
    return { ok: true, value: { taskId: reassessJob(db, user.id, jobId) } };
  } catch (error) {
    return fail(error);
  }
}

export async function saveJobTextAction(jobId: number, text: string): Promise<ActionResult<{ taskId: number }>> {
  if (typeof text !== "string") return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  try {
    const taskId = saveJobText(db, user.id, jobId, text);
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, value: { taskId } };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteJobAction(jobId: number): Promise<ActionResult<null>> {
  const { db, user } = appContext();
  deleteJob(db, user.id, jobId);
  revalidatePath("/", "layout");
  return { ok: true, value: null };
}
