import { z } from "zod";
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES } from "./preferences";
import { certificationSchema, clearanceSchema, educationSchema, languageSchema, SENIORITY_LEVELS, SKILL_CATEGORIES, workRightSchema } from "./profile";
import { CV_LANGUAGES } from "./cv";

/**
 * The guided CV builder: an interview that turns the user's own typed answers into a profile and a
 * base CV. Data (dates, employers, degrees) is collected in forms; stories (scope, achievements) in
 * chat. Every form field has a default, so a half-filled interview always parses.
 */

/** In the order the interview walks through them. role_deep is one chat per role. */
export const INTERVIEW_STAGES = ["setup", "target", "current", "roles", "role_deep", "education", "languages", "contact", "review"] as const;
export type InterviewStage = (typeof INTERVIEW_STAGES)[number];

/** Stages whose chat collects stories (answers recorded as evidence). */
export const CHAT_STAGES = ["current", "role_deep"] as const satisfies readonly InterviewStage[];
export type ChatStage = (typeof CHAT_STAGES)[number];

/** Stages whose chat collects data (job titles, employers, dates) onto a card the candidate checks. */
export const DATA_CHAT_STAGES = ["target", "roles", "education", "languages"] as const satisfies readonly InterviewStage[];
export type DataChatStage = (typeof DATA_CHAT_STAGES)[number];

/** Every stage that has a conversation. */
export const CONVERSATION_STAGES = [...CHAT_STAGES, ...DATA_CHAT_STAGES] as const;
export type ConversationStage = (typeof CONVERSATION_STAGES)[number];

/** Stages whose data can arrive on a card from the chat. */
export const FORM_CARD_STAGES = ["target", "current", "roles", "education", "languages"] as const satisfies readonly InterviewStage[];
export type FormCardStage = (typeof FORM_CARD_STAGES)[number];

export const INTERVIEW_TOPICS = ["scope", "responsibility", "achievement", "tool", "skill", "context", "gap", "extra", "other"] as const;
export type InterviewTopic = (typeof INTERVIEW_TOPICS)[number];

export const INTERVIEW_PERSONAS = ["no_cv", "career_changer", "returning", "migrant", "graduate", "senior_exec"] as const;
export const INTERVIEW_DEPTHS = ["full", "quick"] as const;
export const ROLE_DEPTHS = ["deep", "brief"] as const;
export const CURRENT_STATUSES = ["employed", "between_roles", "studying", "on_break", "self_employed"] as const;
export const INTERVIEW_STATUSES = ["in_progress", "completed", "abandoned"] as const;
export const STAGE_STATUSES = ["pending", "done", "skipped"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];
export const ANSWER_ORIGINS = ["chat", "user_edit", "form"] as const;

/**
 * What a chat part needs before the interviewer may call it covered (by conversation scope: the
 * current-situation chat, a role in depth, a brief role). The candidate can always stop earlier.
 */
export const REQUIRED_TOPICS: Record<"current" | "deep" | "brief", InterviewTopic[]> = {
  current: ["context"],
  deep: ["scope", "responsibility", "achievement"],
  brief: ["achievement"],
};

/**
 * The quick replies under an interview chat, typed or clicked. "Skip this question" moves on to the
 * next topic; "That's all for this part" finishes the part; "I don't have a number" keeps an answer
 * without one. Plain "skip" means the question, never the part.
 */
export const CONTROL = {
  skipQuestion: /^(skip( this question)?|pass|next question|이 질문(은)? 건너뛰(기|어요)|넘어가요)[.!]?$/i,
  finished: /^(that'?s all( for this part)?|that is all|done|i'?m done|이 부분은 다 했어요|다 했어요|끝이에요|여기까지요)[.!]?$/i,
  noNumber: /^(i don'?t have a number|no number|숫자는 없어요|숫자가 없어요)[.!]?$/i,
} as const;

/** The interviewer's first question, shown before the candidate types anything, with example prompts. */
export type ChatOpening = { text: string; options: string[]; topic: InterviewTopic };

/** Chat turns the interviewer aims for per stage ("question x of ~y"). */
export const STAGE_TURN_TARGETS = { current: 5, deep: 12, brief: 4 } as const;

/** "YYYY-MM" or "YYYY", or "" when not given. */
const monthOrEmpty = z.union([z.literal(""), z.string().regex(/^\d{4}(-\d{2})?$/)]).default("");

export const setupFormSchema = z.object({
  language: z.enum(CV_LANGUAGES).default("en"),
  country: z.string().max(2).default("AU"),
  personas: z.array(z.enum(INTERVIEW_PERSONAS)).default([]),
  depth: z.enum(INTERVIEW_DEPTHS).default("full"),
});

export const targetFormSchema = z.object({
  titles: z.array(z.string().max(120)).max(20).default([]),
  seniority: z.array(z.enum(SENIORITY_LEVELS)).default([]),
  industries: z.array(z.string().max(80)).max(20).default([]),
  cities: z.array(z.string().max(80)).max(20).default([]),
  remoteOk: z.boolean().default(true),
  workplace: z.array(z.enum(WORKPLACE_TYPES)).default([]),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default(["full_time"]),
  willingToRelocate: z.boolean().default(false),
  availability: z.string().max(200).default(""),
  workRights: z.array(workRightSchema).default([]),
  clearances: z.array(clearanceSchema).default([]),
});

export const currentFormSchema = z.object({
  status: z.enum(CURRENT_STATUSES).default("employed"),
  title: z.string().max(120).default(""),
  company: z.string().max(120).default(""),
  start: monthOrEmpty,
  country: z.string().max(2).default(""),
});

export const roleFormSchema = z.object({
  /**
   * "exp-N", given out by the server and never reused (answers, chats and the profile's experience
   * ids hang off it). A row the user just added is sent as "new-…" and gets its id on save.
   */
  id: z.string().regex(/^(exp-\d+|new-\w+)$/),
  title: z.string().max(120).default(""),
  company: z.string().max(120).default(""),
  industry: z.string().max(80).default(""),
  location: z.string().max(80).default(""),
  country: z.string().max(2).default(""),
  start: monthOrEmpty,
  /** "" = current role. */
  end: monthOrEmpty,
  employmentType: z.enum(EMPLOYMENT_TYPES).default("full_time"),
  seniority: z.enum(SENIORITY_LEVELS).nullable().default(null),
  depth: z.enum(ROLE_DEPTHS).default("deep"),
});
export type RoleForm = z.infer<typeof roleFormSchema>;

export const contactFormSchema = z.object({
  name: z.string().max(120).default(""),
  email: z.string().max(200).default(""),
  phone: z.string().max(60).default(""),
  city: z.string().max(80).default(""),
  country: z.string().max(2).default(""),
  links: z.array(z.string().max(300)).max(10).default([]),
  headline: z.string().max(160).default(""),
  cvLanguage: z.enum(CV_LANGUAGES).default("en"),
});

/** A skill heard in the interview (pending until ticked) or added by the user (ticked). */
export const interviewSkillSchema = z.object({
  name: z.string().min(1).max(80),
  category: z.enum(SKILL_CATEGORIES).default("other"),
  experienceRef: z.string().nullable().default(null),
  ticked: z.boolean().default(false),
});
export type InterviewSkill = z.infer<typeof interviewSkillSchema>;

export const interviewFormSchema = z.object({
  setup: setupFormSchema.prefault({}),
  target: targetFormSchema.prefault({}),
  current: currentFormSchema.prefault({}),
  roles: z.array(roleFormSchema).max(30).default([]),
  education: z.array(educationSchema).max(20).default([]),
  certifications: z.array(certificationSchema).max(30).default([]),
  languages: z.array(languageSchema).max(20).default([]),
  contact: contactFormSchema.prefault({}),
  skills: z.array(interviewSkillSchema).max(100).default([]),
});
export type InterviewForm = z.infer<typeof interviewFormSchema>;

/**
 * What a card (and the "On file" editor) carries for each stage. A role says whether it is the
 * current one; a language level may still be open ("") until the candidate picks one.
 */
const VALID_MONTH = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
const cardMonth = z.union([z.literal(""), z.string().regex(VALID_MONTH)]).default("");
export const roleCardSchema = roleFormSchema.extend({ start: cardMonth, end: cardMonth, current: z.boolean().default(false) });
export type RoleCard = z.infer<typeof roleCardSchema>;
export const languageCardSchema = z.object({ language: z.string().max(80), level: z.union([languageSchema.shape.level, z.literal("")]) });
export const FORM_CARD_SCHEMAS = {
  target: targetFormSchema,
  current: currentFormSchema.extend({ start: cardMonth }),
  roles: z.object({ roles: z.array(roleCardSchema).max(30) }),
  education: z.object({ education: z.array(educationSchema).max(20).default([]), certifications: z.array(certificationSchema).max(30).default([]) }),
  languages: z.object({ languages: z.array(languageCardSchema).max(20) }),
} as const;
export type FormCardValue<S extends FormCardStage = FormCardStage> = z.infer<(typeof FORM_CARD_SCHEMAS)[S]>;

/** The saved part of the form for a stage, in the shape a card carries. */
export function cardValueOf<S extends FormCardStage>(form: InterviewForm, stage: S): FormCardValue<S> {
  const values: { [K in FormCardStage]: FormCardValue<K> } = {
    target: form.target,
    current: form.current,
    roles: { roles: form.roles.map((r) => ({ ...r, current: !r.end })) },
    education: { education: form.education, certifications: form.certifications },
    languages: { languages: form.languages },
  };
  return values[stage];
}

export const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

/** end before start: by year, and by month only when both have one. */
function endsBeforeStart(start: string, end: string): boolean {
  if (!VALID_MONTH.test(start) || !VALID_MONTH.test(end)) return false;
  const [sy, sm] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  return ey < sy || (ey === sy && !!sm && !!em && em < sm);
}

type RoleRow = { title: string; start: string; end: string; current?: boolean };

function roleCodes(rows: RoleRow[], card: boolean): string[] {
  const codes: string[] = [];
  rows.forEach((r, i) => {
    if (!r.title.trim()) codes.push(`roles.${i}.title`);
    if (!VALID_MONTH.test(r.start)) codes.push(`roles.${i}.start`);
    // In the form an empty end means "still there"; on a card that has to be said.
    if (r.end ? !VALID_MONTH.test(r.end) : card && !r.current) codes.push(`roles.${i}.end`);
    if (r.end && endsBeforeStart(r.start, r.end)) codes.push(`roles.${i}.order`);
  });
  return codes;
}

/**
 * What a stage still needs before the candidate can continue (and before Generate), as field
 * codes: "target.title", "roles.none", "roles.<i>.start", "contact.email"… Empty when nothing is missing.
 */
export function stageRequirements(stage: InterviewStage, form: InterviewForm): string[] {
  switch (stage) {
    case "target":
      return form.target.titles.some((t) => t.trim()) ? [] : ["target.title"];
    case "current":
      return ["employed", "self_employed"].includes(form.current.status) && !form.current.title.trim() ? ["current.title"] : [];
    case "roles":
      return form.roles.length ? roleCodes(form.roles, false) : ["roles.none"];
    case "contact":
      return [...(form.contact.name.trim() ? [] : ["contact.name"]), ...(validEmail(form.contact.email) ? [] : ["contact.email"])];
    default:
      return [];
  }
}

/** Row-level problems in a card-shaped value: what stops this card (or "On file" edit) from being saved. */
export function rowIssues(stage: string, value: unknown): string[] {
  const v = (value ?? {}) as { roles?: RoleRow[]; languages?: Array<{ level: string }> };
  if (stage === "roles") return roleCodes(v.roles ?? [], true);
  if (stage === "languages") return (v.languages ?? []).flatMap((l, i) => (l.level ? [] : [`languages.${i}.level`]));
  return [];
}

/** Format problems in a value about to be saved: a malformed email or phone, a start date after its end. */
export function stageFormIssues(stage: string, value: unknown): string[] {
  const v = (value ?? {}) as { email?: string; phone?: string; roles?: RoleRow[] };
  if (stage === "contact") {
    const email = (v.email ?? "").trim();
    const phone = (v.phone ?? "").trim();
    return [...(email && !validEmail(email) ? ["contact.email"] : []), ...(phone && phone.replace(/\D/g, "").length < 6 ? ["contact.phone"] : [])];
  }
  if (stage === "roles") return (v.roles ?? []).flatMap((r, i) => (r.end && endsBeforeStart(r.start, r.end) ? [`roles.${i}.order`] : []));
  return [];
}

/** The form stages and the part of the form each one saves. */
export const FORM_SECTIONS = {
  setup: "setup",
  target: "target",
  current: "current",
  roles: "roles",
  education: ["education", "certifications"],
  languages: "languages",
  contact: "contact",
} as const;

export function parseInterviewForm(value: unknown): InterviewForm {
  const parsed = interviewFormSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : interviewFormSchema.parse({});
}

/** Stage status keys: one per stage, plus "role:<exp-N>" for each role's chat. */
export const roleStageKey = (experienceRef: string) => `role:${experienceRef}`;

/** The role the candidate holds now (no end date), else the most recent one. */
export function currentRole(form: InterviewForm): RoleForm | null {
  if (!form.roles.length) return null;
  return form.roles.find((r) => !r.end) ?? [...form.roles].sort((a, b) => (b.end || "").localeCompare(a.end || "") || (b.start || "").localeCompare(a.start || ""))[0];
}

/** Roles in CV order: current first, then by end and start date, newest first. */
export function rolesInOrder(form: InterviewForm): RoleForm[] {
  const key = (r: RoleForm) => `${r.end ? "0" : "1"}${r.end || "9999"}${r.start || "0000"}`;
  return [...form.roles].sort((a, b) => key(b).localeCompare(key(a)));
}

/**
 * The role an answer is filed under. Answers in the current-situation chat given before any role
 * was on file belong to the current (or most recent) role once there is one — the same rule used
 * when they were recorded — never to free-floating facts.
 */
export function answerRole(form: InterviewForm, answer: { stage: string; experienceRef: string | null }): string | null {
  if (answer.experienceRef === null && answer.stage === "current") return currentRole(form)?.id ?? null;
  return answer.experienceRef;
}
