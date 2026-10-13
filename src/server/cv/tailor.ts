import type { Db } from "../db/database";
import type { JobRow } from "../db/schema";
import { getJob } from "../repo/jobs";
import { getCurrentProfile, getPreferences, type ProfileVersion } from "../repo/profile";
import { cvProfileHash, getCvDocument, insertCvDocument, updateCvDocument, type StoredCv, type StoredCvDocument, type StoredLinkedin } from "../repo/cv-documents";
import { loadJobFit, type JobFit } from "../jobs/fit";
import { keywordCoverage } from "../scoring/keywords";
import { UserFacingError } from "../errors";
import type { AiContext } from "../ai/client";
import { planTailoring, writeTailoredCv, TAILOR_PROMPT_VERSION, type TailorInput } from "../ai/tasks/tailor-cv";
import { writeLinkedinProfile, LINKEDIN_PROMPT_VERSION } from "../ai/tasks/linkedin-profile";
import { assembleCv, assembleLinkedin, cvContentText, cvLanguageFor } from "./assemble";
import { buildProvenanceContext, validateCv, validateLinkedin } from "./provenance";
import type { CvChecks, CvDocument, CvFlag, CvLanguage, CvLine, LinkedinDocument, TailoringPlan } from "@/shared/schemas/cv";

/**
 * Tailored CVs and LinkedIn drafts: generate (plan → write → assemble in code → check → store),
 * revise, and re-check after the user's edits.
 */

interface JobContext {
  job: JobRow;
  profile: ProfileVersion;
  fit: JobFit;
}

function jobContext(db: Db, userId: number, jobId: number): JobContext {
  const job = getJob(db, userId, jobId);
  if (!job) throw new UserFacingError("not_found");
  const profile = getCurrentProfile(db, userId);
  if (!profile) throw new UserFacingError("no_profile");
  const fit = loadJobFit(db, userId, job);
  if (!fit) throw new UserFacingError("not_analyzed");
  return { job, profile, fit };
}

function checkCv(doc: CvDocument, c: JobContext, plan: TailoringPlan | null): { flags: CvFlag[]; pageEstimate: number; text: string } {
  const pctx = buildProvenanceContext(c.profile, { analysis: c.fit.analysis, score: c.fit.score, plan });
  const text = cvContentText(doc);
  return { ...validateCv(doc, pctx, text), text };
}

/** Lines the user wrote in an earlier version keep their origin when a revision returns them unchanged. */
function keepUserLines(doc: CvDocument, previous: CvDocument | null): void {
  if (!previous) return;
  const userLines = new Map<string, CvLine>();
  for (const line of [...previous.summary, ...previous.roles.flatMap((r) => r.bullets)]) if (line.origin === "user") userLines.set(line.text, line);
  for (const line of [...doc.summary, ...doc.roles.flatMap((r) => r.bullets)]) {
    const prior = userLines.get(line.text);
    if (prior) Object.assign(line, { origin: "user", sourceRefs: prior.sourceRefs.map((r) => ({ ...r })) });
  }
}

export interface TailorOptions {
  revise?: { fromDocId: number; instructions: string };
  onStage?: (stage: "planning" | "writing" | "checking") => void;
}

export async function tailorCvForJob(ctx: AiContext, jobId: number, options: TailorOptions = {}): Promise<StoredCv> {
  const c = jobContext(ctx.db, ctx.userId, jobId);
  const { language, fallback } = cvLanguageFor(c.fit.analysis.language);
  const base = buildProvenanceContext(c.profile, { analysis: c.fit.analysis, score: c.fit.score, plan: null });
  const input: TailorInput = {
    profile: c.profile,
    job: { title: c.job.title, company: c.job.companyName, country: c.job.country },
    analysis: c.fit.analysis,
    assessment: c.fit.assessment,
    score: c.fit.score,
    language,
    doNotClaim: base.doNotClaim,
  };

  let previous: StoredCv | null = null;
  if (options.revise) {
    const from = getCvDocument(ctx.db, ctx.userId, options.revise.fromDocId);
    if (!from || from.kind !== "cv" || from.jobId !== jobId || !from.plan) throw new UserFacingError("not_found");
    previous = from;
  }

  options.onStage?.("planning");
  const plan = previous?.plan ?? (await planTailoring(ctx, input)).plan;
  options.onStage?.("writing");
  const { output, model } = await writeTailoredCv(ctx, input, plan, previous && options.revise ? { draft: previous.content, instructions: options.revise.instructions } : undefined);

  options.onStage?.("checking");
  const { doc, dropped, languageFallback } = assembleCv({ profile: c.profile, job: { country: c.job.country, postingLanguage: c.fit.analysis.language }, plan, output });
  keepUserLines(doc, previous?.content ?? null);
  const { flags, pageEstimate, text } = checkCv(doc, c, plan);
  const checks: CvChecks = {
    keywordsBefore: keywordCoverage(c.fit.analysis, c.profile.cvText),
    keywordsAfter: keywordCoverage(c.fit.analysis, text),
    pageEstimate,
    dropped,
    languageFallback: languageFallback || fallback,
  };
  return insertCvDocument(ctx.db, ctx.userId, {
    kind: "cv",
    jobId,
    profileVersion: c.profile.version,
    profileHash: cvProfileHash(c.profile.cvText, c.profile.data),
    analysisId: c.job.analysisId,
    language,
    market: doc.market,
    model,
    promptVersion: TAILOR_PROMPT_VERSION,
    plan,
    content: doc,
    flags,
    checks,
  }) as StoredCv;
}

export async function writeLinkedinForUser(ctx: AiContext, language: CvLanguage): Promise<StoredLinkedin> {
  const profile = getCurrentProfile(ctx.db, ctx.userId);
  if (!profile) throw new UserFacingError("no_profile");
  const { output, model } = await writeLinkedinProfile(ctx, { profile, preferences: getPreferences(ctx.db, ctx.userId), language });
  const { doc } = assembleLinkedin(profile, output, language);
  const flags = validateLinkedin(doc, buildProvenanceContext(profile, { analysis: null, score: null, plan: null }));
  return insertCvDocument(ctx.db, ctx.userId, {
    kind: "linkedin",
    jobId: null,
    profileVersion: profile.version,
    profileHash: cvProfileHash(profile.cvText, profile.data),
    analysisId: null,
    language,
    market: null,
    model,
    promptVersion: LINKEDIN_PROMPT_VERSION,
    content: doc,
    flags,
  }) as StoredLinkedin;
}

/** Re-runs the checks on a document after the user changed it (or their profile). */
export function recheckDocument(db: Db, userId: number, doc: StoredCvDocument, profileUpdate?: { version: number; hash: string }): StoredCvDocument {
  const profile = getCurrentProfile(db, userId);
  if (!profile) throw new UserFacingError("no_profile");
  const stamp = profileUpdate ? { profileVersion: profileUpdate.version, profileHash: profileUpdate.hash } : {};
  if (doc.kind === "linkedin") {
    const content = structuredClone(doc.content) as LinkedinDocument;
    const flags = validateLinkedin(content, buildProvenanceContext(profile, { analysis: null, score: null, plan: null }));
    return updateCvDocument(db, doc.id, { content, flags, ...stamp });
  }
  const c = jobContext(db, userId, doc.jobId!);
  const content = structuredClone(doc.content);
  const { flags, pageEstimate, text } = checkCv(content, c, doc.plan);
  const checks: CvChecks = {
    keywordsBefore: doc.checks?.keywordsBefore ?? null,
    keywordsAfter: keywordCoverage(c.fit.analysis, text),
    pageEstimate,
    dropped: doc.checks?.dropped ?? 0,
    languageFallback: doc.checks?.languageFallback ?? false,
  };
  return updateCvDocument(db, doc.id, { content, flags, checks, ...stamp });
}

/** The document no longer matches the profile (or the job's analysis) it was written from. */
export function isCvStale(doc: StoredCvDocument, profile: ProfileVersion | null, job?: Pick<JobRow, "analysisId"> | null): boolean {
  if (!profile) return false;
  if (doc.profileHash !== cvProfileHash(profile.cvText, profile.data)) return true;
  return doc.kind === "cv" && !!job && doc.analysisId !== job.analysisId;
}
