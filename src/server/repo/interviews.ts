import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/database";
import { conversations, cvInterviews, interviewAnswers, interviewConversations, type CvInterviewRow, type InterviewAnswerRow, type InterviewConversationRow } from "../db/schema";
import { UserFacingError } from "../errors";
import {
  FORM_SECTIONS,
  interviewFormSchema,
  parseInterviewForm,
  roleFormSchema,
  type InterviewForm,
  type InterviewStage,
  type InterviewTopic,
  type StageStatus,
} from "@/shared/schemas/interview";

/** Guided CV builder interviews: the form, per-stage status, stage conversations and recorded answers. */

export interface Interview extends Omit<CvInterviewRow, "form" | "stages"> {
  form: InterviewForm;
  stages: Record<string, StageStatus>;
}

function toInterview(row: CvInterviewRow): Interview {
  return { ...row, form: parseInterviewForm(row.form), stages: (row.stages ?? {}) as Record<string, StageStatus> };
}

export function createInterview(db: Db, userId: number, setup: Partial<InterviewForm["setup"]> = {}): Interview {
  const form = interviewFormSchema.parse({ setup, contact: { cvLanguage: setup.language ?? "en" } });
  const row = db
    .insert(cvInterviews)
    .values({ userId, depth: form.setup.depth, personas: form.setup.personas, targetCountry: form.setup.country, language: form.setup.language, form, stage: "setup", stages: {} })
    .returning()
    .get();
  return toInterview(row);
}

/** The interview in progress, if any (newest first). */
export function getActiveInterview(db: Db, userId: number): Interview | null {
  const row = db
    .select()
    .from(cvInterviews)
    .where(and(eq(cvInterviews.userId, userId), eq(cvInterviews.status, "in_progress")))
    .orderBy(desc(cvInterviews.id))
    .get();
  return row ? toInterview(row) : null;
}

/** The newest interview of any status (the page shows a completed one with its base CV). */
export function getLatestInterview(db: Db, userId: number): Interview | null {
  const row = db.select().from(cvInterviews).where(and(eq(cvInterviews.userId, userId))).orderBy(desc(cvInterviews.id)).get();
  return row ? toInterview(row) : null;
}

export function getInterview(db: Db, userId: number, id: number): Interview | null {
  const row = db
    .select()
    .from(cvInterviews)
    .where(and(eq(cvInterviews.userId, userId), eq(cvInterviews.id, id)))
    .get();
  return row ? toInterview(row) : null;
}

export function updateInterview(db: Db, id: number, patch: Partial<Omit<typeof cvInterviews.$inferInsert, "id" | "userId">>): void {
  db.update(cvInterviews)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(cvInterviews.id, id))
    .run();
}

export type FormStage = keyof typeof FORM_SECTIONS;

/**
 * Saves one form stage (validated with the stage's schema; missing fields take their defaults).
 * Setup also updates the columns it mirrors; the current-role form seeds the first role when the
 * role table is still empty, so the current-role chat has an "exp-N" to file answers under.
 */
export function saveStageForm(db: Db, interview: Interview, stage: FormStage, value: unknown): Interview {
  const sections = FORM_SECTIONS[stage];
  const patch = (Array.isArray(sections) ? Object.fromEntries(sections.map((s) => [s, (value as Record<string, unknown> | null)?.[s]])) : { [sections as string]: value }) as Partial<InterviewForm>;
  const parsed = interviewFormSchema.safeParse({ ...interview.form, ...patch });
  if (!parsed.success) throw new UserFacingError("invalid");
  const form = parsed.data;
  if (stage === "roles") {
    const ids = form.roles.map((r) => r.id);
    if (new Set(ids).size !== ids.length) throw new UserFacingError("invalid");
  }
  if (stage === "current" && !form.roles.length && form.current.title.trim() && ["employed", "self_employed"].includes(form.current.status)) {
    form.roles = [
      roleFormSchema.parse({ id: "exp-1", title: form.current.title, company: form.current.company, start: form.current.start, country: form.current.country, end: "" }),
    ];
  }
  const columns = stage === "setup" ? { depth: form.setup.depth, personas: form.setup.personas, targetCountry: form.setup.country, language: form.setup.language } : {};
  updateInterview(db, interview.id, { form, ...columns });
  return { ...interview, ...columns, form };
}

export function setStageStatus(db: Db, interview: Interview, key: string, status: StageStatus, nextStage?: InterviewStage): Interview {
  const stages = { ...interview.stages, [key]: status };
  updateInterview(db, interview.id, { stages, ...(nextStage ? { stage: nextStage } : {}) });
  return { ...interview, stages, ...(nextStage ? { stage: nextStage } : {}) };
}

export function setCurrentStage(db: Db, interview: Interview, stage: InterviewStage): Interview {
  updateInterview(db, interview.id, { stage });
  return { ...interview, stage };
}

// ---- Stage conversations ----

export function linkConversation(db: Db, conversationId: number, interviewId: number, stage: InterviewStage, experienceRef: string | null): void {
  db.insert(interviewConversations).values({ conversationId, interviewId, stage, experienceRef }).run();
}

export function interviewForConversation(db: Db, conversationId: number): InterviewConversationRow | null {
  return db.select().from(interviewConversations).where(eq(interviewConversations.conversationId, conversationId)).get() ?? null;
}

/** The conversation of one stage (and role), newest first. */
export function stageConversation(db: Db, interviewId: number, stage: InterviewStage, experienceRef: string | null): InterviewConversationRow | null {
  return (
    db
      .select()
      .from(interviewConversations)
      .where(
        and(
          eq(interviewConversations.interviewId, interviewId),
          eq(interviewConversations.stage, stage),
          experienceRef === null ? isNull(interviewConversations.experienceRef) : eq(interviewConversations.experienceRef, experienceRef),
        ),
      )
      .orderBy(desc(interviewConversations.conversationId))
      .get() ?? null
  );
}

// ---- Answers ----

export interface NewAnswer {
  interviewId: number;
  stage: InterviewStage;
  topic: InterviewTopic;
  experienceRef: string | null;
  question: string;
  quote: string;
  private: boolean;
  origin: "chat" | "user_edit" | "form";
  messageId: number | null;
}

export function insertAnswer(db: Db, answer: NewAnswer): InterviewAnswerRow {
  return db.insert(interviewAnswers).values(answer).returning().get();
}

export function listAnswers(db: Db, interviewId: number, options: { includeSuperseded?: boolean; includePrivate?: boolean } = {}): InterviewAnswerRow[] {
  const rows = db.select().from(interviewAnswers).where(eq(interviewAnswers.interviewId, interviewId)).orderBy(asc(interviewAnswers.id)).all();
  return rows.filter((a) => (options.includeSuperseded || a.supersededBy === null) && (options.includePrivate || !a.private));
}

function ownAnswer(db: Db, interview: Interview, answerId: number): InterviewAnswerRow {
  const row = db
    .select()
    .from(interviewAnswers)
    .where(and(eq(interviewAnswers.interviewId, interview.id), eq(interviewAnswers.id, answerId)))
    .get();
  if (!row || row.supersededBy !== null) throw new UserFacingError("not_found");
  return row;
}

/** An edit is a new answer in the user's words that supersedes the old one (the old one stays for the record). */
export function editAnswer(db: Db, interview: Interview, answerId: number, patch: { quote?: string; private?: boolean }): InterviewAnswerRow {
  const old = ownAnswer(db, interview, answerId);
  const quote = (patch.quote ?? old.quote).replace(/\s+/g, " ").trim();
  if (quote.length < 2 || quote.length > 4000) throw new UserFacingError("invalid");
  return db.transaction((tx) => {
    const next = tx
      .insert(interviewAnswers)
      .values({ interviewId: interview.id, stage: old.stage, topic: old.topic, experienceRef: old.experienceRef, question: old.question, quote, private: patch.private ?? old.private, origin: "user_edit", messageId: null })
      .returning()
      .get();
    tx.update(interviewAnswers).set({ supersededBy: next.id }).where(eq(interviewAnswers.id, old.id)).run();
    return next;
  });
}

/** Deleting removes the answer and every earlier version of it: it is the user's data. */
export function deleteAnswer(db: Db, interview: Interview, answerId: number): void {
  ownAnswer(db, interview, answerId);
  const all = listAnswers(db, interview.id, { includeSuperseded: true, includePrivate: true });
  const ids = new Set([answerId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of all) {
      if (a.supersededBy === null || !ids.has(a.supersededBy) || ids.has(a.id)) continue;
      ids.add(a.id);
      grew = true;
    }
  }
  db.delete(interviewAnswers).where(inArray(interviewAnswers.id, [...ids])).run();
}

/** Deletes the interview, its answers and its conversations (with every chat message in them). */
export function discardInterview(db: Db, interview: Interview): void {
  db.transaction((tx) => {
    const ids = tx.select({ id: interviewConversations.conversationId }).from(interviewConversations).where(eq(interviewConversations.interviewId, interview.id)).all().map((r) => r.id);
    tx.delete(cvInterviews).where(eq(cvInterviews.id, interview.id)).run();
    if (ids.length) tx.delete(conversations).where(inArray(conversations.id, ids)).run();
  });
}
