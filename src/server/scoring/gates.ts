import type { AssessmentStatus, GateResult, PostingAnalysis, Requirement } from "@/shared/schemas/job";
import type { ProfileData } from "@/shared/schemas/profile";
import type { Preferences } from "@/shared/schemas/preferences";
import { marketPack } from "@/shared/markets";
import { POSTING_AGE } from "./rubric";

export interface GateInput {
  analysis: PostingAnalysis;
  profile: ProfileData;
  preferences: Preferences;
  country: string | null;
  postedAt: Date | null;
  now: Date;
  /** Final status per requirement id (after evidence checks and the user's answers). */
  statusOf: (requirementId: string) => AssessmentStatus | undefined;
}

/** Countries whose security clearances generally require citizenship. */
const CLEARANCE_NEEDS_CITIZENSHIP = new Set(["AU", "NZ", "US", "GB", "CA"]);

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function workRightsGates(input: GateInput): GateResult[] {
  const { analysis, profile, country } = input;
  const gates = analysis.requirements.filter((r) => ["citizenship", "pr", "no_sponsorship"].includes(r.gate));
  const sponsorshipRefused = analysis.sponsorship === "not_offered";
  if (!country) {
    return gates.length || sponsorshipRefused
      ? [{ kind: "work_rights", status: "unclear", postingQuote: gates[0]?.postingQuote ?? analysis.sponsorshipQuote, reasonKey: "country_unknown" }]
      : [];
  }
  const right = profile.workRights.find((w) => w.country === country);
  const status = right?.status ?? "unknown";
  const results: GateResult[] = [];

  for (const req of gates) {
    if (req.gate === "citizenship") {
      results.push({
        kind: "citizenship",
        status: status === "citizen" ? "pass" : status === "unknown" ? "unclear" : "fail",
        postingQuote: req.postingQuote,
        reasonKey: status === "citizen" ? "citizen_ok" : status === "unknown" ? "work_rights_unknown" : "citizenship_required",
        params: { country },
        requirementId: req.id,
      });
    } else if (req.gate === "pr") {
      const ok = status === "citizen" || status === "permanent_resident";
      results.push({
        kind: "work_rights",
        status: ok ? "pass" : status === "unknown" ? "unclear" : "fail",
        postingQuote: req.postingQuote,
        reasonKey: ok ? "pr_ok" : status === "unknown" ? "work_rights_unknown" : "pr_required",
        params: { country },
        requirementId: req.id,
      });
    }
  }

  const noSponsorship = gates.find((r) => r.gate === "no_sponsorship");
  if (noSponsorship || sponsorshipRefused) {
    const quote = noSponsorship?.postingQuote ?? analysis.sponsorshipQuote;
    results.push({
      kind: "work_rights",
      status: status === "needs_sponsorship" ? "fail" : status === "unknown" ? "unclear" : status === "restricted_visa" ? "unclear" : "pass",
      postingQuote: quote ?? null,
      reasonKey:
        status === "needs_sponsorship" ? "sponsorship_needed" : status === "unknown" ? "work_rights_unknown" : status === "restricted_visa" ? "restricted_visa" : "rights_ok",
      params: { country },
      requirementId: noSponsorship?.id,
    });
  }

  if (results.length === 0) {
    // No explicit rule in the posting: the employer still has to be able to hire you.
    if (status === "unknown") {
      results.push({ kind: "work_rights", status: "unclear", postingQuote: null, reasonKey: "work_rights_unknown", params: { country } });
    } else if (status === "restricted_visa" && ["full_time", "unknown"].includes(analysis.employmentType)) {
      results.push({ kind: "work_rights", status: "unclear", postingQuote: null, reasonKey: "restricted_visa", params: { country } });
    } else {
      results.push({ kind: "work_rights", status: "pass", postingQuote: null, reasonKey: status === "needs_sponsorship" ? "sponsorship_unstated" : "rights_ok", params: { country } });
    }
  }
  return results;
}

function clearanceGates(input: GateInput): GateResult[] {
  const { analysis, profile, country } = input;
  return analysis.requirements
    .filter((r) => r.gate === "clearance")
    .map((req): GateResult => {
      const pack = marketPack(country);
      const text = `${req.normalized} ${req.postingQuote}`.toLowerCase();
      const requiredIndex = pack.clearanceLevels.reduce((found, level, i) => (text.includes(level.toLowerCase()) ? i : found), -1);
      const held = profile.clearances.filter((c) => c.country === country && c.status === "active");
      const heldIndex = held.reduce((best, c) => Math.max(best, pack.clearanceLevels.findIndex((l) => l.toLowerCase() === c.level.toLowerCase())), -1);
      if (held.length && (requiredIndex < 0 || heldIndex >= requiredIndex)) {
        return { kind: "clearance", status: "pass", postingQuote: req.postingQuote, reasonKey: "clearance_held", requirementId: req.id };
      }
      const citizen = profile.workRights.find((w) => w.country === country)?.status === "citizen";
      if (citizen || !country || !CLEARANCE_NEEDS_CITIZENSHIP.has(country)) {
        return { kind: "clearance", status: "unclear", postingQuote: req.postingQuote, reasonKey: "clearance_obtainable", requirementId: req.id };
      }
      return { kind: "clearance", status: "fail", postingQuote: req.postingQuote, reasonKey: "clearance_needs_citizenship", params: { country }, requirementId: req.id };
    });
}

function statusGate(req: Requirement, kind: "license" | "language", status: AssessmentStatus | undefined): GateResult {
  const s = status === "met" ? "pass" : status === "unmet" ? "fail" : "unclear";
  return { kind, status: s, postingQuote: req.postingQuote, reasonKey: `${kind}_${s}`, requirementId: req.id };
}

function locationGates(input: GateInput): GateResult[] {
  const { analysis, preferences, country } = input;
  if (!country || analysis.workplace === "remote") return [];
  const listed = preferences.markets.some((m) => m.country === country);
  if (listed || preferences.willingToRelocate) return [];
  return [{ kind: "location", status: "unclear", postingQuote: analysis.locationText, reasonKey: "outside_markets", params: { country } }];
}

function staleGate(input: GateInput): GateResult[] {
  if (!input.postedAt) return [];
  const age = daysBetween(input.postedAt, input.now);
  if (age >= POSTING_AGE.deadGateFrom) return [{ kind: "stale", status: "fail", postingQuote: null, reasonKey: "stale", params: { days: age } }];
  if (age >= POSTING_AGE.agingGateFrom) return [{ kind: "stale", status: "unclear", postingQuote: null, reasonKey: "aging", params: { days: age } }];
  return [];
}

/** Knockout checks: anything that stops an employer from interviewing you regardless of fit. */
export function computeGates(input: GateInput): GateResult[] {
  const licenseAndLanguage = input.analysis.requirements
    .filter((r) => r.gate === "license" || r.gate === "language")
    .map((r) => statusGate(r, r.gate as "license" | "language", input.statusOf(r.id)));
  return [...workRightsGates(input), ...clearanceGates(input), ...licenseAndLanguage, ...locationGates(input), ...staleGate(input)];
}
