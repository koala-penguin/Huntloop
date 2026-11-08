import { z } from "zod";
import { SENIORITY_LEVELS } from "./profile";

export const WORKPLACES = ["onsite", "hybrid", "remote", "unknown"] as const;
export const JOB_EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "casual", "internship", "unknown"] as const;
export const REQUIREMENT_KINDS = ["gate", "must", "nice"] as const;
export const REQUIREMENT_CATEGORIES = [
  "work_rights",
  "clearance",
  "location",
  "license",
  "language",
  "education",
  "years",
  "skill",
  "domain",
  "title",
  "certification",
  "other",
] as const;
export const GATE_TYPES = ["citizenship", "pr", "no_sponsorship", "clearance", "onsite", "license", "language", "none"] as const;
export const SPONSORSHIP = ["offered", "not_offered", "unknown"] as const;
export const SALARY_BASIS = ["base", "base_plus_super", "package", "unknown"] as const;

export const JOB_STATUSES = ["new", "shortlisted", "applying", "applied", "interviewing", "offer", "rejected", "archived"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Pipeline stages where the user has acted on the job; a bulk delete keeps them unless asked. */
export const IN_PROGRESS_STATUSES = ["applying", "applied", "interviewing", "offer"] as const satisfies readonly JobStatus[];
export function isInProgress(status: string): boolean {
  return (IN_PROGRESS_STATUSES as readonly string[]).includes(status);
}
export const MAX_BULK_DELETE = 500;
export const bulkDeleteBodySchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(MAX_BULK_DELETE),
  includeInProgress: z.boolean().default(false),
});
export type BulkDeleteBody = z.infer<typeof bulkDeleteBodySchema>;

/** How many of the selected jobs a bulk delete will actually remove (in-progress ones only when asked). */
export function deletableCount(selected: Array<{ inProgress: boolean }>, includeInProgress: boolean): number {
  return includeInProgress ? selected.length : selected.filter((j) => !j.inProgress).length;
}

/** For each key, its position among equal keys and how many there are (to tell repeated row names apart). */
export function numberRepeats(keys: string[]): Array<{ n: number; count: number }> {
  const totals = new Map<string, number>();
  for (const k of keys) totals.set(k, (totals.get(k) ?? 0) + 1);
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return { n, count: totals.get(k)! };
  });
}

/** Splits ids into request-sized chunks (the server caps one request at MAX_BULK_DELETE). */
export function chunkIds(ids: number[], size = MAX_BULK_DELETE): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export const JOB_SOURCES = ["paste", "url", "screenshot", "pdf", "greenhouse", "lever", "ashby", "adzuna", "web_agent", "seek", "linkedin", "browser_agent", "smartrecruiters"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

/** Claude's reading of a posting. Profile-independent, cached per posting text. */
export const postingAnalysisSchema = z.object({
  isJobPosting: z.boolean(),
  /** For noisy text (pastes, web pages): the posting's first and last few words, verbatim. */
  postingStart: z.string().nullable(),
  postingEnd: z.string().nullable(),
  title: z.string(),
  company: z.string().nullable(),
  companyDomain: z.string().nullable(),
  locationText: z.string().nullable(),
  city: z.string().nullable(),
  region: z.string().nullable(),
  country: z.string().nullable(),
  countryEvidence: z.string().nullable(),
  workplace: z.enum(WORKPLACES),
  remoteScope: z.string().nullable(),
  employmentType: z.enum(JOB_EMPLOYMENT_TYPES),
  seniority: z.enum(SENIORITY_LEVELS).nullable(),
  salary: z
    .object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      currency: z.string().nullable(),
      period: z.enum(["year", "month", "day", "hour"]).nullable(),
      basis: z.enum(SALARY_BASIS),
      text: z.string().nullable(),
    })
    .nullable(),
  postedText: z.string().nullable(),
  postedDate: z.string().nullable(),
  closesDate: z.string().nullable(),
  language: z.string(),
  sponsorship: z.enum(SPONSORSHIP),
  sponsorshipQuote: z.string().nullable(),
  requirements: z.array(
    z.object({
      postingQuote: z.string(),
      kind: z.enum(REQUIREMENT_KINDS),
      category: z.enum(REQUIREMENT_CATEGORIES),
      gate: z.enum(GATE_TYPES),
      minYears: z.number().nullable(),
      /** Short canonical name, e.g. "React", "5+ years frontend", "Baseline clearance". */
      normalized: z.string(),
      /** Exact terms an applicant-tracking system would look for on a CV, in the posting's wording. */
      keywords: z.array(z.string()),
    }),
  ),
  ghostSignals: z.array(z.string()),
});
export type PostingAnalysisOutput = z.infer<typeof postingAnalysisSchema>;

export interface Requirement {
  id: string;
  postingQuote: string;
  kind: (typeof REQUIREMENT_KINDS)[number];
  category: (typeof REQUIREMENT_CATEGORIES)[number];
  gate: (typeof GATE_TYPES)[number];
  minYears: number | null;
  normalized: string;
  /** ATS terms (analyses made before prompt version 2 don't have them). */
  keywords?: string[];
}

/** Stored analysis: the LLM output plus verified requirements with ids. */
export interface PostingAnalysis extends Omit<PostingAnalysisOutput, "requirements"> {
  requirements: Requirement[];
  droppedRequirements: number;
}

export const ASSESSMENT_STATUSES = ["met", "partial", "unmet", "unknown"] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];
export const GAP_TYPES = ["none", "not_on_cv", "transferable", "real_gap"] as const;
export const RELEVANCE = ["same", "adjacent", "different"] as const;
export const BOOSTER_KINDS = ["referral", "apply_early", "keywords", "address_gap", "network", "other"] as const;
export const RISK_KINDS = ["overqualified", "underqualified", "ghost_job", "sponsorship", "relocation", "competition", "other"] as const;

/** Claude's per-requirement assessment against the profile. Evidence comes before the label. */
export const assessmentSchema = z.object({
  items: z.array(
    z.object({
      requirementId: z.string(),
      evidence: z.array(z.object({ source: z.enum(["cv", "fact"]), quote: z.string(), factId: z.string().nullable() })),
      experienceIds: z.array(z.string()),
      reasoning: z.string(),
      status: z.enum(ASSESSMENT_STATUSES),
      gapType: z.enum(GAP_TYPES),
      question: z.string().nullable(),
      postingQuoteGloss: z.string().nullable(),
    }),
  ),
  candidateSeniority: z.enum(SENIORITY_LEVELS).nullable(),
  titleRelevance: z.enum(RELEVANCE),
  industryRelevance: z.enum(RELEVANCE),
  strengths: z.array(z.object({ text: z.string(), requirementIds: z.array(z.string()) })),
  boosters: z.array(z.object({ kind: z.enum(BOOSTER_KINDS), text: z.string() })),
  risks: z.array(z.object({ kind: z.enum(RISK_KINDS), text: z.string() })),
  oneLine: z.string(),
  postingSummary: z.string(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export type AssessmentItem = Assessment["items"][number];

export const TIERS = ["strong", "good", "stretch", "long_shot"] as const;
export type Tier = (typeof TIERS)[number];
export type Eligibility = "eligible" | "verify" | "ineligible";
export type GateStatus = "pass" | "fail" | "unclear";

export interface GateResult {
  kind: "work_rights" | "citizenship" | "clearance" | "location" | "license" | "language" | "stale";
  status: GateStatus;
  postingQuote: string | null;
  /** Message key suffix: fit.gateReason.<reasonKey> */
  reasonKey: string;
  params?: Record<string, string | number>;
  requirementId?: string;
}

export interface ScoredItem {
  requirementId: string;
  /** Status after quote verification and user answers. */
  status: AssessmentStatus;
  verifiedEvidence: Array<{ source: "cv" | "fact"; quote: string }>;
  droppedEvidence: number;
  overridden: boolean;
}

export interface ScoreResult {
  rubricVersion: number;
  eligibility: Eligibility;
  gates: GateResult[];
  items: ScoredItem[];
  components: { mustHaves: number; seniority: number; relevance: number; niceToHaves: number; keywords: number };
  base: number;
  adjustments: Array<{ kind: string; points: number }>;
  capsApplied: Array<{ reasonKey: string; maxTier: Tier }>;
  score: number;
  tier: Tier;
  confidence: "high" | "medium" | "low";
  unknownShare: number;
  candidateYears: number;
  whatWouldChange: Array<{ requirementId: string; newTier: Tier }>;
}
