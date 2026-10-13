import { z } from "zod";
import { researchCompany } from "../../ai/tasks/company-research";
import { COMPANY_RESEARCH_TASK, getCompany, saveReport, trackedJobCount } from "../../research/company";
import { fetchAtsBoardSummary, type AtsType } from "../../sources/ats";
import { getJob } from "../../repo/jobs";
import { getCurrentProfile } from "../../repo/profile";
import { getLocalUser, userLocale } from "../../repo/users";
import { UserFacingError } from "../../errors";
import { registerTaskHandler, type TaskContext } from "../runner";
import type { CompanyReport } from "@/shared/schemas/company";

const payloadSchema = z.object({ companyId: z.number().int(), jobId: z.number().int().nullable().optional() });

export async function runCompanyResearch(ctx: TaskContext): Promise<{ reportId: number; droppedClaims: number }> {
  const payload = payloadSchema.parse(ctx.payload);
  const company = getCompany(ctx.db, ctx.userId, payload.companyId);
  if (!company) throw new UserFacingError("not_found");
  const job = payload.jobId ? getJob(ctx.db, ctx.userId, payload.jobId) : undefined;
  const profile = getCurrentProfile(ctx.db, ctx.userId);
  const language = userLocale(getLocalUser(ctx.db));
  const notes: string[] = [];
  ctx.progress({ stage: "researching", notes });

  const result = await researchCompany(
    { db: ctx.db, userId: ctx.userId, signal: ctx.signal },
    {
      company: { name: company.name, domain: company.domain, country: company.country },
      job: job ? { title: job.title, location: job.locationText, country: job.country } : null,
      candidate: profile
        ? {
            headline: profile.data.basics.headline,
            recentTitles: profile.data.experience.slice(0, 3).map((e) => e.title),
            topSkills: profile.data.skills.slice(0, 12).map((s) => s.name),
          }
        : null,
      language,
    },
    (note) => {
      if (notes.at(-1) === note) return;
      notes.push(note);
      ctx.progress({ stage: "researching", notes: notes.slice(-6) });
    },
  );

  ctx.progress({ stage: "hiring", notes: notes.slice(-6) });
  let ats: CompanyReport["hiring"]["ats"] = null;
  if (company.atsType && company.atsSlug) {
    try {
      const summary = await fetchAtsBoardSummary(company.atsType as AtsType, company.atsSlug);
      ats = { type: company.atsType, board: company.atsSlug, ...summary };
    } catch {
      ats = null;
    }
  }

  const report: CompanyReport = {
    ...result.report,
    asOf: new Date().toISOString().slice(0, 10),
    language,
    droppedClaims: result.dropped,
    sources: result.sources,
    hiring: { ats, trackedJobs: trackedJobCount(ctx.db, ctx.userId, company.id) },
  };
  const stored = saveReport(ctx.db, company.id, report, result.model);
  ctx.progress({ stage: "done" });
  return { reportId: stored.id, droppedClaims: result.dropped };
}

registerTaskHandler(COMPANY_RESEARCH_TASK, { run: runCompanyResearch, maxAttempts: 1 });
