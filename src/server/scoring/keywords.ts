import type { KeywordCoverage } from "@/shared/schemas/cv";
import type { PostingAnalysis, Requirement } from "@/shared/schemas/job";

/**
 * Exact posting keywords (skills, certifications, titles) found in a text. Interview Chance uses it
 * on the CV text; CV tailoring compares the CV before and after (ATS keyword match).
 */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function keywordRequirements(analysis: Pick<PostingAnalysis, "requirements">): Requirement[] {
  return analysis.requirements.filter((r) => ["skill", "certification", "title"].includes(r.category) && r.normalized.trim().length > 1);
}

/** Whole-word, case-insensitive match (Unicode-aware, so "C++" and Korean terms work). */
export function termPresent(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(t)}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

export function keywordCoverage(analysis: Pick<PostingAnalysis, "requirements">, text: string): KeywordCoverage {
  const reqs = keywordRequirements(analysis);
  const present: string[] = [];
  const missing: string[] = [];
  for (const r of reqs) (termPresent(text, r.normalized) ? present : missing).push(r.normalized.trim());
  return { present, missing, share: reqs.length ? present.length / reqs.length : null };
}
