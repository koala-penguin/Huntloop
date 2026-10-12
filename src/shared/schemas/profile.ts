import { z } from "zod";

export const SENIORITY_LEVELS = ["intern", "junior", "mid", "senior", "lead", "principal", "manager", "director", "executive"] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export const WORK_RIGHT_STATUSES = [
  "citizen",
  "permanent_resident",
  "unrestricted_visa",
  "restricted_visa",
  "needs_sponsorship",
  "unknown",
] as const;
export type WorkRightStatus = (typeof WORK_RIGHT_STATUSES)[number];

export const LANGUAGE_LEVELS = ["native", "fluent", "professional", "conversational", "basic"] as const;
export const SKILL_CATEGORIES = ["language", "framework", "tool", "platform", "database", "domain", "method", "soft", "other"] as const;
export const CLEARANCE_STATUSES = ["active", "lapsed", "eligible"] as const;
export const FACT_SOURCES = ["cv", "user", "chat"] as const;

/** "YYYY-MM" (or "YYYY" when only the year is known). */
const yearMonth = z.string().regex(/^\d{4}(-\d{2})?$/);

export const experienceSchema = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  industry: z.string().nullable(),
  location: z.string().nullable(),
  country: z.string().nullable(),
  start: yearMonth.nullable(),
  /** null = current role */
  end: yearMonth.nullable(),
  seniority: z.enum(SENIORITY_LEVELS).nullable(),
  skills: z.array(z.string()),
  highlights: z.array(z.string()),
});
export type Experience = z.infer<typeof experienceSchema>;

export const educationSchema = z.object({
  id: z.string(),
  institution: z.string(),
  degree: z.string().nullable(),
  field: z.string().nullable(),
  country: z.string().nullable(),
  start: z.string().nullable(),
  end: z.string().nullable(),
});

export const certificationSchema = z.object({
  name: z.string(),
  issuer: z.string().nullable(),
  year: z.string().nullable(),
});

export const languageSchema = z.object({
  language: z.string(),
  level: z.enum(LANGUAGE_LEVELS),
});

export const clearanceSchema = z.object({
  country: z.string(),
  level: z.string(),
  status: z.enum(CLEARANCE_STATUSES),
});

export const workRightSchema = z.object({
  country: z.string(),
  status: z.enum(WORK_RIGHT_STATUSES),
  /** Market-pack option id, e.g. "au_485". */
  option: z.string().nullable(),
  expires: z.string().nullable(),
  note: z.string().nullable(),
});
export type WorkRight = z.infer<typeof workRightSchema>;

export const factSchema = z.object({
  id: z.string(),
  text: z.string(),
  source: z.enum(FACT_SOURCES),
});
export type Fact = z.infer<typeof factSchema>;

export const skillSchema = z.object({
  name: z.string(),
  category: z.enum(SKILL_CATEGORIES),
});

export const basicsSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  headline: z.string().nullable(),
  summary: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string().nullable(),
  links: z.array(z.string()),
});

export const profileDataSchema = z.object({
  basics: basicsSchema,
  experience: z.array(experienceSchema),
  skills: z.array(skillSchema),
  education: z.array(educationSchema),
  certifications: z.array(certificationSchema),
  languages: z.array(languageSchema),
  clearances: z.array(clearanceSchema),
  workRights: z.array(workRightSchema),
  facts: z.array(factSchema),
});
export type ProfileData = z.infer<typeof profileDataSchema>;

export function emptyProfile(): ProfileData {
  return {
    basics: { name: null, email: null, phone: null, headline: null, summary: null, city: null, country: null, links: [] },
    experience: [],
    skills: [],
    education: [],
    certifications: [],
    languages: [],
    clearances: [],
    workRights: [],
    facts: [],
  };
}
