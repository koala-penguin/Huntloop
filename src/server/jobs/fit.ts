import { eq } from "drizzle-orm";
import type { Assessment, PostingAnalysis, ScoreResult } from "@/shared/schemas/job";
import { stableStringify } from "@/shared/stable-json";
import type { Db } from "../db/database";
import { jobs, type JobRow } from "../db/schema";
import { getStoredAnalysis } from "../ai/tasks/analyze-posting";
import { getAssessment, profileHash } from "../ai/tasks/assess";
import { getCurrentProfile, getPreferences, type ProfileVersion } from "../repo/profile";
import { scoreJob } from "../scoring/aggregate";

export interface JobFit {
  analysis: PostingAnalysis;
  assessment: Assessment | null;
  assessmentId: number | null;
  assessmentLanguage: string | null;
  score: ScoreResult | null;
  /** The profile changed in ways the assessment reads (CV, skills, facts) since it was made. */
  profileStale: boolean;
  hasProfile: boolean;
}

function computeScore(job: JobRow, analysis: PostingAnalysis, assessment: Assessment, profile: ProfileVersion, db: Db, userId: number, now: Date): ScoreResult {
  return scoreJob({
    analysis,
    assessment,
    profile: { cvText: profile.cvText, data: profile.data },
    preferences: getPreferences(db, userId),
    job: { country: job.country, city: job.city, postedAt: job.postedAt, descriptionIsFull: job.descriptionIsFull },
    answers: job.answers ?? {},
    now,
  });
}

/** Writes the sortable summary (score, tier, eligibility, confidence) onto the job row when it changed. */
function denormalize(db: Db, job: JobRow, score: ScoreResult | null): void {
  const next = {
    score: score?.score ?? null,
    tier: score?.tier ?? null,
    eligibility: score?.eligibility ?? null,
    confidence: score?.confidence ?? null,
    scoreData: score,
  };
  if (stableStringify(next) !== stableStringify({ score: job.score, tier: job.tier, eligibility: job.eligibility, confidence: job.confidence, scoreData: job.scoreData })) {
    db.update(jobs).set(next).where(eq(jobs.id, job.id)).run();
  }
}

/** Everything the fit report needs. Scores are recomputed on every read (pure code, no AI calls). */
export function loadJobFit(db: Db, userId: number, job: JobRow, now = new Date()): JobFit | null {
  if (!job.analysisId) return null;
  const stored = getStoredAnalysis({ db }, job.analysisId);
  if (!stored) return null;
  const profile = getCurrentProfile(db, userId);
  const assessed = job.assessmentId ? getAssessment({ db }, job.assessmentId) : null;
  let score: ScoreResult | null = null;
  if (assessed && profile) score = computeScore(job, stored.analysis, assessed.assessment, profile, db, userId, now);
  denormalize(db, job, score);
  return {
    analysis: stored.analysis,
    assessment: assessed?.assessment ?? null,
    assessmentId: assessed?.id ?? null,
    assessmentLanguage: assessed?.language ?? null,
    score,
    profileStale: !!(assessed && profile && assessed.profileHash !== profileHash(profile.cvText, profile.data)),
    hasProfile: !!profile,
  };
}

export function rescoreJob(db: Db, userId: number, job: JobRow): ScoreResult | null {
  return loadJobFit(db, userId, job)?.score ?? null;
}

/** After profile or preference edits: re-tier every job in code. */
export function rescoreAllJobs(db: Db, userId: number): void {
  const rows = db.select().from(jobs).where(eq(jobs.userId, userId)).all();
  for (const job of rows) rescoreJob(db, userId, job);
}
