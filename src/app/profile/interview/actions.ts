"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appContext } from "@/server/context";
import { errorCodeOf, UserFacingError } from "@/server/errors";
import { isConversationBusy } from "@/server/ai/chat/harness";
import {
  createInterview,
  deleteAnswer,
  discardInterview,
  editAnswer,
  getActiveInterview,
  getInterview,
  saveStageForm,
  setCurrentStage,
  setStageStatus,
  stageConversation,
  updateInterview,
  type FormStage,
  type Interview,
} from "@/server/repo/interviews";
import { startBuildBaseCv } from "@/server/tasks/handlers/build-base-cv";
import { FORM_SECTIONS, INTERVIEW_STAGES, interviewSkillSchema, setupFormSchema, type InterviewStage } from "@/shared/schemas/interview";
import { SKILL_CATEGORIES } from "@/shared/schemas/profile";
import type { ActionResult } from "@/app/profile/actions";

/** Server actions for the CV builder interview (Profile → Build by interview). */

function fail(error: unknown): { ok: false; error: string } {
  const code = errorCodeOf(error);
  if (!code) throw error;
  return { ok: false, error: code };
}

function done<T>(value: T): ActionResult<T> {
  revalidatePath("/profile/interview");
  return { ok: true, value };
}

function own(interviewId: number): { db: ReturnType<typeof appContext>["db"]; interview: Interview } {
  const { db, user } = appContext();
  const interview = typeof interviewId === "number" ? getInterview(db, user.id, interviewId) : null;
  if (!interview) throw new UserFacingError("not_found");
  return { db, interview };
}

const stageSchema = z.enum(INTERVIEW_STAGES);
const formStageSchema = z.enum(Object.keys(FORM_SECTIONS) as [FormStage, ...FormStage[]]);

/** The stage after `stage` in the interview's order. */
function nextStage(stage: InterviewStage): InterviewStage {
  return INTERVIEW_STAGES[Math.min(INTERVIEW_STAGES.indexOf(stage) + 1, INTERVIEW_STAGES.length - 1)];
}

/** Starts an interview (or returns the one already in progress). */
export async function startInterviewAction(setup: unknown): Promise<ActionResult<{ id: number }>> {
  const parsed = setupFormSchema.safeParse(setup ?? {});
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  const active = getActiveInterview(db, user.id);
  if (active) return done({ id: active.id });
  let interview = createInterview(db, user.id, parsed.data);
  interview = setStageStatus(db, interview, "setup", "done", "target");
  return done({ id: interview.id });
}

/** Saves a form stage; with `advance`, marks it done and moves on to the next stage. */
export async function saveStageFormAction(interviewId: number, stage: string, value: unknown, advance = false): Promise<ActionResult<null>> {
  const parsedStage = formStageSchema.safeParse(stage);
  if (!parsedStage.success) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (interview.status === "abandoned") return { ok: false, error: "not_found" };
    const saved = saveStageForm(db, interview, parsedStage.data, value);
    if (advance) setStageStatus(db, saved, parsedStage.data, "done", nextStage(parsedStage.data));
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/** Skips a stage (or one role's chat, key "role:exp-N"); skipping a stage moves on. */
export async function skipStageAction(interviewId: number, key: string): Promise<ActionResult<null>> {
  const role = /^role:exp-\d+$/.test(key);
  const stage = stageSchema.safeParse(key);
  if (!role && !stage.success) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    setStageStatus(db, interview, key, "skipped", stage.success ? nextStage(stage.data) : undefined);
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/** Moves to a stage (the stage rail, or Continue after a chat stage — which also marks it done). */
export async function goToStageAction(interviewId: number, stage: string, completed?: string): Promise<ActionResult<null>> {
  const parsed = stageSchema.safeParse(stage);
  const finished = completed === undefined ? null : stageSchema.safeParse(completed);
  if (!parsed.success || (finished && !finished.success)) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (finished?.success && interview.stages[finished.data] !== "skipped") setStageStatus(db, interview, finished.data, "done", parsed.data);
    else setCurrentStage(db, interview, parsed.data);
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

const answerPatch = z.object({ quote: z.string().trim().min(2).max(4000).optional(), private: z.boolean().optional() });

/** The user changes a recorded answer (their own words again) or marks it private. */
export async function editAnswerAction(interviewId: number, answerId: number, patch: unknown): Promise<ActionResult<null>> {
  const parsed = answerPatch.safeParse(patch);
  if (!parsed.success || typeof answerId !== "number") return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    editAnswer(db, interview, answerId, parsed.data);
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

export async function deleteAnswerAction(interviewId: number, answerId: number): Promise<ActionResult<null>> {
  if (typeof answerId !== "number") return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    deleteAnswer(db, interview, answerId);
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/** Ticks or unticks a skill the interviewer noted. Only ticked skills reach the profile. */
export async function toggleSkillAction(interviewId: number, name: string, ticked: boolean): Promise<ActionResult<null>> {
  if (typeof name !== "string" || typeof ticked !== "boolean") return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    const skills = interview.form.skills.map((s) => (s.name === name ? { ...s, ticked } : s));
    if (!skills.some((s) => s.name === name)) return { ok: false, error: "not_found" };
    updateInterview(db, interview.id, { form: { ...interview.form, skills } });
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/** A skill the user adds themselves (their own words, so it starts ticked). */
export async function addSkillAction(interviewId: number, name: string, category: string): Promise<ActionResult<null>> {
  const parsed = interviewSkillSchema.safeParse({ name: typeof name === "string" ? name.trim() : name, category: z.enum(SKILL_CATEGORIES).catch("other").parse(category), ticked: true });
  if (!parsed.success) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (interview.form.skills.some((s) => s.name.toLowerCase() === parsed.data.name.toLowerCase())) return done(null);
    updateInterview(db, interview.id, { form: { ...interview.form, skills: [...interview.form.skills, parsed.data] } });
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/** Generate: queues the profile + base CV task. */
export async function generateBaseCvAction(interviewId: number): Promise<ActionResult<{ taskId: number }>> {
  try {
    const { db, interview } = own(interviewId);
    return { ok: true, value: { taskId: startBuildBaseCv(db, interview.userId, interview.id) } };
  } catch (error) {
    return fail(error);
  }
}

/** Deletes the interview with every answer and chat message in it (the saved profile and CV stay). */
export async function discardInterviewAction(interviewId: number): Promise<ActionResult<null>> {
  try {
    const { db, interview } = own(interviewId);
    for (const stage of ["current", "role_deep"] as const) {
      for (const ref of stage === "current" ? [null] : interview.form.roles.map((r) => r.id)) {
        const link = stageConversation(db, interview.id, stage, ref);
        if (link && isConversationBusy(link.conversationId)) return { ok: false, error: "chat_busy" };
      }
    }
    discardInterview(db, interview);
    return done(null);
  } catch (error) {
    return fail(error);
  }
}
