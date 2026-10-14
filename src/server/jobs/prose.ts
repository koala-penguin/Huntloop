import { and, desc, eq } from "drizzle-orm";
import type { Assessment, PostingAnalysis } from "@/shared/schemas/job";
import type { CompanyReport } from "@/shared/schemas/company";
import { aiTexts } from "../db/schema";
import type { Db } from "../db/database";
import { translateTexts } from "../ai/tasks/translate";
import type { AiContext } from "../ai/client";

/**
 * AI-written prose is stored in the language it was written in. When the user reads it in another
 * language, the prose (never quotes, enums or numbers) is translated once and cached in ai_texts.
 */
export function assessmentProse(assessment: Assessment, analysis: PostingAnalysis, language: string): Record<string, string> {
  const out: Record<string, string> = { oneLine: assessment.oneLine, postingSummary: assessment.postingSummary };
  for (const item of assessment.items) {
    out[`reasoning.${item.requirementId}`] = item.reasoning;
    if (item.question) out[`question.${item.requirementId}`] = item.question;
    if (item.postingQuoteGloss) out[`gloss.${item.requirementId}`] = item.postingQuoteGloss;
  }
  // Requirements without a gloss (assessed in the posting's language) get one in the reader's language.
  if (analysis.language !== language) {
    for (const req of analysis.requirements) {
      if (!out[`gloss.${req.id}`]) out[`gloss.${req.id}`] = req.postingQuote;
    }
  }
  assessment.strengths.forEach((s, i) => (out[`strength.${i}`] = s.text));
  assessment.boosters.forEach((b, i) => (out[`booster.${i}`] = b.text));
  assessment.risks.forEach((r, i) => (out[`risk.${i}`] = r.text));
  return out;
}

export function applyProse(assessment: Assessment, prose: Record<string, string>): Assessment {
  const pick = (key: string, fallback: string) => prose[key] ?? fallback;
  return {
    ...assessment,
    oneLine: pick("oneLine", assessment.oneLine),
    postingSummary: pick("postingSummary", assessment.postingSummary),
    items: assessment.items.map((item) => ({
      ...item,
      reasoning: pick(`reasoning.${item.requirementId}`, item.reasoning),
      question: item.question ? pick(`question.${item.requirementId}`, item.question) : null,
      postingQuoteGloss: prose[`gloss.${item.requirementId}`] ?? item.postingQuoteGloss,
    })),
    strengths: assessment.strengths.map((s, i) => ({ ...s, text: pick(`strength.${i}`, s.text) })),
    boosters: assessment.boosters.map((b, i) => ({ ...b, text: pick(`booster.${i}`, b.text) })),
    risks: assessment.risks.map((r, i) => ({ ...r, text: pick(`risk.${i}`, r.text) })),
  };
}

type ProseOwner = "assessment" | "company_report";

function cachedProse(db: Db, ownerType: ProseOwner, ownerId: number, language: string): Record<string, string> | null {
  const row = db
    .select()
    .from(aiTexts)
    .where(and(eq(aiTexts.ownerType, ownerType), eq(aiTexts.ownerId, ownerId), eq(aiTexts.lang, language)))
    .orderBy(desc(aiTexts.id))
    .get();
  return row ? (row.data as Record<string, string>) : null;
}

export function getCachedTranslation(db: Db, assessmentId: number, language: string): Record<string, string> | null {
  return cachedProse(db, "assessment", assessmentId, language);
}

/** Whether some requirement quotes (e.g. work-rights gates, which aren't assessed) still need a gloss. */
export function missingGlosses(analysis: PostingAnalysis, assessment: Assessment, language: string): boolean {
  if (analysis.language === language) return false;
  const glossed = new Set(assessment.items.filter((i) => i.postingQuoteGloss).map((i) => i.requirementId));
  return analysis.requirements.some((r) => !glossed.has(r.id));
}

/**
 * Prose in the reader's language: a full translation when the assessment was written in another
 * language, otherwise only glosses for requirements the assessment didn't gloss.
 */
export async function translateAssessment(
  ctx: AiContext,
  assessmentId: number,
  assessment: Assessment,
  assessmentLanguage: string,
  analysis: PostingAnalysis,
  language: string,
) {
  const cached = getCachedTranslation(ctx.db, assessmentId, language);
  if (cached) return cached;
  const prose = assessmentProse(assessment, analysis, language);
  const texts =
    assessmentLanguage === language
      ? Object.fromEntries(Object.entries(prose).filter(([key]) => key.startsWith("gloss.") && !assessment.items.some((i) => `gloss.${i.requirementId}` === key && i.postingQuoteGloss)))
      : prose;
  const translated = await translateTexts(ctx, texts, language);
  ctx.db.insert(aiTexts).values({ ownerType: "assessment", ownerId: assessmentId, lang: language, data: translated }).run();
  return translated;
}

// ---- Employer research ----

const FOR_YOU = ["talkingPoints", "cvAngles", "questionsToAsk", "referralAngles"] as const;

/** An employer report's prose (summary, claims, advice, a few facts); URLs, dates and enums stay as they are. */
export function companyReportProse(report: CompanyReport): Record<string, string> {
  const out: Record<string, string> = { summary: report.summary };
  for (const key of ["headquarters", "size", "industry"] as const) {
    const value = report.facts[key];
    if (value) out[`fact.${key}`] = value;
  }
  report.sections.forEach((section, s) => section.claims.forEach((claim, c) => (out[`claim.${s}.${c}`] = claim.text)));
  for (const key of FOR_YOU) report.forYou[key].forEach((text, i) => (out[`forYou.${key}.${i}`] = text));
  return out;
}

export function applyCompanyReportProse(report: CompanyReport, prose: Record<string, string>): CompanyReport {
  const pick = (key: string, fallback: string) => prose[key] ?? fallback;
  const fact = (key: "headquarters" | "size" | "industry") => (report.facts[key] ? pick(`fact.${key}`, report.facts[key]) : null);
  return {
    ...report,
    summary: pick("summary", report.summary),
    facts: { ...report.facts, headquarters: fact("headquarters"), size: fact("size"), industry: fact("industry") },
    sections: report.sections.map((section, s) => ({ ...section, claims: section.claims.map((claim, c) => ({ ...claim, text: pick(`claim.${s}.${c}`, claim.text) })) })),
    forYou: Object.fromEntries(FOR_YOU.map((key) => [key, report.forYou[key].map((text, i) => pick(`forYou.${key}.${i}`, text))])) as CompanyReport["forYou"],
  };
}

export function getCachedReportTranslation(db: Db, reportId: number, language: string): Record<string, string> | null {
  return cachedProse(db, "company_report", reportId, language);
}

/** An employer report in the reader's language (translated once, cached per report and language). */
export async function translateCompanyReport(ctx: AiContext, reportId: number, report: CompanyReport, language: string) {
  const cached = getCachedReportTranslation(ctx.db, reportId, language);
  if (cached) return cached;
  const translated = await translateTexts(ctx, companyReportProse(report), language);
  ctx.db.insert(aiTexts).values({ ownerType: "company_report", ownerId: reportId, lang: language, data: translated }).run();
  return translated;
}
