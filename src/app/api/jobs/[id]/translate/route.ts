import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { getJob } from "@/server/repo/jobs";
import { loadJobFit } from "@/server/jobs/fit";
import { translateAssessment, translateCompanyReport } from "@/server/jobs/prose";
import { getLatestReport } from "@/server/research/company";
import { isLocale } from "@/i18n/locales";
import { AiError } from "@/server/ai/client";

export const runtime = "nodejs";

/** Translates a job's fit report, or its employer report ("what": "employer"), into the UI language (once; cached). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/translate">) {
  const { language, what } = (await request.json().catch(() => ({}))) as { language?: unknown; what?: unknown };
  if (!isLocale(language)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { db, user } = appContext();
  const job = getJob(db, user.id, Number((await ctx.params).id));
  if (what === "employer") {
    const report = job?.companyId ? getLatestReport(db, job.companyId) : null;
    if (!report) return NextResponse.json({ error: "not_found" }, { status: 404 });
    try {
      await translateCompanyReport({ db, userId: user.id }, report.id, report.report, language);
      return NextResponse.json({ ok: true });
    } catch (error) {
      if (error instanceof AiError) return NextResponse.json({ error: error.code }, { status: 502 });
      throw error;
    }
  }
  const fit = job ? loadJobFit(db, user.id, job) : null;
  if (!fit?.assessment || !fit.assessmentId) return NextResponse.json({ error: "not_found" }, { status: 404 });
  try {
    await translateAssessment({ db, userId: user.id }, fit.assessmentId, fit.assessment, fit.assessmentLanguage ?? "en", fit.analysis, language);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AiError) return NextResponse.json({ error: error.code }, { status: 502 });
    throw error;
  }
}
