import type { KeywordCoverage } from "@/shared/schemas/cv";
import type { PostingAnalysis, Requirement } from "@/shared/schemas/job";

/**
 * Posting keywords (tools, methods, certifications, domains, titles) found in a text — what an
 * applicant-tracking system scans for. Interview Chance uses it on the CV text; CV tailoring
 * compares the CV before and after (ATS keyword match).
 */

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Requirements whose label is itself a keyword (analyses made before requirements carried keywords). */
export function keywordRequirements(analysis: Pick<PostingAnalysis, "requirements">): Requirement[] {
  return analysis.requirements.filter((r) => ["skill", "certification", "title"].includes(r.category) && r.normalized.trim().length > 1);
}

/** The distinct ATS terms of a posting: each requirement's keywords (gates aside), or the legacy labels. */
export function postingKeywords(analysis: Pick<PostingAnalysis, "requirements">): string[] {
  const withKeywords = analysis.requirements.some((r) => Array.isArray(r.keywords));
  const terms = withKeywords
    ? analysis.requirements.filter((r) => r.kind !== "gate").flatMap((r) => r.keywords ?? [])
    : keywordRequirements(analysis).map((r) => r.normalized);
  const seen = new Map<string, string>();
  for (const raw of terms) {
    const term = raw.trim();
    const key = term.toLowerCase().replace(/[\s-]+/g, "");
    if (term.length > 1 && !seen.has(key)) seen.set(key, term);
  }
  return [...seen.values()];
}

/**
 * Whole-word, case-insensitive match (Unicode-aware, so "C++" and Korean terms work). Words may be
 * joined by a space or a hyphen, a closed compound also matches its spaced form ("cybersecurity" ≈
 * "cyber security"), and a trailing plural "s" is optional.
 */
export function termPresent(text: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const words = t.split(/[\s-]+/).map(escapeRegex);
  let body = words.join("[\\s-]+");
  // "cybersecurity" → also "cyber security" / "cyber-security" (any split point).
  if (words.length === 1 && /^\p{L}{6,}$/u.test(t)) {
    const splits = [];
    for (let i = 3; i <= t.length - 3; i++) splits.push(`${escapeRegex(t.slice(0, i))}[\\s-]${escapeRegex(t.slice(i))}`);
    body = `(?:${[body, ...splits].join("|")})`;
  }
  const plural = /\p{L}$/u.test(t) && !/s$/i.test(t) ? "s?" : "";
  return new RegExp(`(^|[^\\p{L}\\p{N}])${body}${plural}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

export function keywordCoverage(analysis: Pick<PostingAnalysis, "requirements">, text: string): KeywordCoverage {
  const terms = postingKeywords(analysis);
  const present: string[] = [];
  const missing: string[] = [];
  for (const term of terms) (termPresent(text, term) ? present : missing).push(term);
  return { present, missing, share: terms.length ? present.length / terms.length : null };
}
