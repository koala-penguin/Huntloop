import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { companyReportSchema, type CompanyReport } from "@/shared/schemas/company";
import type { Db } from "../db/database";
import { companies, companyReports, jobs, tasks, type JobRow } from "../db/schema";
import { enqueueTask } from "../tasks/runner";
import type { AiContext } from "../ai/client";

export const COMPANY_RESEARCH_TASK = "company-research";
export const REPORT_TTL_DAYS = 30;

export interface StoredReport {
  id: number;
  companyId: number;
  report: CompanyReport;
  createdAt: Date;
  expiresAt: Date;
  /** Older than the reuse window: still shown, but research should be refreshed. */
  stale: boolean;
}

function toStored(row: typeof companyReports.$inferSelect, now = new Date()): StoredReport | null {
  const base = companyReportSchema.safeParse(row.data);
  if (!base.success) return null;
  return { id: row.id, companyId: row.companyId, report: row.data as CompanyReport, createdAt: row.createdAt, expiresAt: row.expiresAt, stale: row.expiresAt <= now };
}

export function getCompany(db: Db, userId: number, companyId: number) {
  return db
    .select()
    .from(companies)
    .where(and(eq(companies.userId, userId), eq(companies.id, companyId)))
    .get();
}

export function getLatestReport(db: Db, companyId: number, now = new Date()): StoredReport | null {
  const row = db.select().from(companyReports).where(eq(companyReports.companyId, companyId)).orderBy(desc(companyReports.id)).get();
  return row ? toStored(row, now) : null;
}

export function getFreshReport(db: Db, companyId: number, now = new Date()): StoredReport | null {
  const row = db
    .select()
    .from(companyReports)
    .where(and(eq(companyReports.companyId, companyId), gt(companyReports.expiresAt, now)))
    .orderBy(desc(companyReports.id))
    .get();
  return row ? toStored(row, now) : null;
}

export function saveReport(db: Db, companyId: number, report: CompanyReport, model: string, now = new Date()): StoredReport {
  const row = db
    .insert(companyReports)
    .values({ companyId, language: report.language, model, data: report, createdAt: now, expiresAt: new Date(now.getTime() + REPORT_TTL_DAYS * 86_400_000) })
    .returning()
    .get();
  return toStored(row)!;
}

export function activeResearchTask(db: Db, userId: number, companyId: number): number | null {
  const row = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.userId, userId),
        eq(tasks.kind, COMPANY_RESEARCH_TASK),
        inArray(tasks.status, ["queued", "running"]),
        sql`json_extract(${tasks.payload}, '$.companyId') = ${companyId}`,
      ),
    )
    .orderBy(desc(tasks.id))
    .get();
  return row?.id ?? null;
}

export function trackedJobCount(db: Db, userId: number, companyId: number): number {
  return db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.userId, userId), eq(jobs.companyId, companyId)))
    .all().length;
}

export type StartResult = { ok: true; taskId: number | null; reused: boolean } | { ok: false; reason: "no_company" };

/** Starts research unless a fresh report exists (or one is already running). `force` refreshes. */
export function startCompanyResearch(db: Db, userId: number, job: Pick<JobRow, "id" | "companyId">, options: { force?: boolean } = {}): StartResult {
  if (!job.companyId) return { ok: false, reason: "no_company" };
  if (!options.force && getFreshReport(db, job.companyId)) return { ok: true, taskId: null, reused: true };
  const running = activeResearchTask(db, userId, job.companyId);
  if (running) return { ok: true, taskId: running, reused: false };
  const task = enqueueTask(db, userId, COMPANY_RESEARCH_TASK, { companyId: job.companyId, jobId: job.id });
  return { ok: true, taskId: task.id, reused: false };
}

/** A compact plain-text version of a report, for the chat's context. */
export function reportDigest(report: CompanyReport, maxChars = 6000): string {
  const lines = [`As of ${report.asOf}. ${report.summary}`];
  const f = report.facts;
  lines.push(
    [f.website && `Website: ${f.website}`, f.headquarters && `HQ: ${f.headquarters}`, f.size && `Size: ${f.size}`, `Ownership: ${f.ownership}`, f.industry && `Industry: ${f.industry}`]
      .filter(Boolean)
      .join(" · "),
  );
  if (report.hiring.ats) lines.push(`Open roles on their ${report.hiring.ats.type} board: ${report.hiring.ats.total} (${report.hiring.ats.byDepartment.map((d) => `${d.name} ${d.count}`).join(", ")}).`);
  for (const section of report.sections) {
    lines.push(`[${section.key}, ${section.confidence} confidence]`);
    for (const c of section.claims) lines.push(`- ${c.text}${c.date ? ` (${c.date})` : ""} <${c.sourceUrl}>`);
  }
  const out = lines.join("\n");
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out;
}

/** Bridges the chat to research (used by the chat's tool and context updates). */
export const researchForChat = {
  isReady(ctx: Pick<AiContext, "db" | "userId">, job: JobRow): boolean {
    return !!job.companyId && !!getFreshReport(ctx.db, job.companyId);
  },
  start(ctx: AiContext, job: JobRow): { ok: boolean; message: string } {
    const result = startCompanyResearch(ctx.db, ctx.userId, job);
    if (!result.ok) return { ok: false, message: "The employer's name isn't known for this job, so it can't be researched." };
    if (result.reused) return { ok: true, message: "A recent employer report already exists; it is shown on the job page and its summary is in your context." };
    return { ok: true, message: "Employer research started in the background (it takes a few minutes). You'll receive the report in a context update when it's done." };
  },
  summaryFor(ctx: Pick<AiContext, "db" | "userId">, job: JobRow): string | null {
    const report = job.companyId ? getFreshReport(ctx.db, job.companyId) : null;
    return report ? reportDigest(report.report) : null;
  },
};
