import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/database";
import { conversations, cvBuilders, cvBuilderAnswers, cvBuilderConversations, type CvBuilderRow, type CvBuilderAnswerRow, type CvBuilderConversationRow } from "../db/schema";
import { UserFacingError } from "../errors";
import {
  FORM_SECTIONS,
  CV_BUILDER_STAGES,
  cvBuilderFormSchema,
  parseCvBuilderForm,
  roleFormSchema,
  type DataChatStage,
  type FormCardStage,
  type FormCardValue,
  type CvBuilderForm,
  type CvBuilderStage,
  type CvBuilderTopic,
  type StageStatus,
} from "@/shared/schemas/cv-builder";

/** The guided CV builder: the form, per-stage status, stage conversations and recorded answers. */

export interface CvBuilder extends Omit<CvBuilderRow, "form" | "stages"> {
  form: CvBuilderForm;
  stages: Record<string, StageStatus>;
}

function toCvBuilder(row: CvBuilderRow): CvBuilder {
  return { ...row, form: parseCvBuilderForm(row.form), stages: (row.stages ?? {}) as Record<string, StageStatus> };
}

export function createCvBuilder(db: Db, userId: number, setup: Partial<CvBuilderForm["setup"]> = {}): CvBuilder {
  const form = cvBuilderFormSchema.parse({ setup, contact: { cvLanguage: setup.language ?? "en" } });
  const row = db
    .insert(cvBuilders)
    .values({ userId, depth: form.setup.depth, personas: form.setup.personas, targetCountry: form.setup.country, language: form.setup.language, form, stage: "setup", stages: {} })
    .returning()
    .get();
  return toCvBuilder(row);
}

/** The CV-builder session in progress, if any (newest first). */
export function getActiveCvBuilder(db: Db, userId: number): CvBuilder | null {
  const row = db
    .select()
    .from(cvBuilders)
    .where(and(eq(cvBuilders.userId, userId), eq(cvBuilders.status, "in_progress")))
    .orderBy(desc(cvBuilders.id))
    .get();
  return row ? toCvBuilder(row) : null;
}

/** The newest CV-builder session of any status (the page shows a completed one with its base CV). */
export function getLatestCvBuilder(db: Db, userId: number): CvBuilder | null {
  const row = db.select().from(cvBuilders).where(and(eq(cvBuilders.userId, userId))).orderBy(desc(cvBuilders.id)).get();
  return row ? toCvBuilder(row) : null;
}

export function getCvBuilder(db: Db, userId: number, id: number): CvBuilder | null {
  const row = db
    .select()
    .from(cvBuilders)
    .where(and(eq(cvBuilders.userId, userId), eq(cvBuilders.id, id)))
    .get();
  return row ? toCvBuilder(row) : null;
}

export function updateCvBuilder(db: Db, id: number, patch: Partial<Omit<typeof cvBuilders.$inferInsert, "id" | "userId">>): void {
  db.update(cvBuilders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(cvBuilders.id, id))
    .run();
}

export type FormStage = keyof typeof FORM_SECTIONS;

/**
 * Saves one form stage (validated with the stage's schema; missing fields take their defaults).
 * Setup also updates the columns it mirrors; the current-role form seeds the first role when the
 * role table is still empty, so the current-role chat has an "exp-N" to file answers under.
 */
export function saveStageForm(db: Db, builder: CvBuilder, stage: FormStage, value: unknown): CvBuilder {
  const sections = FORM_SECTIONS[stage];
  const patch = (Array.isArray(sections) ? Object.fromEntries(sections.map((s) => [s, (value as Record<string, unknown> | null)?.[s]])) : { [sections as string]: value }) as Partial<CvBuilderForm>;
  const parsed = cvBuilderFormSchema.safeParse({ ...builder.form, ...patch });
  if (!parsed.success) throw new UserFacingError("invalid");
  const form = parsed.data;
  // Role ids are handed out here, never reused: answers, chats and stage status hang off them.
  let next = nextRoleNumber(db, builder);
  if (stage === "roles") {
    const kept = new Set(builder.form.roles.map((r) => r.id));
    const seen = new Set<string>();
    form.roles = form.roles.map((r) => {
      const fresh = !r.id.startsWith("exp-") || !kept.has(r.id) || seen.has(r.id);
      const role = fresh ? { ...r, id: `exp-${next++}` } : r;
      seen.add(role.id);
      return role;
    });
  }
  if (stage === "current" && !form.roles.length && form.current.title.trim() && ["employed", "self_employed"].includes(form.current.status)) {
    form.roles = [
      roleFormSchema.parse({ id: `exp-${next++}`, title: form.current.title, company: form.current.company, start: form.current.start, country: form.current.country, end: "" }),
    ];
  }
  const columns = stage === "setup" ? { depth: form.setup.depth, personas: form.setup.personas, targetCountry: form.setup.country, language: form.setup.language } : {};
  updateCvBuilder(db, builder.id, { form, ...columns });
  return { ...builder, ...columns, form };
}

/** Rows of `card` take the place of the saved rows with the same key; the rest are added at the end. */
function upsert<T>(saved: T[], card: T[], key: (row: T) => string): T[] {
  const incoming = new Map(card.map((row) => [key(row), row]));
  const keys = new Set(saved.map(key));
  return [...saved.map((row) => incoming.get(key(row)) ?? row), ...card.filter((row) => !keys.has(key(row)))];
}

/**
 * Turns a card's value into what saveStageForm takes for that stage. By default the card is merged
 * into what is saved (its rows update or add, nothing is removed); with `replace` (the "On file"
 * editor) the card is the whole section, so a removed row stays removed. A role marked current
 * loses its end date; rows without their key field (institution, certification name, language) are left out.
 */
export function mergeStagePatch(builder: CvBuilder, stage: FormCardStage, value: FormCardValue, options: { replace?: boolean } = {}): unknown {
  const { form } = builder;
  switch (stage) {
    case "setup":
      return options.replace ? value : { ...form.setup, ...(value as FormCardValue<"setup">) };
    case "target":
      return options.replace ? value : { ...form.target, ...(value as FormCardValue<"target">) };
    case "current":
      return options.replace ? value : { ...form.current, ...(value as FormCardValue<"current">) };
    case "roles": {
      const rows = (value as FormCardValue<"roles">).roles.map(({ current, ...role }) => ({ ...role, end: current ? "" : role.end }));
      return options.replace ? rows : upsert(form.roles, rows, (r) => r.id);
    }
    case "education": {
      const card = value as FormCardValue<"education">;
      const education = card.education.filter((e) => e.institution.trim());
      const certifications = card.certifications.filter((c) => c.name.trim());
      return options.replace
        ? { education, certifications }
        : { education: upsert(form.education, education, (e) => e.id), certifications: upsert(form.certifications, certifications, (c) => c.name.trim().toLowerCase()) };
    }
    case "languages": {
      const rows = (value as FormCardValue<"languages">).languages.filter((l) => l.language.trim() && l.level) as CvBuilderForm["languages"];
      return options.replace ? rows : upsert(form.languages, rows, (l) => l.language.trim().toLowerCase());
    }
  }
}

/** Whether a data step has anything saved. */
export function stageHasData(builder: CvBuilder, stage: CvBuilderStage): boolean {
  const { form } = builder;
  switch (stage) {
    case "setup":
      return form.setup.personas.length > 0;
    case "target":
      return form.target.titles.some((t) => t.trim());
    case "current":
      return !!form.current.title.trim() || form.current.status !== "employed";
    case "roles":
      return form.roles.length > 0;
    case "education":
      return form.education.length > 0 || form.certifications.length > 0;
    case "languages":
      return form.languages.length > 0;
    case "contact":
      return !!form.contact.name.trim() || !!form.contact.email.trim();
    default:
      return false;
  }
}

/**
 * Continue after a data step's chat: on to the next stage. A step skipped and then filled in
 * anyway counts as done; skipped and still empty stays skipped; anything else is done.
 */
export function completeDataStage(db: Db, builder: CvBuilder, stage: DataChatStage): CvBuilder {
  const next = CV_BUILDER_STAGES[Math.min(CV_BUILDER_STAGES.indexOf(stage) + 1, CV_BUILDER_STAGES.length - 1)];
  if (builder.stages[stage] === "skipped" && !stageHasData(builder, stage)) return setCurrentStage(db, builder, next);
  return setStageStatus(db, builder, stage, "done", next);
}

/** One more than every role number the CV-builder session has ever used (form, answers, chats, stage status). */
function nextRoleNumber(db: Db, builder: CvBuilder): number {
  const refs = [
    ...builder.form.roles.map((r) => r.id),
    ...Object.keys(builder.stages).map((k) => k.replace(/^role:/, "")),
    ...db.select({ ref: cvBuilderAnswers.experienceRef }).from(cvBuilderAnswers).where(eq(cvBuilderAnswers.cvBuilderId, builder.id)).all().map((r) => r.ref),
    ...db.select({ ref: cvBuilderConversations.experienceRef }).from(cvBuilderConversations).where(eq(cvBuilderConversations.cvBuilderId, builder.id)).all().map((r) => r.ref),
  ];
  return Math.max(0, ...refs.map((ref) => Number(/^exp-(\d+)$/.exec(ref ?? "")?.[1] ?? 0))) + 1;
}

export function setStageStatus(db: Db, builder: CvBuilder, key: string, status: StageStatus, nextStage?: CvBuilderStage): CvBuilder {
  const stages = { ...builder.stages, [key]: status };
  updateCvBuilder(db, builder.id, { stages, ...(nextStage ? { stage: nextStage } : {}) });
  return { ...builder, stages, ...(nextStage ? { stage: nextStage } : {}) };
}

/** Undo a skip, or reopen a finished part: back to "to do" (a stage also becomes the current one). */
export function reopenStage(db: Db, builder: CvBuilder, key: string): CvBuilder {
  return setStageStatus(db, builder, key, "pending", key.startsWith("role:") ? undefined : (key as CvBuilderStage));
}

/**
 * Continue after a chat. A part the user skipped and then answered anyway counts as done; a skipped
 * part with nothing in it stays skipped; anything else is done.
 */
export function completeChatStage(db: Db, builder: CvBuilder, key: string, hasAnswers: boolean): CvBuilder {
  if (builder.stages[key] === "skipped" && !hasAnswers) return builder;
  return setStageStatus(db, builder, key, "done");
}

/** Whether a stage key ("current", "role:exp-N") has any answer still in use. */
export function stageHasAnswers(db: Db, builder: CvBuilder, key: string): boolean {
  const ref = /^role:(exp-\d+)$/.exec(key)?.[1] ?? null;
  return listAnswers(db, builder.id, { includePrivate: true }).some((a) => (ref ? a.stage === "role_deep" && a.experienceRef === ref : a.stage === key));
}

export function setCurrentStage(db: Db, builder: CvBuilder, stage: CvBuilderStage): CvBuilder {
  updateCvBuilder(db, builder.id, { stage });
  return { ...builder, stage };
}

// ---- Stage conversations ----

export function linkConversation(db: Db, conversationId: number, cvBuilderId: number, stage: CvBuilderStage, experienceRef: string | null): void {
  db.insert(cvBuilderConversations).values({ conversationId, cvBuilderId, stage, experienceRef }).run();
}

export function cvBuilderForConversation(db: Db, conversationId: number): CvBuilderConversationRow | null {
  return db.select().from(cvBuilderConversations).where(eq(cvBuilderConversations.conversationId, conversationId)).get() ?? null;
}

/** The conversation of one stage (and role), newest first. */
export function stageConversation(db: Db, cvBuilderId: number, stage: CvBuilderStage, experienceRef: string | null): CvBuilderConversationRow | null {
  return (
    db
      .select()
      .from(cvBuilderConversations)
      .where(
        and(
          eq(cvBuilderConversations.cvBuilderId, cvBuilderId),
          eq(cvBuilderConversations.stage, stage),
          experienceRef === null ? isNull(cvBuilderConversations.experienceRef) : eq(cvBuilderConversations.experienceRef, experienceRef),
        ),
      )
      .orderBy(desc(cvBuilderConversations.conversationId))
      .get() ?? null
  );
}

// ---- Answers ----

export interface NewAnswer {
  cvBuilderId: number;
  stage: CvBuilderStage;
  topic: CvBuilderTopic;
  experienceRef: string | null;
  question: string;
  quote: string;
  private: boolean;
  origin: "chat" | "user_edit" | "form";
  messageId: number | null;
}

export function insertAnswer(db: Db, answer: NewAnswer): CvBuilderAnswerRow {
  return db.insert(cvBuilderAnswers).values(answer).returning().get();
}

export function listAnswers(db: Db, cvBuilderId: number, options: { includeSuperseded?: boolean; includePrivate?: boolean } = {}): CvBuilderAnswerRow[] {
  const rows = db.select().from(cvBuilderAnswers).where(eq(cvBuilderAnswers.cvBuilderId, cvBuilderId)).orderBy(asc(cvBuilderAnswers.id)).all();
  return rows.filter((a) => (options.includeSuperseded || a.supersededBy === null) && (options.includePrivate || !a.private));
}

function ownAnswer(db: Db, builder: CvBuilder, answerId: number): CvBuilderAnswerRow {
  const row = db
    .select()
    .from(cvBuilderAnswers)
    .where(and(eq(cvBuilderAnswers.cvBuilderId, builder.id), eq(cvBuilderAnswers.id, answerId)))
    .get();
  if (!row || row.supersededBy !== null) throw new UserFacingError("not_found");
  return row;
}

/** The user's accepted (or edited) revision of an answer; null goes back to their original words. */
export function setPolished(db: Db, builder: CvBuilder, answerId: number, text: string | null): CvBuilderAnswerRow {
  const answer = ownAnswer(db, builder, answerId);
  const polished = text === null ? null : text.replace(/\s+/g, " ").trim();
  if (polished !== null && (polished.length < 2 || polished.length > 4000)) throw new UserFacingError("invalid");
  return db.update(cvBuilderAnswers).set({ polished }).where(eq(cvBuilderAnswers.id, answer.id)).returning().get();
}

/** An edit is a new answer in the user's words that supersedes the old one (the old one stays for the record). */
export function editAnswer(db: Db, builder: CvBuilder, answerId: number, patch: { quote?: string; private?: boolean }): CvBuilderAnswerRow {
  const old = ownAnswer(db, builder, answerId);
  const quote = (patch.quote ?? old.quote).replace(/\s+/g, " ").trim();
  if (quote.length < 2 || quote.length > 4000) throw new UserFacingError("invalid");
  return db.transaction((tx) => {
    const next = tx
      .insert(cvBuilderAnswers)
      .values({ cvBuilderId: builder.id, stage: old.stage, topic: old.topic, experienceRef: old.experienceRef, question: old.question, quote, polished: patch.quote === undefined ? old.polished : null, private: patch.private ?? old.private, origin: "user_edit", messageId: null })
      .returning()
      .get();
    tx.update(cvBuilderAnswers).set({ supersededBy: next.id }).where(eq(cvBuilderAnswers.id, old.id)).run();
    return next;
  });
}

/** Deleting removes the answer and every earlier version of it: it is the user's data. */
export function deleteAnswer(db: Db, builder: CvBuilder, answerId: number): void {
  ownAnswer(db, builder, answerId);
  const all = listAnswers(db, builder.id, { includeSuperseded: true, includePrivate: true });
  const ids = new Set([answerId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of all) {
      if (a.supersededBy === null || !ids.has(a.supersededBy) || ids.has(a.id)) continue;
      ids.add(a.id);
      grew = true;
    }
  }
  db.delete(cvBuilderAnswers).where(inArray(cvBuilderAnswers.id, [...ids])).run();
}

/** Deletes the CV-builder session, its answers and its conversations (with every chat message in them). */
export function discardCvBuilder(db: Db, builder: CvBuilder): void {
  db.transaction((tx) => {
    const ids = tx.select({ id: cvBuilderConversations.conversationId }).from(cvBuilderConversations).where(eq(cvBuilderConversations.cvBuilderId, builder.id)).all().map((r) => r.id);
    tx.delete(cvBuilders).where(eq(cvBuilders.id, builder.id)).run();
    if (ids.length) tx.delete(conversations).where(inArray(conversations.id, ids)).run();
  });
}
