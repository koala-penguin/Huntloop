import type { AssessmentStatus, Tier } from "@/shared/schemas/job";
import type { Seniority } from "@/shared/schemas/profile";

/** Bump when weights, caps or thresholds change; stored with every score. */
export const RUBRIC_VERSION = 1;

/** Component weights (sum 100). Starting assumptions, to be calibrated against real outcomes. */
export const WEIGHTS = { mustHaves: 45, seniority: 20, relevance: 15, niceToHaves: 10, keywords: 10 } as const;

export const STATUS_CREDIT: Record<AssessmentStatus, number> = { met: 1, partial: 0.5, unknown: 0.25, unmet: 0 };

/** Used when a component has nothing to measure (e.g. a posting with no nice-to-haves). */
export const NEUTRAL = 0.6;

export const RELEVANCE_CREDIT = { same: 1, adjacent: 0.6, different: 0.2 } as const;

export const TIER_THRESHOLDS: Array<{ tier: Tier; min: number }> = [
  { tier: "strong", min: 75 },
  { tier: "good", min: 60 },
  { tier: "stretch", min: 45 },
  { tier: "long_shot", min: -Infinity },
];

export const TIER_ORDER: Tier[] = ["long_shot", "stretch", "good", "strong"];

export const ADJUSTMENT_CAP = 15;

export const POSTING_AGE = { fresh: 3, staleFrom: 8, oldFrom: 22, agingGateFrom: 45, deadGateFrom: 60 } as const;

export const SENIORITY_ORDINAL: Record<Seniority, number> = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  lead: 4,
  manager: 4,
  principal: 5,
  director: 6,
  executive: 7,
};

export function tierFromScore(score: number): Tier {
  return TIER_THRESHOLDS.find((t) => score >= t.min)!.tier;
}

export function lowerTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b;
}

export function tierRank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}
