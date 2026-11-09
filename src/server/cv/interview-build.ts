import type { InterviewAnswerRow } from "../db/schema";
import type { AiContext } from "../ai/client";
import { BASE_CV_PROMPT_VERSION, writeBaseCv } from "../ai/tasks/build-base-cv";
import { cvProfileHash, insertCvDocument, type StoredBaseCv } from "../repo/cv-documents";
import { getInterview, listAnswers, updateInterview } from "../repo/interviews";
import { getCurrentProfile, getPreferences, savePreferences, saveProfileVersion } from "../repo/profile";
import { rescoreAllJobs } from "../jobs/fit";
import { UserFacingError } from "../errors";
import { assembleCv, cvContentText } from "./assemble";
import { buildProvenanceContext, validateCv } from "./provenance";
import { emptyProfile, type Fact, type ProfileData } from "@/shared/schemas/profile";
import type { Preferences } from "@/shared/schemas/preferences";
import type { CvChecks, TailoringPlan } from "@/shared/schemas/cv";
import { currentRole, roleStageKey, rolesInOrder, type InterviewForm, type RoleForm, type StageStatus } from "@/shared/schemas/interview";

/**
 * From interview to profile and base CV. The interview's answers are the candidate's own typed words; they
 * become the role highlights and facts verbatim, and the "Career record" — plain text built here
 * from the same words plus the form data — takes the place a CV's text has. Every existing check
 * (quotes, numbers, role scope) then works on interview evidence unchanged. No AI, no database.
 */

export interface InterviewSource {
  form: InterviewForm;
  stages: Record<string, StageStatus>;
  createdAt: Date;
}

export interface BuiltProfile {
  cvText: string;
  data: ProfileData;
  /** What the interview says about the job search (merged into the saved preferences). */
  preferences: Pick<Preferences, "targetTitles" | "seniority" | "workplace" | "employmentTypes" | "willingToRelocate" | "markets">;
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const orNull = (text: string | null | undefined) => (text && text.trim() ? text.trim() : null);

/** Answers that count as evidence: not private, not replaced by an edit. */
export function evidenceAnswers(answers: InterviewAnswerRow[]): InterviewAnswerRow[] {
  return answers.filter((a) => !a.private && a.supersededBy === null && clean(a.quote));
}

function period(start: string, end: string): string {
  return `${start || "?"} – ${end || "present"}`;
}

function roleHeading(role: RoleForm): string {
  const place = [role.location, role.country].filter(Boolean).join(" ");
  return `ROLE ${role.id}: ${role.title || "Untitled role"} — ${role.company || "Unnamed employer"} (${[period(role.start, role.end), place].filter(Boolean).join(", ")})`;
}

/** The Career record: deterministic plain text, one verbatim answer per line, no contact details. */
export function careerRecord(source: InterviewSource, answers: InterviewAnswerRow[]): string {
  const { form } = source;
  const evidence = evidenceAnswers(answers);
  const lines: string[] = [`CAREER RECORD — Huntloop interview, ${source.createdAt.toISOString().slice(0, 10)}`];
  const target = [form.target.titles.join(", "), [form.target.cities.join(", "), `(${form.setup.country})`].filter(Boolean).join(" "), form.target.seniority.join(", ")].filter((p) => p.trim());
  if (form.target.titles.length) lines.push(`TARGET: ${target.join(" · ")}`);
  const current = form.current;
  if (current.title) lines.push(`CURRENT: ${[current.title, current.company, current.start ? period(current.start, "") : ""].filter(Boolean).join(", ")}`);
  for (const role of rolesInOrder(form)) {
    lines.push(roleHeading(role));
    for (const a of evidence.filter((x) => x.experienceRef === role.id)) lines.push(`  ${a.topic}: ${clean(a.quote)}`);
  }
  for (const e of form.education) lines.push(`EDUCATION: ${[e.degree, e.field].filter(Boolean).join(", ") || "Study"} — ${e.institution} (${period(e.start ?? "", e.end ?? "")})`);
  for (const c of form.certifications) lines.push(`CERTIFICATION: ${[c.name, c.issuer, c.year].filter(Boolean).join(", ")}`);
  if (form.languages.length) lines.push(`LANGUAGES: ${form.languages.map((l) => `${l.language} (${l.level})`).join("; ")}`);
  const skills = tickedSkills(form).map((s) => s.name);
  if (skills.length) lines.push(`SKILLS: ${skills.join(", ")}`);
  const facts = evidence.filter((a) => a.experienceRef === null || !form.roles.some((r) => r.id === a.experienceRef));
  if (facts.length) {
    lines.push("FACTS:");
    for (const a of facts) lines.push(`  ${a.topic}: ${clean(a.quote)}`);
  }
  return lines.join("\n");
}

function tickedSkills(form: InterviewForm): Array<{ name: string; category: ProfileData["skills"][number]["category"]; experienceRef: string | null }> {
  const seen = new Set<string>();
  return form.skills.filter((s) => s.ticked && !seen.has(s.name.trim().toLowerCase()) && seen.add(s.name.trim().toLowerCase())).map((s) => ({ name: s.name.trim(), category: s.category, experienceRef: s.experienceRef }));
}

/**
 * The profile the interview describes. With a previous profile, the interview replaces experience,
 * education and skills (the old version stays in history) but keeps the user's own and chat facts,
 * and work rights and clearances for countries the interview didn't cover.
 */
export function buildProfileFromInterview(source: InterviewSource, answers: InterviewAnswerRow[], previous: ProfileData | null): BuiltProfile {
  const { form } = source;
  const evidence = evidenceAnswers(answers);
  const skills = tickedSkills(form);
  const roleIds = new Set(form.roles.map((r) => r.id));

  const experience: ProfileData["experience"] = rolesInOrder(form).map((r) => ({
    id: r.id,
    title: r.title,
    company: r.company,
    industry: orNull(r.industry),
    location: orNull(r.location),
    country: orNull(r.country),
    start: orNull(r.start),
    end: orNull(r.end),
    seniority: r.seniority,
    skills: skills.filter((s) => s.experienceRef === r.id).map((s) => s.name),
    highlights: evidence.filter((a) => a.experienceRef === r.id).map((a) => clean(a.quote)),
  }));
  const interviewFacts: Fact[] = evidence.filter((a) => a.experienceRef === null || !roleIds.has(a.experienceRef)).map((a) => ({ id: `fact-int-${a.id}`, text: clean(a.quote), source: "interview" }));

  const rights = new Map((previous?.workRights ?? []).map((w) => [w.country, w]));
  for (const w of form.target.workRights) rights.set(w.country, w);
  const setCountries = new Set(form.target.clearances.map((c) => c.country));
  const clearances = [...(previous?.clearances ?? []).filter((c) => !setCountries.has(c.country)), ...form.target.clearances];

  const c = form.contact;
  const data: ProfileData = {
    ...emptyProfile(),
    basics: {
      name: orNull(c.name),
      email: orNull(c.email),
      phone: orNull(c.phone),
      headline: orNull(c.headline),
      summary: null,
      city: orNull(c.city),
      country: orNull(c.country),
      links: c.links.map((l) => l.trim()).filter(Boolean),
    },
    experience,
    skills: skills.map(({ name, category }) => ({ name, category })),
    education: form.education,
    certifications: form.certifications,
    languages: form.languages,
    clearances,
    workRights: [...rights.values()],
    facts: [...(previous?.facts ?? []).filter((f) => f.source === "user" || f.source === "chat"), ...interviewFacts],
  };

  const t = form.target;
  return {
    cvText: careerRecord(source, answers),
    data,
    preferences: {
      targetTitles: t.titles,
      seniority: t.seniority,
      workplace: t.workplace.length ? t.workplace : ["onsite", "hybrid", "remote"],
      employmentTypes: t.employmentTypes.length ? t.employmentTypes : ["full_time"],
      willingToRelocate: t.willingToRelocate,
      markets: [{ country: form.setup.country, primary: true, cities: t.cities, remoteOk: t.remoteOk }],
    },
  };
}

/** Merges the interview's search preferences into the saved ones, keeping everything else. */
export function mergePreferences(saved: Preferences, built: BuiltProfile["preferences"]): Preferences {
  const markets = [...built.markets, ...saved.markets.filter((m) => !built.markets.some((b) => b.country === m.country)).map((m) => ({ ...m, primary: false }))];
  return { ...saved, ...built, targetTitles: built.targetTitles.length ? built.targetTitles : saved.targetTitles, markets };
}

export type MissingStage = "target" | "roles" | "role_deep" | "contact";

/** What generating needs: a target, at least one role, the current role's chat done, and a name. */
export function interviewReady(source: Pick<InterviewSource, "form" | "stages">): { ok: true } | { ok: false; missing: MissingStage[] } {
  const { form, stages } = source;
  const missing: MissingStage[] = [];
  if (!form.target.titles.some((t) => t.trim())) missing.push("target");
  const current = currentRole(form);
  if (!current) missing.push("roles");
  else if (stages[roleStageKey(current.id)] !== "done") missing.push("role_deep");
  if (!form.contact.name.trim()) missing.push("contact");
  return missing.length ? { ok: false, missing } : { ok: true };
}

/** Below this the Career record can't carry a CV (a name, a title and little else). */
const MIN_RECORD = 100;

export interface GenerateOptions {
  onStage?: (stage: "building" | "writing" | "checking") => void;
}

/**
 * Generate: interview → profile version (+ search preferences) → base CV, checked like any CV.
 * Saving is idempotent (a retry doesn't add a duplicate profile version). The writer runs under the
 * daily budget cap; the interview chat before it never does.
 */
export async function generateBaseCv(ctx: AiContext, interviewId: number, options: GenerateOptions = {}): Promise<StoredBaseCv> {
  const { db, userId } = ctx;
  const interview = getInterview(db, userId, interviewId);
  if (!interview) throw new UserFacingError("not_found");
  if (!interviewReady(interview).ok) throw new UserFacingError("interview_too_short");

  options.onStage?.("building");
  const previous = getCurrentProfile(db, userId);
  const built = buildProfileFromInterview(interview, listAnswers(db, interview.id, { includePrivate: true }), previous?.data ?? null);
  if (built.cvText.length < MIN_RECORD) throw new UserFacingError("interview_too_short");
  const hash = cvProfileHash(built.cvText, built.data);
  const profile =
    previous && cvProfileHash(previous.cvText, previous.data) === hash
      ? previous
      : // The content is the user's own typed words, so it is never "demo" output, even in demo mode.
        saveProfileVersion(db, userId, { cvText: built.cvText, data: built.data, cvFileName: null, cvFilePath: null, simulated: false });
  savePreferences(db, userId, mergePreferences(getPreferences(db, userId), built.preferences));
  rescoreAllJobs(db, userId);

  options.onStage?.("writing");
  const { form } = interview;
  const language = form.contact.cvLanguage;
  const depth = Object.fromEntries(form.roles.map((r) => [r.id, r.depth]));
  const { output, model, simulated } = await writeBaseCv(ctx, {
    profile,
    target: { titles: form.target.titles, seniority: form.target.seniority, country: form.setup.country },
    depth,
    language,
  });

  options.onStage?.("checking");
  const lead = currentRole(form)?.id;
  const plan: TailoringPlan = {
    summaryAngle: "",
    targetRequirementIds: [],
    roles: profile.data.experience.map((e) => ({ experienceId: e.id, include: true, emphasis: depth[e.id] === "brief" ? "brief" : e.id === lead ? "lead" : "normal" })),
    keywords: [],
    doNotClaim: [],
    questions: [],
    linkedinEmphasis: [],
    advice: [],
  };
  const { doc, dropped, languageFallback } = assembleCv({ profile, job: { country: form.setup.country, postingLanguage: language }, plan, output });
  const text = cvContentText(doc);
  const { flags, pageEstimate } = validateCv(doc, buildProvenanceContext(profile, { analysis: null, score: null, plan: null }), text);
  const checks: CvChecks = { keywordsBefore: null, keywordsAfter: null, pageEstimate, dropped, languageFallback };
  const stored = insertCvDocument(db, userId, {
    kind: "base",
    jobId: null,
    profileVersion: profile.version,
    profileHash: cvProfileHash(profile.cvText, profile.data),
    analysisId: null,
    language,
    market: doc.market,
    model,
    promptVersion: BASE_CV_PROMPT_VERSION,
    plan: null,
    content: doc,
    flags,
    checks,
    simulated,
  }) as StoredBaseCv;
  updateInterview(db, interview.id, { profileVersion: profile.version, baseDocId: stored.id, status: "completed", stage: "review", completedAt: new Date() });
  return stored;
}
