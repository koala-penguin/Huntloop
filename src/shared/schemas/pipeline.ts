import { z } from "zod";
import type { JobStatus } from "./job";

/** Pipeline stages shown as columns, in order. New, rejected and archived are counted separately. */
export const PIPELINE_COLUMNS = ["shortlisted", "applying", "applied", "interviewing", "offer"] as const satisfies readonly JobStatus[];

/** Status changes that can carry an outcome (all fields optional). */
export const OUTCOME_STATUSES = ["applied", "interviewing", "offer", "rejected"] as const satisfies readonly JobStatus[];
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export const APPLY_CHANNELS = ["employer_site", "job_board", "referral", "recruiter", "other"] as const;
/** Where a rejection (or withdrawal) happened. */
export const END_STAGES = ["no_response", "after_application", "after_interview", "after_offer"] as const;

export const outcomeSchema = z.object({
  /** Applied / interview / decision date (YYYY-MM-DD). */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  channel: z.enum(APPLY_CHANNELS).nullable().default(null),
  /** Interview round, e.g. "Phone screen". */
  round: z.string().trim().max(80).nullable().default(null),
  stage: z.enum(END_STAGES).nullable().default(null),
  note: z.string().trim().max(1000).nullable().default(null),
});
export type Outcome = z.infer<typeof outcomeSchema>;

export function isOutcomeStatus(status: string): status is OutcomeStatus {
  return (OUTCOME_STATUSES as readonly string[]).includes(status);
}

/** What a status event stores in job_events.data. */
export interface StatusEventData {
  outcome?: Outcome;
  /** Interview Chance when the status changed — used to see how tiers turn into interviews. */
  snapshot?: { tier: string | null; score: number | null; eligibility: string | null };
}

/** Days without news after applying before Huntloop suggests a follow-up. */
export const FOLLOW_UP_AFTER_DAYS = 14;
