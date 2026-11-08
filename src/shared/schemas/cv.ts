import { z } from "zod";
import type { WorkRightStatus } from "./profile";

/**
 * Tailored CVs and LinkedIn profile text. The model writes sentences and bullets with the CV or fact
 * quotes they are based on; code supplies names, titles, companies, dates, education and work rights,
 * checks every quote and number, and flags anything it can't verify.
 */

// ---- What the model returns (structured outputs: enums and .nullable() only) ----

export const sourceRefSchema = z.object({
  source: z.enum(["cv", "fact"]),
  /** Verbatim words from the CV (or from the fact) this line is based on. */
  quote: z.string(),
  factId: z.string().nullable(),
});
export type SourceRefInput = z.infer<typeof sourceRefSchema>;

export const lineSchema = z.object({
  text: z.string(),
  sourceRefs: z.array(sourceRefSchema),
  /** Posting requirement ids this line speaks to. */
  requirementIds: z.array(z.string()),
});
export type LineInput = z.infer<typeof lineSchema>;

export const LINKEDIN_SECTIONS = ["headline", "about", "experience", "skills"] as const;

export const tailoringPlanSchema = z.object({
  /** One or two sentences: how to position the candidate for this job. */
  summaryAngle: z.string(),
  /** Requirements the CV should make visible (only ones the candidate meets or partly meets). */
  targetRequirementIds: z.array(z.string()),
  roles: z.array(z.object({ experienceId: z.string(), include: z.boolean(), emphasis: z.enum(["lead", "normal", "brief"]) })),
  keywords: z.array(z.object({ requirementId: z.string(), term: z.string(), supportQuote: z.string() })),
  doNotClaim: z.array(z.object({ requirementId: z.string(), reason: z.string() })),
  /** Questions whose answers would let the CV say more (missing numbers, unconfirmed skills). */
  questions: z.array(z.object({ text: z.string(), requirementId: z.string().nullable(), experienceId: z.string().nullable() })),
  /** What to emphasise on LinkedIn for this job (the LinkedIn profile itself is written once, for the target roles). */
  linkedinEmphasis: z.array(z.object({ section: z.enum(LINKEDIN_SECTIONS), text: z.string(), sourceRefs: z.array(sourceRefSchema) })),
  advice: z.array(z.string()),
});
export type TailoringPlan = z.infer<typeof tailoringPlanSchema>;

export const tailoredCvSchema = z.object({
  summary: z.array(lineSchema),
  /** Skill names, most relevant first. Only skills the candidate has (others are dropped in code). */
  skills: z.array(z.string()),
  roles: z.array(z.object({ experienceId: z.string(), bullets: z.array(lineSchema) })),
});
export type TailoredCvOutput = z.infer<typeof tailoredCvSchema>;

export const linkedinOutputSchema = z.object({
  headline: lineSchema,
  /** Paragraphs of the About section. */
  about: z.array(lineSchema),
  positions: z.array(z.object({ experienceId: z.string(), bullets: z.array(lineSchema) })),
  topSkills: z.array(z.string()),
});
export type LinkedinOutput = z.infer<typeof linkedinOutputSchema>;

// ---- What Huntloop stores and renders ----

export interface SourceRef extends SourceRefInput {
  verified: boolean;
}

/** ai = written by the model; user = written by the user; profile = copied from the CV as is. */
export type LineOrigin = "ai" | "user" | "profile";

export interface CvLine {
  id: string;
  text: string;
  sourceRefs: SourceRef[];
  requirementIds: string[];
  origin: LineOrigin;
}

export interface CvRole {
  experienceId: string;
  title: string;
  company: string;
  location: string | null;
  start: string | null;
  end: string | null;
  bullets: CvLine[];
}

export const CV_LANGUAGES = ["en", "ko"] as const;
export type CvLanguage = (typeof CV_LANGUAGES)[number];

export interface CvDocument {
  language: CvLanguage;
  /** Spelling/formatting locale, e.g. en-AU. */
  locale: string;
  market: string;
  paper: "A4" | "Letter";
  pages: [number, number];
  header: { name: string | null; headline: string | null; email: string | null; phone: string | null; city: string | null; country: string | null; links: string[] };
  summary: CvLine[];
  skills: string[];
  roles: CvRole[];
  education: Array<{ institution: string; degree: string | null; field: string | null; start: string | null; end: string | null }>;
  certifications: Array<{ name: string; issuer: string | null; year: string | null }>;
  languages: Array<{ language: string; level: string }>;
  clearances: Array<{ level: string; status: string }>;
  /** `option` is the profile's work-right choice (e.g. "au_citizen"), for the market's own wording; older drafts lack it. */
  workRight: { status: WorkRightStatus; country: string; option?: string | null } | null;
  referees: boolean;
}

export interface LinkedinPosition {
  experienceId: string;
  title: string;
  company: string;
  bullets: CvLine[];
}

export interface LinkedinDocument {
  language: CvLanguage;
  headline: CvLine;
  about: CvLine[];
  positions: LinkedinPosition[];
  topSkills: string[];
}

export const LINKEDIN_LIMITS = { headline: 220, about: 2600, position: 2000, topSkills: 5 } as const;

export const FLAG_KINDS = ["unverified_source", "unsourced", "other_role", "number", "do_not_claim", "term", "over_limit", "length"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

export interface CvFlag {
  id: string;
  /** The line the flag is about; null for document-level flags (length). */
  lineId: string | null;
  kind: FlagKind;
  /** block = must be resolved before export or copy; warn = shown only. */
  severity: "block" | "warn";
  params: Record<string, string | number>;
}

/** ATS keyword match: posting keywords (skills, certifications, titles) found in a text. */
export interface KeywordCoverage {
  present: string[];
  missing: string[];
  /** Share present, or null when the posting has no keyword requirements. */
  share: number | null;
}

export interface CvChecks {
  keywordsBefore: KeywordCoverage | null;
  keywordsAfter: KeywordCoverage | null;
  pageEstimate: number | null;
  /** Lines or roles the model returned that code had to drop (unknown roles, empty text). */
  dropped: number;
  /** The posting's language isn't one Huntloop writes CVs in, so the CV is in English. */
  languageFallback: boolean;
}

export type CvEdit =
  | { at: string; kind: "remove"; lineId: string; text: string }
  | { at: string; kind: "edit"; lineId: string; text: string; previous: string }
  | { at: string; kind: "confirm_fact"; lineId: string; factId: string }
  | { at: string; kind: "answer"; questionIndex: number; factId: string };

export function blockingFlags(flags: CvFlag[]): CvFlag[] {
  return flags.filter((f) => f.severity === "block");
}

/** How many lines (or document-level problems) still block export — one line can have several flags. */
export function blockingCount(flags: CvFlag[]): number {
  return new Set(blockingFlags(flags).map((f) => f.lineId ?? f.id)).size;
}
