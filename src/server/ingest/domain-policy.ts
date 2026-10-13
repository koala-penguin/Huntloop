/**
 * How Huntloop may read a job page, by site. Sites without an API whose terms forbid automated
 * access are never fetched by the server: SEEK and LinkedIn open in the user's Huntloop browser
 * (search update), the rest ask for screenshots or pasted text.
 */
export type DomainMode = "api" | "fetch" | "browser" | "paste";

const RULES: Array<{ pattern: RegExp; mode: DomainMode; site: string }> = [
  { pattern: /(^|\.)(boards|job-boards)(\.eu)?\.greenhouse\.io$/, mode: "api", site: "greenhouse" },
  { pattern: /(^|\.)jobs(\.eu)?\.lever\.co$/, mode: "api", site: "lever" },
  { pattern: /(^|\.)jobs\.ashbyhq\.com$/, mode: "api", site: "ashby" },
  { pattern: /(^|\.)seek\.com\.au$|(^|\.)seek\.co\.nz$/, mode: "browser", site: "seek" },
  { pattern: /(^|\.)linkedin\.com$/, mode: "browser", site: "linkedin" },
  { pattern: /(^|\.)indeed\.[a-z.]+$/, mode: "paste", site: "indeed" },
  { pattern: /(^|\.)glassdoor\.[a-z.]+$/, mode: "paste", site: "glassdoor" },
  { pattern: /(^|\.)jora\.com$/, mode: "paste", site: "jora" },
  { pattern: /(^|\.)jobstreet\.[a-z.]+$/, mode: "paste", site: "jobstreet" },
  { pattern: /(^|\.)jobsdb\.com$/, mode: "paste", site: "jobsdb" },
  { pattern: /(^|\.)ziprecruiter\.[a-z.]+$/, mode: "paste", site: "ziprecruiter" },
  { pattern: /(^|\.)wellfound\.com$/, mode: "paste", site: "wellfound" },
  { pattern: /(^|\.)monster\.[a-z.]+$/, mode: "paste", site: "monster" },
];

export function domainPolicy(url: URL): { mode: DomainMode; site: string | null } {
  const host = url.hostname.toLowerCase();
  const rule = RULES.find((r) => r.pattern.test(host));
  return rule ? { mode: rule.mode, site: rule.site } : { mode: "fetch", site: null };
}

/** Domains that must never be fetched by Claude's web_fetch either. */
export function restrictedDomains(): string[] {
  return ["seek.com.au", "seek.co.nz", "linkedin.com", "indeed.com", "glassdoor.com", "jora.com", "jobstreet.com", "ziprecruiter.com", "wellfound.com"];
}

/** Strips tracking parameters so the same job is recognised again. */
export function canonicalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid|fbclid|ref|refid|trk|src|source|mc_|_hs)/i.test(key)) url.searchParams.delete(key);
    }
    // LinkedIn: /jobs/collections/...?currentJobId=123 → /jobs/view/123
    const current = url.searchParams.get("currentJobId");
    if (/linkedin\.com$/.test(url.hostname) && current) return `https://www.linkedin.com/jobs/view/${current}`;
    return url.toString();
  } catch {
    return null;
  }
}
