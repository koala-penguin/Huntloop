/**
 * Does a job title fit the titles the user is looking for? Used by the search pre-filter and the
 * employer watchlist. Level and filler words ("Senior", "Head of", "Manager") never count on their
 * own; the distinctive words ("data", "frontend") must match, directly or through a small group of
 * words that name the same field ("analytics" for "data"). Edit the groups below to tune it; the
 * search run's "left out" list shows what the rule dropped.
 */

/** Words that say little about which role it is ("Senior … Engineer", "Head of …"). */
export const GENERIC_TITLE_WORDS = new Set(
  (
    "senior junior lead principal staff head chief mid intern graduate entry level sr jr ii iii iv engineer engineering developer development manager management " +
    "specialist analyst consultant officer associate assistant director coordinator architect administrator executive team " +
    "of and the for with in job jobs role vp vice president gm general leader"
  ).split(" "),
);

/** Words that name the same field. A distinctive target word matches any word in its group. */
export const TITLE_SYNONYMS: string[][] = [
  ["data", "analytics", "analytic", "analysis", "insights", "insight", "bi", "intelligence", "reporting"],
  ["ai", "ml", "machine", "genai", "llm", "artificial"],
  ["frontend", "web", "ui", "javascript", "react"],
  ["backend", "api"],
  ["fullstack", "full", "stack"],
  ["devops", "sre", "reliability", "infrastructure", "platform", "cloud"],
  ["product", "pm"],
  ["design", "designer", "ux"],
  ["security", "cyber", "infosec", "appsec"],
  ["marketing", "growth", "brand"],
];

/** Filler words left out when every target word is generic (the fallback compares the rest). */
const STOPWORDS = new Set(["and", "the", "of", "in", "for", "with", "job", "jobs", "role"]);

export const titleWords = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((w) => w.length > 1);

const groupOf = new Map<string, number>();
TITLE_SYNONYMS.forEach((group, i) => group.forEach((w) => groupOf.set(w, i)));

const related = (a: string, b: string) => a === b || (groupOf.has(a) && groupOf.get(a) === groupOf.get(b));

/** The target titles' distinctive words. */
export function distinctiveWords(targets: string[]): Set<string> {
  return new Set(targets.flatMap(titleWords).filter((w) => !GENERIC_TITLE_WORDS.has(w)));
}

/**
 * `match`: the title shares a distinctive word (or one from the same group) with a target title.
 * `overlap` (0–1): how much of the targets' distinctive vocabulary it covers, for ranking. When the
 * targets have no distinctive word ("Engineering Manager"), any shared non-filler word counts.
 */
export function titleMatch(title: string, targets: string[]): { match: boolean; overlap: number } {
  const lead = titleWords(title);
  const distinctive = distinctiveWords(targets);
  if (!distinctive.size) {
    const words = new Set(targets.flatMap(titleWords).filter((w) => !STOPWORDS.has(w)));
    if (!words.size) return { match: true, overlap: 0.5 };
    const own = new Set(lead);
    const hits = [...words].filter((w) => own.has(w)).length;
    return { match: hits > 0, overlap: hits / words.size };
  }
  // Count the target words the title covers, so two words from one group still count once.
  const covered = [...distinctive].filter((d) => lead.some((w) => related(w, d))).length;
  return { match: covered > 0, overlap: covered / distinctive.size };
}
