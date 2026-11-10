"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { acceptEditedPolish } from "@/server/ai/chat/actions";
import { acceptFormCard, continueBlockers, continueDataStage, saveOnFile } from "@/server/ai/chat/interview-forms";
import { appContext } from "@/server/context";
import { errorCodeOf, UserFacingError } from "@/server/errors";
import { isConversationBusy } from "@/server/ai/chat/harness";
import {
  completeChatStage,
  createInterview,
  deleteAnswer,
  discardInterview,
  editAnswer,
  getActiveInterview,
  getInterview,
  reopenStage,
  saveStageForm,
  setCurrentStage,
  setStageStatus,
  stageConversation,
  stageHasAnswers,
  updateInterview,
  type FormStage,
  type Interview,
} from "@/server/repo/interviews";
import { startBuildBaseCv } from "@/server/tasks/handlers/build-base-cv";
import { applyInterviewEdits, targetFromPreferences } from "@/server/cv/interview-build";
import { getPreferences } from "@/server/repo/profile";
import {
  CONVERSATION_STAGES,
  DATA_CHAT_STAGES,
  FORM_CARD_STAGES,
  FORM_SECTIONS,
  INTERVIEW_STAGES,
  contactFormSchema,
  interviewSkillSchema,
  setupFormSchema,
  stageFormIssues,
  stageRequirements,
  type InterviewStage,
} from "@/shared/schemas/interview";
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

/** Like ActionResult, with the fields that stopped it ("roles.1.start", "contact.email") when there are any. */
export type StageResult = { ok: true; value: null } | { ok: false; error: string; fields?: string[] };

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
  // The target form starts from the saved search preferences, so Generate doesn't undo them.
  // The setup step goes on in a short chat about their situation; Continue there moves on to the target.
  interview = saveStageForm(db, interview, "target", targetFromPreferences(getPreferences(db, user.id), parsed.data.country));
  return done({ id: interview.id });
}

/**
 * Saves a form stage; with `advance`, marks it done and moves on to the next stage. The contact
 * step is checked here: a malformed email or phone is never saved, and moving on needs a name and an email.
 */
export async function saveStageFormAction(interviewId: number, stage: string, value: unknown, advance = false): Promise<StageResult> {
  const parsedStage = formStageSchema.safeParse(stage);
  if (!parsedStage.success) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (interview.status === "abandoned") return { ok: false, error: "not_found" };
    if (parsedStage.data === "contact") {
      const contact = contactFormSchema.safeParse(value ?? {});
      if (!contact.success) return { ok: false, error: "invalid" };
      const issues = stageFormIssues("contact", contact.data);
      if (issues.length) return { ok: false, error: "invalid", fields: issues };
      const missing = advance ? stageRequirements("contact", { ...interview.form, contact: contact.data }) : [];
      if (missing.length) return { ok: false, error: "stage_incomplete", fields: missing };
    }
    const saved = saveStageForm(db, interview, parsedStage.data, value);
    if (advance) setStageStatus(db, saved, parsedStage.data, "done", nextStage(parsedStage.data));
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/**
 * The candidate takes a card from a data chat, with whatever they changed on it. The only way a
 * chat's proposal reaches the interview form.
 */
export async function acceptFormCardAction(interviewId: number, actionId: number, value: unknown): Promise<StageResult> {
  if (typeof actionId !== "number") return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (interview.status !== "in_progress") return { ok: false, error: "invalid" };
    const result = acceptFormCard({ db }, interview, actionId, value);
    if (!result.ok) return result;
    return done(null);
  } catch (error) {
    revalidatePath("/profile/interview");
    return fail(error);
  }
}

/** Saves a step's data from the "On file" editor: the whole section as edited, so a removed row stays removed. */
export async function saveOnFileAction(interviewId: number, stage: string, value: unknown): Promise<StageResult> {
  const parsedStage = z.enum(FORM_CARD_STAGES).safeParse(stage);
  if (!parsedStage.success) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (interview.status !== "in_progress") return { ok: false, error: "invalid" };
    const result = saveOnFile(db, interview, parsedStage.data, value);
    return result.ok ? done(null) : result;
  } catch (error) {
    return fail(error);
  }
}

/** Continue on a data step: refused while something required is missing or a card is still waiting. */
export async function completeDataStageAction(interviewId: number, stage: string): Promise<StageResult> {
  const parsedStage = z.enum(DATA_CHAT_STAGES).safeParse(stage);
  if (!parsedStage.success) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (interview.status !== "in_progress") return { ok: false, error: "invalid" };
    const result = continueDataStage(db, interview, parsedStage.data);
    return result.ok ? done(null) : result;
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

/** Undoes a skip, or reopens a finished part (a stage, or one role's chat "role:exp-N"). */
export async function reopenStageAction(interviewId: number, key: string): Promise<ActionResult<null>> {
  const role = /^role:exp-\d+$/.test(key);
  const stage = stageSchema.safeParse(key);
  if ((!role && !stage.success) || key === "review") return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    if (interview.status !== "in_progress") return { ok: false, error: "invalid" };
    reopenStage(db, interview, key);
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/** The user's own edit of a cleaner version the interviewer offered: their words, so no check beyond length. */
export async function acceptPolishAction(interviewId: number, actionId: number, text: string): Promise<ActionResult<null>> {
  if (typeof actionId !== "number" || typeof text !== "string") return { ok: false, error: "invalid" };
  try {
    const { interview } = own(interviewId);
    if (acceptEditedPolish(appContext().ai, interview, actionId, text)) revalidatePath("/", "layout");
    return done(null);
  } catch (error) {
    return fail(error);
  }
}

/** Moves to a stage (the stage rail, or Continue after a chat — which marks that chat, and maybe its stage, done). */
export async function goToStageAction(interviewId: number, stage: string, completed: string[] = []): Promise<StageResult> {
  const parsed = stageSchema.safeParse(stage);
  const keys = Array.isArray(completed) ? completed : [];
  if (!parsed.success || !keys.every((k) => typeof k === "string" && (stageSchema.safeParse(k).success || /^role:exp-\d+$/.test(k)))) return { ok: false, error: "invalid" };
  try {
    const { db, interview } = own(interviewId);
    let current = interview;
    // Continue after the current-situation chat needs the job on file, and no card left waiting.
    if (keys.includes("current") && interview.status === "in_progress") {
      const blocked = continueBlockers(db, interview, "current");
      if (!blocked.ok) return blocked;
    }
    // A part skipped and then answered anyway counts as done; skipped and empty stays skipped.
    for (const key of keys) current = completeChatStage(db, current, key, key === "role_deep" ? true : stageHasAnswers(db, current, key));
    setCurrentStage(db, current, parsed.data);
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
    if (applyInterviewEdits(db, interview.userId, interview)) revalidatePath("/", "layout");
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
    if (applyInterviewEdits(db, interview.userId, interview)) revalidatePath("/", "layout");
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
    for (const stage of CONVERSATION_STAGES) {
      for (const ref of stage === "role_deep" ? interview.form.roles.map((r) => r.id) : [null]) {
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
