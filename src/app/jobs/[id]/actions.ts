"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { JOB_STATUSES } from "@/shared/schemas/job";
import { isOutcomeStatus, outcomeSchema } from "@/shared/schemas/pipeline";
import { WORK_RIGHT_STATUSES } from "@/shared/schemas/profile";
import { marketPack } from "@/shared/markets";
import { isCountryCode } from "@/shared/countries";
import { appContext } from "@/server/context";
import { deleteJob, setJobAnswer, setJobStatus } from "@/server/repo/jobs";
import { getCurrentProfile, saveProfileVersion } from "@/server/repo/profile";
import { rescoreAllJobs } from "@/server/jobs/fit";
import { findOnEmployerSite, readFullPosting, reassessJob, saveJobText } from "@/server/jobs/intake";
import { errorCodeOf } from "@/server/errors";
import { resolveChatAction } from "@/server/ai/chat/actions";
import { createJobConversation, getJobConversation, isConversationBusy } from "@/server/ai/chat/harness";
import { getJob } from "@/server/repo/jobs";
import { startCompanyResearch } from "@/server/research/company";
import type { ActionResult } from "@/app/profile/actions";

function fail(error: unknown): { ok: false; error: string } {
  const code = errorCodeOf(error);
  if (!code) throw error;
  return { ok: false, error: code };
}

export async function setJobStatusAction(jobId: number, status: string, outcome?: unknown): Promise<ActionResult<null>> {
  const parsed = z.enum(JOB_STATUSES).safeParse(status);
  const parsedOutcome = outcome === undefined || outcome === null ? null : outcomeSchema.safeParse(outcome);
  if (!parsed.success || (parsedOutcome && !parsedOutcome.success)) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  setJobStatus(db, user.id, jobId, parsed.data, undefined, parsedOutcome?.success && isOutcomeStatus(parsed.data) ? parsedOutcome.data : undefined);
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

export async function resolveChatActionAction(actionId: number, decision: "accept" | "dismiss"): Promise<ActionResult<null>> {
  if (!["accept", "dismiss"].includes(decision)) return { ok: false, error: "invalid" };
  const { ai } = appContext();
  try {
    resolveChatAction(ai, actionId, decision);
  } catch (error) {
    return fail(error);
  }
  revalidatePath("/", "layout");
  return { ok: true, value: null };
}

/** Starts a fresh conversation (e.g. after the posting was re-analysed). The old one is kept. */
export async function newConversationAction(jobId: number): Promise<ActionResult<null>> {
  const { db, user, ai } = appContext();
  const job = getJob(db, user.id, jobId);
  if (!job) return { ok: false, error: "not_found" };
  const current = getJobConversation(ai, jobId);
  if (current && isConversationBusy(current.id)) return { ok: false, error: "chat_busy" };
  createJobConversation(ai, job);
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, value: null };
}

export async function startResearchAction(jobId: number, force: boolean): Promise<ActionResult<{ taskId: number | null }>> {
  const { db, user } = appContext();
  const job = getJob(db, user.id, jobId);
  if (!job) return { ok: false, error: "not_found" };
  const result = startCompanyResearch(db, user.id, job, { force: !!force });
  if (!result.ok) return { ok: false, error: result.reason };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, value: { taskId: result.taskId } };
}

export async function readFullPostingAction(jobId: number): Promise<ActionResult<{ taskId: number }>> {
  const { db, user } = appContext();
  try {
    const taskId = readFullPosting(db, user.id, jobId);
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true, value: { taskId } };
  } catch (error) {
    return fail(error);
  }
}

export async function findOnEmployerSiteAction(jobId: number): Promise<ActionResult<{ taskId: number }>> {
  const { db, user } = appContext();
  try {
    return { ok: true, value: { taskId: findOnEmployerSite(db, user.id, jobId) } };
  } catch (error) {
    return fail(error);
  }
}
