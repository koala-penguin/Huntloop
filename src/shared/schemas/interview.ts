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

/** Stages that have a chat (the others are forms). */
export const CHAT_STAGES = ["current", "role_deep"] as const satisfies readonly InterviewStage[];
export type ChatStage = (typeof CHAT_STAGES)[number];

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
