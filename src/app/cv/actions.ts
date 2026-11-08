"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { appContext } from "@/server/context";
import { errorCodeOf } from "@/server/errors";
import { proceedWithJob, startLinkedinDraft, startTailoring } from "@/server/jobs/proceed";
import { getCvDocument } from "@/server/repo/cv-documents";
import { answerCvQuestion, resolveCvLine } from "@/server/cv/resolve";
import { CV_LANGUAGES } from "@/shared/schemas/cv";
import type { ActionResult } from "@/app/profile/actions";

/** Server actions for tailored CVs (job page → CV tab) and LinkedIn drafts (profile → LinkedIn tab). */

function fail(error: unknown): { ok: false; error: string } {
  const code = errorCodeOf(error);
  if (!code) throw error;
  return { ok: false, error: code };
}

/** "Proceed": status → Applying, employer research, and a tailored CV draft. */
export async function proceedAction(jobId: number): Promise<ActionResult<{ taskId: number | null }>> {
  const { db, user } = appContext();
  try {
    const result = proceedWithJob(db, user.id, jobId, "button");
    revalidatePath("/", "layout");
    return { ok: true, value: result };
  } catch (error) {
    return fail(error);
  }
}

/** Writes a new draft from scratch (e.g. after the profile changed). */
export async function tailorCvAction(jobId: number): Promise<ActionResult<{ taskId: number | null }>> {
  const { db, user } = appContext();
  return { ok: true, value: { taskId: startTailoring(db, user.id, jobId) } };
}

export async function reviseCvAction(docId: number, instructions: string): Promise<ActionResult<{ taskId: number | null }>> {
  const text = z.string().trim().min(3).max(2000).safeParse(instructions);
  if (!text.success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  const doc = getCvDocument(db, user.id, docId);
  if (!doc || doc.kind !== "cv" || !doc.jobId) return { ok: false, error: "not_found" };
  return { ok: true, value: { taskId: startTailoring(db, user.id, doc.jobId, { revise: { fromDocId: doc.id, instructions: text.data } }) } };
}

const lineAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove") }),
  z.object({ kind: z.literal("edit"), text: z.string().min(1).max(600) }),
  z.object({ kind: z.literal("confirm_fact") }),
]);

export async function resolveCvLineAction(docId: number, lineId: string, action: unknown): Promise<ActionResult<null>> {
  const parsed = lineAction.safeParse(action);
  if (!parsed.success || typeof lineId !== "string") return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  try {
    resolveCvLine(db, user.id, docId, lineId, parsed.data);
    revalidatePath("/", "layout");
    return { ok: true, value: null };
  } catch (error) {
    return fail(error);
  }
}

export async function answerCvQuestionAction(docId: number, questionIndex: number, answer: string): Promise<ActionResult<null>> {
  const { db, user } = appContext();
  try {
    answerCvQuestion(db, user.id, docId, questionIndex, answer);
    revalidatePath("/", "layout");
    return { ok: true, value: null };
  } catch (error) {
    return fail(error);
  }
}

export async function generateLinkedinAction(language: string): Promise<ActionResult<{ taskId: number }>> {
  const parsed = z.enum(CV_LANGUAGES).safeParse(language);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  try {
    return { ok: true, value: { taskId: startLinkedinDraft(db, user.id, parsed.data) } };
  } catch (error) {
    return fail(error);
  }
}
