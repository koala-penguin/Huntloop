import { experienceYears } from "@/shared/experience";
import type { PostingAnalysis, ScoreResult } from "@/shared/schemas/job";
import type { ProfileData } from "@/shared/schemas/profile";
import {
  LINKEDIN_LIMITS,
  type CvDocument,
  type CvFlag,
  type CvLine,
  type FlagKind,
  type LinkedinDocument,
  type TailoringPlan,
} from "@/shared/schemas/cv";
import { buildQuoteIndex, quoteFound, type QuoteIndex } from "../scoring/quotes";
import { keywordRequirements, termPresent } from "../scoring/keywords";

/**
 * Truthfulness checks for AI-written CV and LinkedIn text. Every line must rest on quotes that really
 * are in the CV (or in a fact the user confirmed); numbers must come from those quotes; requirements
 * the candidate doesn't meet must not be claimed. Anything that fails is flagged for the user — a
 * blocking flag stops export until it's resolved. Lines the user wrote themselves only get warnings.
 */

export interface ProvenanceContext {
  cvIndex: QuoteIndex;
  cvText: string;
  facts: Map<string, QuoteIndex>;
  allFacts: QuoteIndex;
  factText: string;
  /** Per role: its own highlights. */
  roleIndex: Map<string, QuoteIndex>;
  roleSkills: Map<string, string[]>;
  profileSkills: string[];
  /** Whole years of experience (merged date ranges) — "N+ years" claims up to this are fine. */
  years: number;
  /** Terms the CV must not claim (requirements the candidate doesn't meet). */
  doNotClaim: string[];
  /** Posting keywords (skills, certifications, titles). */
  postingTerms: string[];
}

const YEARS_PREFIX = /^\s*\d+\s*\+?\s*(years?|yrs?)\s*(of\s+)?(experience\s+(in|with)\s+)?/i;

/** The requirement's short term, without an "N+ years of" prefix. */
function claimTerm(normalized: string): string {
  return normalized.replace(YEARS_PREFIX, "").trim();
}

export function buildProvenanceContext(
  profile: { cvText: string; data: ProfileData },
  job: { analysis: Pick<PostingAnalysis, "requirements"> | null; score: Pick<ScoreResult, "items"> | null; plan: Pick<TailoringPlan, "doNotClaim"> | null },
  now = new Date(),
): ProvenanceContext {
  const { data } = profile;
  // Code-scored statuses (after the user's answers) decide; the plan can only add to the list.
  const statusOf = new Map((job.score?.items ?? []).map((i) => [i.requirementId, i.status]));
  const reqs = job.analysis?.requirements ?? [];
  const planIds = new Set((job.plan?.doNotClaim ?? []).map((d) => d.requirementId));
  const notMet = (id: string) => job.score !== null && ["unmet", "unknown"].includes(statusOf.get(id) ?? "unknown");
  const doNotClaim = reqs
    .filter((r) => !["work_rights", "location", "years"].includes(r.category) && r.kind !== "gate")
    .filter((r) => planIds.has(r.id) || notMet(r.id))
    .map((r) => claimTerm(r.normalized))
    .filter((t) => t.length > 1);
  return {
    cvIndex: buildQuoteIndex(profile.cvText, ...data.experience.flatMap((e) => e.highlights)),
    cvText: profile.cvText,
    facts: new Map(data.facts.map((f) => [f.id, buildQuoteIndex(f.text)])),
    allFacts: buildQuoteIndex(...data.facts.map((f) => f.text)),
    factText: data.facts.map((f) => f.text).join("\n"),
    roleIndex: new Map(data.experience.map((e) => [e.id, buildQuoteIndex(...e.highlights)])),
    roleSkills: new Map(data.experience.map((e) => [e.id, e.skills])),
    profileSkills: [...data.skills.map((s) => s.name), ...data.experience.flatMap((e) => e.skills)],
    years: Math.floor(experienceYears(data.experience, now)),
    doNotClaim: [...new Set(doNotClaim)],
    postingTerms: [...new Set(keywordRequirements({ requirements: reqs }).map((r) => claimTerm(r.normalized)).filter((t) => t.length > 1))],
  };
}

// ---- Numbers ----

export interface FoundNumber {
  raw: string;
  kind: "percent" | "multiple" | "number";
  value: number;
  /** Followed by "years" / "yrs" / "년". */
  years: boolean;
  /** A plain 4-digit calendar year (1950–2100). */
  calendarYear: boolean;
}

const MULTIPLIERS: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, 천: 1e3, 만: 1e4, 억: 1e8 };
const NUMBER = new RegExp(
  [
    "(?<![\\p{L}\\p{N}.,])(?:[A-Z]{0,2}[$€£₩¥])?\\s?",
    "(?<int>\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(?<frac>\\d+))?",
    // Latin multipliers must end the word ("5m", not "5 months"); Korean units may be followed by a noun (200만원).
    "(?:\\s?(?<mult>k|mm|m|bn|b|thousand|million|billion)(?![\\p{L}])|\\s?(?<kmult>천|만|억))?",
    "\\s?(?<unit>%|per ?cent|percent|x(?![\\p{L}])|×)?(?<plus>\\+)?",
    "(?:\\s?(?<years>years?|yrs?|년))?",
  ].join(""),
  "giu",
);

export function extractNumbers(text: string): FoundNumber[] {
  const out: FoundNumber[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const g = m.groups ?? {};
    const raw = m[0];
    const mult = g.mult ?? g.kmult;
    // Skip digits glued to letters ("3D", "H1"): part of a name, not a quantity.
    const after = text.charAt((m.index ?? 0) + raw.length);
    if (!g.unit && !mult && !g.years && !g.plus && /\p{L}/u.test(after) && !/\s$/.test(raw)) continue;
    let value = Number(`${g.int.replace(/,/g, "")}${g.frac ? `.${g.frac}` : ""}`);
    if (mult) value *= MULTIPLIERS[mult.toLowerCase()] ?? 1;
    const unit = (g.unit ?? "").toLowerCase();
    const kind = unit === "x" || unit === "×" ? "multiple" : unit ? "percent" : "number";
    const calendarYear = kind === "number" && !mult && !g.frac && /^\d{4}$/.test(g.int) && value >= 1950 && value <= 2100;
    out.push({ raw: raw.trim(), kind, value, years: !!g.years, calendarYear });
  }
  return out;
}

const sameNumber = (a: FoundNumber, b: FoundNumber) => a.kind === b.kind && Math.abs(a.value - b.value) <= Math.abs(b.value) * 1e-9;

// ---- Line checks ----

export interface LineScope {
  /** The role a bullet belongs to (null for summary, headline, About). */
  roleId: string | null;
}

function flag(kind: FlagKind, line: CvLine | null, severity: "block" | "warn", params: Record<string, string | number>, n = 0): CvFlag {
  return { id: `${kind}:${line?.id ?? "doc"}:${n}`, lineId: line?.id ?? null, kind, severity, params };
}

/** Marks each source quote verified or not and returns the flags for one line. */
export function checkLine(line: CvLine, scope: LineScope, pctx: ProvenanceContext): CvFlag[] {
  const flags: CvFlag[] = [];
  const severity = line.origin === "user" ? "warn" : "block";

  for (const ref of line.sourceRefs) {
    if (ref.source === "fact") {
      const index = ref.factId ? pctx.facts.get(ref.factId) : pctx.allFacts;
      ref.verified = !!index && quoteFound(ref.quote, index);
    } else {
      ref.verified = quoteFound(ref.quote, pctx.cvIndex);
    }
  }
  const verified = line.sourceRefs.filter((r) => r.verified);
  line.sourceRefs.forEach((ref, i) => {
    if (!ref.verified) flags.push(flag("unverified_source", line, severity, { quote: ref.quote.slice(0, 160) }, i));
  });

  // AI lines need a real source (a quote of 3+ words). User lines are the user's own words; profile
  // lines are CV bullets copied as they are.
  const substantial = verified.filter((r) => r.quote.trim().split(/\s+/).length >= 3 || /[\p{Script=Hangul}]{4,}/u.test(r.quote));
  if (!substantial.length && line.origin === "ai") flags.push(flag("unsourced", line, "block", {}));

  if (scope.roleId) {
    const own = pctx.roleIndex.get(scope.roleId);
    const otherRole = verified.some(
      (r) => r.source === "cv" && own && !quoteFound(r.quote, own) && [...pctx.roleIndex].some(([id, idx]) => id !== scope.roleId && quoteFound(r.quote, idx)),
    );
    if (otherRole) flags.push(flag("other_role", line, severity, {}));
  }

  const sourceText = verified.map((r) => r.quote).join("\n");
  const sourceNumbers = extractNumbers(sourceText);
  const background = extractNumbers(`${pctx.cvText}\n${pctx.factText}`);
  extractNumbers(line.text).forEach((n, i) => {
    if (sourceNumbers.some((s) => sameNumber(n, s))) return;
    if (n.years && n.kind === "number" && n.value <= pctx.years) return;
    if (n.calendarYear && background.some((s) => sameNumber(n, s))) return;
    flags.push(flag("number", line, severity, { number: n.raw }, i));
  });

  const claimed = new Set<string>();
  pctx.doNotClaim.forEach((term, i) => {
    if (termPresent(line.text, term) && !termPresent(sourceText, term)) {
      claimed.add(term.toLowerCase());
      flags.push(flag("do_not_claim", line, severity, { term }, i));
    }
  });
  const skills = scope.roleId ? (pctx.roleSkills.get(scope.roleId) ?? []) : pctx.profileSkills;
  pctx.postingTerms.forEach((term, i) => {
    if (claimed.has(term.toLowerCase()) || !termPresent(line.text, term) || termPresent(sourceText, term)) return;
    if (skills.some((s) => s.toLowerCase() === term.toLowerCase() || termPresent(s, term))) return;
    flags.push(flag("term", line, severity, { term }, i));
  });
  return flags;
}

// ---- Documents ----

export function cvLines(doc: CvDocument): Array<{ line: CvLine; scope: LineScope }> {
  return [
    ...doc.summary.map((line) => ({ line, scope: { roleId: null } })),
    ...doc.roles.flatMap((role) => role.bullets.map((line) => ({ line, scope: { roleId: role.experienceId } }))),
  ];
}

/** Rough page count: ~520 words (English) or ~1,100 characters (Korean) per page, plus headings. */
export function estimatePages(doc: CvDocument, plainText: string): number {
  const units = doc.language === "ko" ? plainText.replace(/\s+/g, "").length / 1100 : plainText.split(/\s+/).filter(Boolean).length / 520;
  return Math.round((units + doc.roles.length * 0.04) * 10) / 10;
}

export function validateCv(doc: CvDocument, pctx: ProvenanceContext, plainText: string): { flags: CvFlag[]; pageEstimate: number } {
  const flags = cvLines(doc).flatMap(({ line, scope }) => checkLine(line, scope, pctx));
  const pageEstimate = estimatePages(doc, plainText);
  const [min, max] = doc.pages;
  if (pageEstimate > max + 0.25 || pageEstimate < min - 0.6) flags.push(flag("length", null, "warn", { pages: pageEstimate, min, max }));
  return { flags, pageEstimate };
}

export function linkedinLines(doc: LinkedinDocument): Array<{ line: CvLine; scope: LineScope }> {
  return [
    { line: doc.headline, scope: { roleId: null } },
    ...doc.about.map((line) => ({ line, scope: { roleId: null } })),
    ...doc.positions.flatMap((p) => p.bullets.map((line) => ({ line, scope: { roleId: p.experienceId } }))),
  ];
}

/** Text as pasted into LinkedIn: About paragraphs separated by blank lines, positions as "• " bullets. */
export function linkedinSectionText(doc: LinkedinDocument, section: "headline" | "about" | { experienceId: string }): string {
  if (section === "headline") return doc.headline.text.trim();
  if (section === "about") return doc.about.map((l) => l.text.trim()).filter(Boolean).join("\n\n");
  const position = doc.positions.find((p) => p.experienceId === section.experienceId);
  return (position?.bullets ?? []).map((l) => `• ${l.text.trim()}`).join("\n");
}

export function validateLinkedin(doc: LinkedinDocument, pctx: ProvenanceContext): CvFlag[] {
  const flags = linkedinLines(doc).flatMap(({ line, scope }) => checkLine(line, scope, pctx));
  const over = (section: string, length: number, limit: number, line: CvLine | null, experienceId = "") => {
    if (length > limit) flags.push({ ...flag("over_limit", line, "block", { section, length, limit, experienceId }), id: `over_limit:${section}:${experienceId}` });
  };
  over("headline", linkedinSectionText(doc, "headline").length, LINKEDIN_LIMITS.headline, doc.headline);
  over("about", linkedinSectionText(doc, "about").length, LINKEDIN_LIMITS.about, doc.about[0] ?? null);
  for (const p of doc.positions) over("position", linkedinSectionText(doc, { experienceId: p.experienceId }).length, LINKEDIN_LIMITS.position, p.bullets[0] ?? null, p.experienceId);
  return flags;
}
