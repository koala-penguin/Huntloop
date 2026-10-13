import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/database";
import { jobEvents, jobs, type JobRow } from "../db/schema";
import { listJobs } from "../repo/jobs";
import { FOLLOW_UP_AFTER_DAYS, PIPELINE_COLUMNS, type StatusEventData } from "@/shared/schemas/pipeline";

const DAY = 86_400_000;

export interface PipelineCard {
  id: number;
  title: string | null;
  companyName: string | null;
  status: string;
  tier: string | null;
  eligibility: string | null;
  daysInStage: number;
  appliedAt: Date | null;
  /** Applied a while ago and nothing has changed since: suggest following up. */
  followUp: boolean;
}

export interface PipelineBoard {
  columns: Record<(typeof PIPELINE_COLUMNS)[number], PipelineCard[]>;
  counts: { new: number; rejected: number; archived: number };
}

function card(job: JobRow, now: Date): PipelineCard {
  const since = job.statusChangedAt ?? job.updatedAt ?? job.createdAt;
  const daysInStage = Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY));
  return {
    id: job.id,
    title: job.title,
    companyName: job.companyName,
    status: job.status,
    tier: job.tier,
    eligibility: job.eligibility,
    daysInStage,
    appliedAt: job.appliedAt,
    followUp: job.status === "applied" && daysInStage >= FOLLOW_UP_AFTER_DAYS,
  };
}

/** Every job by pipeline stage, best Interview Chance first within a stage. */
export function pipelineBoard(db: Db, userId: number, now = new Date()): PipelineBoard {
  const all = listJobs(db, userId, { showIneligible: true });
  const columns = Object.fromEntries(PIPELINE_COLUMNS.map((c) => [c, [] as PipelineCard[]])) as PipelineBoard["columns"];
  const counts = { new: 0, rejected: 0, archived: 0 };
  for (const job of all) {
    if (job.status in columns) columns[job.status as keyof typeof columns].push(card(job, now));
    else if (job.status in counts) counts[job.status as keyof typeof counts]++;
  }
  return { columns, counts };
}

export interface TierOutcome {
  tier: string;
  applied: number;
  interviews: number;
  offers: number;
}

/**
 * How Interview Chance tiers turned out: for each job the user applied to, the tier it had when they
 * applied, and whether it reached an interview or an offer. The start of calibrating the tiers.
 */
export function outcomeStats(db: Db, userId: number): TierOutcome[] {
  const rows = db
    .select({ jobId: jobEvents.jobId, toValue: jobEvents.toValue, data: jobEvents.data, tier: jobs.tier })
    .from(jobEvents)
    .innerJoin(jobs, eq(jobEvents.jobId, jobs.id))
    .where(and(eq(jobs.userId, userId), eq(jobEvents.type, "status")))
    .orderBy(asc(jobEvents.id))
    .all();
  const perJob = new Map<number, { tier: string; interview: boolean; offer: boolean }>();
  for (const row of rows) {
    const data = (row.data ?? {}) as StatusEventData;
    let entry = perJob.get(row.jobId);
    if (!entry && ["applied", "interviewing", "offer"].includes(row.toValue ?? "")) {
      entry = { tier: data.snapshot?.tier ?? row.tier ?? "unscored", interview: false, offer: false };
      perJob.set(row.jobId, entry);
    }
    if (!entry) continue;
    if (row.toValue === "interviewing" || row.toValue === "offer") entry.interview = true;
    if (row.toValue === "offer") entry.offer = true;
    if (row.toValue === "rejected" && ["after_interview", "after_offer"].includes(data.outcome?.stage ?? "")) entry.interview = true;
  }
  const order = ["strong", "good", "stretch", "long_shot", "unscored"];
  const byTier = new Map<string, TierOutcome>();
  for (const e of perJob.values()) {
    const t = byTier.get(e.tier) ?? { tier: e.tier, applied: 0, interviews: 0, offers: 0 };
    t.applied++;
    if (e.interview) t.interviews++;
    if (e.offer) t.offers++;
    byTier.set(e.tier, t);
  }
  return [...byTier.values()].sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
}

export interface HistoryEntry {
  id: number;
  type: string;
  from: string | null;
  to: string | null;
  note: string | null;
  data: StatusEventData | null;
  at: Date;
}

export function jobHistory(db: Db, jobId: number): HistoryEntry[] {
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(asc(jobEvents.id))
    .all()
    .map((e) => ({ id: e.id, type: e.type, from: e.fromValue, to: e.toValue, note: e.note, data: (e.data ?? null) as StatusEventData | null, at: e.createdAt }));
}
