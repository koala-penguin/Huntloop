import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/database";
import { companies, jobAttachments, jobEvents, jobs, type JobRow } from "../db/schema";
import { isInProgress, JOB_STATUSES, type JobStatus } from "@/shared/schemas/job";
import type { Outcome, StatusEventData } from "@/shared/schemas/pipeline";
import { rememberDeleted } from "./dismissed";

export type NewJob = Omit<typeof jobs.$inferInsert, "id" | "userId" | "createdAt">;

export function createJob(db: Pick<Db, "insert">, userId: number, values: NewJob): JobRow {
  const row = db
    .insert(jobs)
    .values({ ...values, userId, updatedAt: new Date() })
    .returning()
    .get();
  db.insert(jobEvents).values({ jobId: row.id, type: "created", toValue: row.source }).run();
  return row;
}

export function getJob(db: Db, userId: number, id: number): JobRow | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.id, id)))
    .get();
}

export function updateJob(db: Db, id: number, patch: Partial<NewJob>): JobRow {
  return db
    .update(jobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(jobs.id, id))
    .returning()
    .get();
}

export type DeleteJobsResult = { deleted: number[]; skipped: Array<{ id: number; reason: "not_found" | "in_progress" }> };

/** Deletes the user's jobs in one transaction; children go with them (FK cascades); each is remembered as deleted. Per-id outcome returned. */
export function deleteJobs(db: Db, userId: number, ids: number[], options: { includeInProgress: boolean }): DeleteJobsResult {
  return db.transaction((tx) => {
    const result: DeleteJobsResult = { deleted: [], skipped: [] };
    if (!ids.length) return result;
    const rows = tx
      .select({ id: jobs.id, status: jobs.status, sourceUrl: jobs.sourceUrl, companyName: jobs.companyName, title: jobs.title })
      .from(jobs)
      .where(and(eq(jobs.userId, userId), inArray(jobs.id, ids)))
      .all();
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) result.skipped.push({ id, reason: "not_found" });
      else if (!options.includeInProgress && isInProgress(row.status)) result.skipped.push({ id, reason: "in_progress" });
      else result.deleted.push(id);
    }
    if (result.deleted.length) {
      // Remembered so a later search doesn't bring them back (same transaction: both or neither).
      rememberDeleted(tx, userId, result.deleted.map((id) => byId.get(id)!));
      tx.delete(jobs)
        .where(and(eq(jobs.userId, userId), inArray(jobs.id, result.deleted)))
        .run();
    }
    return result;
  });
}

export function deleteJob(db: Db, userId: number, id: number): void {
  deleteJobs(db, userId, [id], { includeInProgress: true });
}

export interface JobFilters {
  status?: JobStatus | "active";
  tier?: string;
  showIneligible?: boolean;
}

const TIER_SORT = { strong: 0, good: 1, stretch: 2, long_shot: 3 } as Record<string, number>;

/** Jobs sorted by Interview Chance: eligible first, then score; unscored jobs last (newest first). */
export function listJobs(db: Db, userId: number, filters: JobFilters = {}): JobRow[] {
  const conditions = [eq(jobs.userId, userId)];
  if (filters.status === "active") conditions.push(inArray(jobs.status, ["new", "shortlisted", "applying", "applied", "interviewing", "offer"]));
  else if (filters.status) conditions.push(eq(jobs.status, filters.status));
  if (filters.tier) conditions.push(eq(jobs.tier, filters.tier));
  const rows = db
    .select()
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .all();
  const visible = filters.showIneligible ? rows : rows.filter((r) => r.eligibility !== "ineligible");
  const rank = (r: JobRow) => (r.eligibility === "ineligible" ? 2 : r.score === null ? 1 : 0);
  return visible.sort((a, b) => rank(a) - rank(b) || (b.score ?? -1) - (a.score ?? -1) || (TIER_SORT[a.tier ?? ""] ?? 9) - (TIER_SORT[b.tier ?? ""] ?? 9));
}

export function countIneligible(db: Db, userId: number): number {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.eligibility, "ineligible")))
    .all().length;
}

export function findJobByUrl(db: Db, userId: number, url: string): JobRow | undefined {
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.sourceUrl, url)))
    .get();
}

export function findDuplicates(db: Db, userId: number, job: JobRow): JobRow[] {
  if (!job.dedupeKey) return [];
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.dedupeKey, job.dedupeKey), ne(jobs.id, job.id)))
    .all();
}

export function setJobStatus(db: Db, userId: number, id: number, status: JobStatus, note?: string, outcome?: Outcome): JobRow | undefined {
  const job = getJob(db, userId, id);
  if (!job || !JOB_STATUSES.includes(status) || job.status === status) return job;
  const data: StatusEventData = { snapshot: { tier: job.tier, score: job.score, eligibility: job.eligibility }, ...(outcome ? { outcome } : {}) };
  db.insert(jobEvents).values({ jobId: id, type: "status", fromValue: job.status, toValue: status, note: note ?? null, data }).run();
  const now = new Date();
  const patch: Partial<NewJob> = { status, statusChangedAt: now };
  if (status === "applied" && !job.appliedAt) patch.appliedAt = outcome?.date ? new Date(`${outcome.date}T12:00:00`) : now;
  return updateJob(db, id, patch);
}

export function setJobAnswer(db: Db, userId: number, id: number, requirementId: string, answer: "yes" | "no" | null): JobRow | undefined {
  const job = getJob(db, userId, id);
  if (!job) return undefined;
  const answers = { ...(job.answers ?? {}) };
  if (answer) answers[requirementId] = answer;
  else delete answers[requirementId];
  db.insert(jobEvents).values({ jobId: id, type: "answer", fromValue: requirementId, toValue: answer ?? "cleared" }).run();
  return updateJob(db, id, { answers });
}

export function listJobEvents(db: Db, jobId: number) {
  return db.select().from(jobEvents).where(eq(jobEvents.jobId, jobId)).orderBy(asc(jobEvents.id)).all();
}

export function addAttachments(db: Db, jobId: number, items: Array<{ kind: string; path: string; mime: string; fileName: string | null }>): void {
  const existing = listAttachments(db, jobId).length;
  items.forEach((item, i) => db.insert(jobAttachments).values({ ...item, jobId, sort: existing + i }).run());
}

export function listAttachments(db: Db, jobId: number) {
  return db.select().from(jobAttachments).where(eq(jobAttachments.jobId, jobId)).orderBy(asc(jobAttachments.sort), asc(jobAttachments.id)).all();
}

export function getAttachment(db: Db, userId: number, jobId: number, attachmentId: number) {
  const job = getJob(db, userId, jobId);
  if (!job) return undefined;
  return db
    .select()
    .from(jobAttachments)
    .where(and(eq(jobAttachments.jobId, jobId), eq(jobAttachments.id, attachmentId)))
    .get();
}

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\b(pty|ltd|limited|inc|llc|corp|corporation|co|group|holdings|plc|gmbh)\b\.?/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function upsertCompany(
  db: Db,
  userId: number,
  input: { name: string; domain?: string | null; atsType?: string | null; atsSlug?: string | null; country?: string | null },
): number {
  const normalizedName = normalizeCompanyName(input.name);
  const existing = db
    .select()
    .from(companies)
    .where(and(eq(companies.userId, userId), eq(companies.normalizedName, normalizedName)))
    .get();
  if (existing) {
    const patch: Partial<typeof companies.$inferInsert> = {};
    if (!existing.domain && input.domain) patch.domain = input.domain;
    if (!existing.atsType && input.atsType) Object.assign(patch, { atsType: input.atsType, atsSlug: input.atsSlug ?? null });
    if (!existing.country && input.country) patch.country = input.country;
    if (Object.keys(patch).length) db.update(companies).set(patch).where(eq(companies.id, existing.id)).run();
    return existing.id;
  }
  return db
    .insert(companies)
    .values({ userId, name: input.name, normalizedName, domain: input.domain ?? null, atsType: input.atsType ?? null, atsSlug: input.atsSlug ?? null, country: input.country ?? null })
    .returning()
    .get().id;
}

export function dedupeKeyFor(company: string | null, title: string | null, city: string | null): string | null {
  if (!company || !title) return null;
  const norm = (s: string | null) => (s ?? "").toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return [normalizeCompanyName(company), norm(title), norm(city)].join("|");
}
