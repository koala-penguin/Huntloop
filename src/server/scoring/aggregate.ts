import type {
  Assessment,
  AssessmentStatus,
  Eligibility,
  GateResult,
  PostingAnalysis,
  Requirement,
  ScoreResult,
  ScoredItem,
  Tier,
} from "@/shared/schemas/job";
import type { ProfileData } from "@/shared/schemas/profile";
import type { Preferences } from "@/shared/schemas/preferences";
import { experienceYears } from "@/shared/experience";
import { buildQuoteIndex, quoteFound } from "./quotes";
import { computeGates } from "./gates";
import {
  ADJUSTMENT_CAP,
  NEUTRAL,
  POSTING_AGE,
  RELEVANCE_CREDIT,
  RUBRIC_VERSION,
  SENIORITY_ORDINAL,
  STATUS_CREDIT,
  WEIGHTS,
  lowerTier,
  tierFromScore,
  tierRank,
} from "./rubric";

export interface ScoreInput {
  analysis: PostingAnalysis;
  assessment: Assessment;
  profile: { cvText: string; data: ProfileData };
  preferences: Preferences;
  job: { country: string | null; city: string | null; postedAt: Date | null; descriptionIsFull: boolean };
  answers: Record<string, "yes" | "no">;
  now?: Date;
}

const average = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : NEUTRAL);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Applies evidence verification, years-in-code and the user's answers to every assessed requirement. */
export function resolveItems(input: ScoreInput, now: Date): { items: ScoredItem[]; candidateYears: number } {
  const { analysis, assessment, profile, answers } = input;
  const cvIndex = buildQuoteIndex(profile.cvText, ...profile.data.experience.flatMap((e) => e.highlights));
  const factIndex = buildQuoteIndex(...profile.data.facts.map((f) => f.text));
  const candidateYears = experienceYears(profile.data.experience, now);
  const byId = new Map(assessment.items.map((i) => [i.requirementId, i]));

  const items = analysis.requirements.map((req): ScoredItem => {
    const item = byId.get(req.id);
    if (!item) return { requirementId: req.id, status: "unknown", verifiedEvidence: [], droppedEvidence: 0, overridden: false };
    const verified = item.evidence.filter((e) => quoteFound(e.quote, e.source === "fact" ? factIndex : cvIndex));
    let status: AssessmentStatus = item.status;
    if ((status === "met" || status === "partial") && verified.length === 0) status = "unknown";

    // Years requirements are decided by arithmetic on dated roles, not by the model.
    if (req.category === "years" && req.minYears !== null) {
      const roles = item.experienceIds.length ? profile.data.experience.filter((e) => item.experienceIds.includes(e.id)) : profile.data.experience;
      const years = experienceYears(roles, now);
      status = years >= req.minYears ? "met" : years >= req.minYears - 1 ? "partial" : "unmet";
    }

    const answer = answers[req.id];
    if (answer) status = answer === "yes" ? "met" : "unmet";
    return {
      requirementId: req.id,
      status,
      verifiedEvidence: verified.map((e) => ({ source: e.source, quote: e.quote })),
      droppedEvidence: item.evidence.length - verified.length,
      overridden: !!answer,
    };
  });
  return { items, candidateYears };
}

function candidateSeniorityOrdinal(input: ScoreInput): number | null {
  if (input.assessment.candidateSeniority) return SENIORITY_ORDINAL[input.assessment.candidateSeniority];
  const recent = input.profile.data.experience.find((e) => e.seniority);
  return recent?.seniority ? SENIORITY_ORDINAL[recent.seniority] : null;
}

interface CoreResult {
  base: number;
  components: ScoreResult["components"];
  caps: ScoreResult["capsApplied"];
}

function core(input: ScoreInput, items: ScoredItem[], candidateYears: number): CoreResult {
  const statusOf = (r: Requirement) => items.find((i) => i.requirementId === r.id)?.status ?? "unknown";
  const musts = input.analysis.requirements.filter((r) => r.kind === "must");
  const nices = input.analysis.requirements.filter((r) => r.kind === "nice");
  const caps: ScoreResult["capsApplied"] = [];

  const mustHaves = musts.length ? average(musts.map((r) => STATUS_CREDIT[statusOf(r)])) : average(nices.map((r) => STATUS_CREDIT[statusOf(r)]));
  const niceToHaves = average(nices.map((r) => STATUS_CREDIT[statusOf(r)]));

  // Seniority and years.
  let seniority = 0.7;
  const jobLevel = input.analysis.seniority ? SENIORITY_ORDINAL[input.analysis.seniority] : null;
  const candidateLevel = candidateSeniorityOrdinal(input);
  let seniorityGap = 0;
  if (jobLevel !== null && candidateLevel !== null) {
    seniorityGap = jobLevel - candidateLevel;
    seniority = seniorityGap === 0 ? 1 : seniorityGap === -1 ? 0.8 : seniorityGap === 1 ? 0.6 : 0.2;
  }
  const minYears = Math.max(0, ...musts.concat(input.analysis.requirements.filter((r) => r.kind === "gate")).filter((r) => r.minYears !== null).map((r) => r.minYears!));
  const shortfall = minYears - candidateYears;
  if (shortfall > 2) seniority = Math.min(seniority, 0.4);
  else if (shortfall > 1) seniority = Math.min(seniority, 0.7);

  const relevance = (RELEVANCE_CREDIT[input.assessment.titleRelevance] + RELEVANCE_CREDIT[input.assessment.industryRelevance]) / 2;

  // Exact keywords already on the CV — the part a tailored CV can fix.
  const keywordReqs = input.analysis.requirements.filter((r) => ["skill", "certification", "title"].includes(r.category) && r.normalized.trim().length > 1);
  const cv = input.profile.cvText;
  const keywords = keywordReqs.length
    ? keywordReqs.filter((r) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(r.normalized.trim())}(?![\\p{L}\\p{N}])`, "iu").test(cv)).length / keywordReqs.length
    : NEUTRAL;

  const unmetMusts = musts.filter((r) => statusOf(r) === "unmet").length;
  if (unmetMusts >= 2) caps.push({ reasonKey: "two_unmet_musts", maxTier: "stretch" });
  else if (unmetMusts === 1) caps.push({ reasonKey: "unmet_must", maxTier: "good" });
  if (shortfall > 2) caps.push({ reasonKey: "years_short", maxTier: "stretch" });
  if (Math.abs(seniorityGap) >= 2) caps.push({ reasonKey: "seniority_gap", maxTier: "stretch" });

  const components = { mustHaves, seniority, relevance, niceToHaves, keywords };
  const base =
    WEIGHTS.mustHaves * mustHaves +
    WEIGHTS.seniority * seniority +
    WEIGHTS.relevance * relevance +
    WEIGHTS.niceToHaves * niceToHaves +
    WEIGHTS.keywords * keywords;
  return { base, components, caps };
}

function adjustments(input: ScoreInput, now: Date): ScoreResult["adjustments"] {
  const out: ScoreResult["adjustments"] = [];
  const { analysis, job, profile, preferences } = input;
  if (job.postedAt) {
    const age = Math.floor((now.getTime() - job.postedAt.getTime()) / 86_400_000);
    if (age <= POSTING_AGE.fresh) out.push({ kind: "fresh", points: 5 });
    else if (age >= POSTING_AGE.oldFrom) out.push({ kind: "old", points: -8 });
    else if (age >= POSTING_AGE.staleFrom) out.push({ kind: "stale", points: -3 });
  }
  if (analysis.workplace === "remote" && /anywhere|worldwide|global|any location/i.test(analysis.remoteScope ?? "")) {
    out.push({ kind: "remote_anywhere", points: -3 });
  }
  const right = job.country ? profile.data.workRights.find((w) => w.country === job.country) : undefined;
  if (right?.status === "needs_sponsorship" && analysis.sponsorship === "unknown") out.push({ kind: "sponsorship_unknown", points: -10 });
  if (job.country && job.city && analysis.workplace !== "remote") {
    const market = preferences.markets.find((m) => m.country === job.country);
    const city = job.city.toLowerCase();
    if (market && market.cities.length && !market.cities.some((c) => city.includes(c.toLowerCase()) || c.toLowerCase().includes(city))) {
      out.push({ kind: "relocation", points: -5 });
    }
  }
  return out;
}

function tierWithCaps(score: number, caps: ScoreResult["capsApplied"]): Tier {
  return caps.reduce<Tier>((tier, cap) => lowerTier(tier, cap.maxTier), tierFromScore(score));
}

/** Interview Chance for one job: gates, components, adjustments, caps, tier — all arithmetic in code. */
export function scoreJob(input: ScoreInput): ScoreResult {
  const now = input.now ?? new Date();
  const { items, candidateYears } = resolveItems(input, now);
  const statusOf = (id: string) => items.find((i) => i.requirementId === id)?.status;
  const gates: GateResult[] = computeGates({
    analysis: input.analysis,
    profile: input.profile.data,
    preferences: input.preferences,
    country: input.job.country,
    postedAt: input.job.postedAt,
    now,
    statusOf,
  });
  const eligibility: Eligibility = gates.some((g) => g.status === "fail") ? "ineligible" : gates.some((g) => g.status === "unclear") ? "verify" : "eligible";

  const { base, components, caps } = core(input, items, candidateYears);
  const adj = adjustments(input, now);
  const adjTotal = Math.max(-ADJUSTMENT_CAP, Math.min(ADJUSTMENT_CAP, adj.reduce((s, a) => s + a.points, 0)));
  const score = Math.round(Math.max(0, Math.min(100, base + adjTotal)));
  const tier = tierWithCaps(score, caps);

  const assessed = input.analysis.requirements.filter((r) => r.kind !== "gate");
  const unknownShare = assessed.length ? assessed.filter((r) => statusOf(r.id) === "unknown").length / assessed.length : 0;
  const confidence = !input.job.descriptionIsFull ? "low" : unknownShare < 0.15 ? "high" : unknownShare < 0.35 ? "medium" : "low";

  // Counterfactuals: which single requirement, if met, would lift the tier?
  const whatWouldChange: ScoreResult["whatWouldChange"] = [];
  for (const req of assessed) {
    const current = statusOf(req.id);
    if (current === "met") continue;
    const flipped = items.map((i) => (i.requirementId === req.id ? { ...i, status: "met" as const } : i));
    const alt = core(input, flipped, candidateYears);
    const altScore = Math.round(Math.max(0, Math.min(100, alt.base + adjTotal)));
    const altTier = tierWithCaps(altScore, alt.caps);
    if (tierRank(altTier) > tierRank(tier)) whatWouldChange.push({ requirementId: req.id, newTier: altTier });
  }

  return {
    rubricVersion: RUBRIC_VERSION,
    eligibility,
    gates,
    items,
    components,
    base: Math.round(base * 10) / 10,
    adjustments: adj,
    capsApplied: caps,
    score,
    tier,
    confidence,
    unknownShare: Math.round(unknownShare * 100) / 100,
    candidateYears,
    whatWouldChange: whatWouldChange.slice(0, 5),
  };
}
