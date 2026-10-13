import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { getJob } from "@/server/repo/jobs";
import { loadJobFit } from "@/server/jobs/fit";
import { translateAssessment } from "@/server/jobs/prose";
import { isLocale } from "@/i18n/locales";
import { AiError } from "@/server/ai/client";

export const runtime = "nodejs";

/** Translates a fit report's prose into the UI language (once; cached). */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/translate">) {
  const { language } = (await request.json().catch(() => ({}))) as { language?: unknown };
  if (!isLocale(language)) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { db, user } = appContext();
  const job = getJob(db, user.id, Number((await ctx.params).id));
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
