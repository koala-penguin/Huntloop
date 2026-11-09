import type { InterviewAnswerRow } from "../db/schema";
import type { AiContext } from "../ai/client";
import { BASE_CV_PROMPT_VERSION, writeBaseCv } from "../ai/tasks/build-base-cv";
import { cvProfileHash, insertCvDocument, latestCvDocument, type StoredBaseCv } from "../repo/cv-documents";
import type { Db } from "../db/database";
import type { Interview } from "../repo/interviews";
import { recheckDocument } from "./tailor";
import { getInterview, listAnswers, updateInterview } from "../repo/interviews";
import { getCurrentProfile, getPreferences, savePreferences, saveProfileVersion } from "../repo/profile";
import { rescoreAllJobs } from "../jobs/fit";
import { UserFacingError } from "../errors";
import { assembleCv, cvContentText } from "./assemble";
import { buildProvenanceContext, validateCv } from "./provenance";
import { emptyProfile, type Fact, type ProfileData } from "@/shared/schemas/profile";
import type { Preferences } from "@/shared/schemas/preferences";
import type { CvChecks, TailoringPlan } from "@/shared/schemas/cv";
import { answerRole, currentRole, roleStageKey, rolesInOrder, targetFormSchema, type InterviewForm, type RoleForm, type StageStatus } from "@/shared/schemas/interview";

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

/**
 * Answers that count as evidence: not private, not replaced by an edit, each filed under its role
 * (answerRole). Answers of a removed role are dropped by the callers.
 */
export function evidenceAnswers(answers: InterviewAnswerRow[], form: InterviewForm): InterviewAnswerRow[] {
  return answers.filter((a) => !a.private && a.supersededBy === null && clean(a.quote)).map((a) => ({ ...a, experienceRef: answerRole(form, a) }));
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
  const evidence = evidenceAnswers(answers, form);
  const lines: string[] = [recordHeader(source.createdAt)];
  // No target line: what the candidate wants is not evidence of what they have done.
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
  const facts = evidence.filter((a) => a.experienceRef === null);
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
  const evidence = evidenceAnswers(answers, form);
  const skills = tickedSkills(form);

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
  // Answers about a role that was removed are not used at all: as facts they could land under any role.
  const interviewFacts: Fact[] = evidence.filter((a) => a.experienceRef === null).map((a) => ({ id: `fact-int-${a.id}`, text: clean(a.quote), source: "interview" }));

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
      workplace: t.workplace,
      employmentTypes: t.employmentTypes,
      willingToRelocate: t.willingToRelocate,
      markets: [{ country: form.setup.country, primary: true, cities: t.cities, remoteOk: t.remoteOk }],
    },
  };
}

/** The target form pre-filled from saved search preferences, cut to the form's limits. */
export function targetFromPreferences(prefs: Preferences, country: string): InterviewForm["target"] {
  const market = prefs.markets.find((m) => m.country === country);
  const list = (values: string[], count: number, length: number) => values.map((v) => v.trim().slice(0, length)).filter(Boolean).slice(0, count);
  return targetFormSchema.parse({
    titles: list(prefs.targetTitles, 20, 120),
    seniority: prefs.seniority,
    workplace: prefs.workplace,
    employmentTypes: prefs.employmentTypes,
    willingToRelocate: prefs.willingToRelocate,
    cities: list(market?.cities ?? [], 20, 80),
    remoteOk: market?.remoteOk ?? true,
  });
}

/** Merges the interview's search preferences into the saved ones, keeping everything else. */
export function mergePreferences(saved: Preferences, built: BuiltProfile["preferences"]): Preferences {
  const markets = [...built.markets, ...saved.markets.filter((m) => !built.markets.some((b) => b.country === m.country)).map((m) => ({ ...m, primary: false }))];
  const or = <T>(value: T[], fallback: T[]) => (value.length ? value : fallback);
  return {
    ...saved,
    targetTitles: or(built.targetTitles, saved.targetTitles),
    seniority: or(built.seniority, saved.seniority),
    workplace: or(built.workplace, saved.workplace),
    employmentTypes: or(built.employmentTypes, saved.employmentTypes),
    willingToRelocate: built.willingToRelocate,
    markets,
  };
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

const recordHeader = (createdAt: Date) => `CAREER RECORD — Huntloop interview, ${createdAt.toISOString().slice(0, 10)}`;

/**
 * After Generate, an answer edited, deleted or made private in the drawer must leave the saved
 * profile at once — it is sent to every assessment, tailored CV and chat. Rebuilds the profile from
 * the answers (no AI) when the current profile is this interview's Career record; a profile from an
 * uploaded CV is never touched. The base CV is re-checked (lines that used removed words are
 * flagged) and shows as out of date until generated again.
 */
export function applyInterviewEdits(db: Db, userId: number, interview: Interview): boolean {
  if (interview.profileVersion === null) return false;
  const current = getCurrentProfile(db, userId);
  if (!current || !current.cvText.startsWith(recordHeader(interview.createdAt))) return false;
  const built = buildProfileFromInterview(interview, listAnswers(db, interview.id, { includePrivate: true }), current.data);
  // Only the interview's evidence changes: the Career record, each interview role's highlights and the
  // interview facts. Everything the user changed in the profile editor stays as they left it.
  const highlights = new Map(built.data.experience.map((e) => [e.id, e.highlights]));
  const data: ProfileData = {
    ...current.data,
    experience: current.data.experience.map((e) => (highlights.has(e.id) ? { ...e, highlights: highlights.get(e.id)! } : e)),
    facts: [...current.data.facts.filter((f) => f.source !== "interview"), ...built.data.facts.filter((f) => f.source === "interview")],
  };
  if (cvProfileHash(built.cvText, data) === cvProfileHash(current.cvText, current.data)) return false;
  const saved = saveProfileVersion(db, userId, { cvText: built.cvText, data, simulated: false });
  updateInterview(db, interview.id, { profileVersion: saved.version });
  rescoreAllJobs(db, userId);
  const base = latestCvDocument(db, userId, "base", null);
  if (base) recheckDocument(db, userId, base);
  return true;
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
