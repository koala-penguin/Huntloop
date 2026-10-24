/**
 * How Huntloop may read a job page, by site. Sites without an API whose terms forbid automated
 * access are never fetched by the server: SEEK and LinkedIn open in the user's Huntloop browser
 * (search update), the rest ask for screenshots or pasted text.
 */
export type DomainMode = "api" | "fetch" | "browser" | "paste";

/**
 * One table for both consumers: `pattern` decides how the server may read a URL (wildcard TLDs, so
 * an unlisted country site is still refused), `domains` lists the hosts Claude's own web tools must
 * not fetch (tool allow/deny lists need literal domains).
 */
const SITES: Array<{ site: string; mode: DomainMode; pattern: RegExp; domains: string[] }> = [
  { site: "greenhouse", mode: "api", pattern: /(^|\.)(boards|job-boards)(\.eu)?\.greenhouse\.io$/, domains: [] },
  { site: "lever", mode: "api", pattern: /(^|\.)jobs(\.eu)?\.lever\.co$/, domains: [] },
  { site: "ashby", mode: "api", pattern: /(^|\.)jobs\.ashbyhq\.com$/, domains: [] },
  { site: "seek", mode: "browser", pattern: /(^|\.)seek\.com\.au$|(^|\.)seek\.co\.nz$/, domains: ["seek.com.au", "seek.co.nz"] },
  { site: "linkedin", mode: "browser", pattern: /(^|\.)linkedin\.com$/, domains: ["linkedin.com"] },
  {
    site: "indeed",
    mode: "paste",
    pattern: /(^|\.)indeed\.[a-z.]+$/,
    domains: ["indeed.com", "indeed.com.au", "indeed.co.nz", "indeed.com.sg", "indeed.co.uk", "indeed.ca", "indeed.co.in"],
  },
  {
    site: "glassdoor",
    mode: "paste",
    pattern: /(^|\.)glassdoor\.[a-z.]+$/,
    domains: ["glassdoor.com", "glassdoor.com.au", "glassdoor.co.uk", "glassdoor.ca", "glassdoor.co.in", "glassdoor.sg", "glassdoor.co.nz"],
  },
  { site: "jora", mode: "paste", pattern: /(^|\.)jora\.com$/, domains: ["jora.com"] },
  {
    site: "jobstreet",
    mode: "paste",
    pattern: /(^|\.)jobstreet\.[a-z.]+$/,
    domains: ["jobstreet.com", "jobstreet.com.my", "jobstreet.com.sg", "jobstreet.com.ph", "jobstreet.co.id"],
  },
  { site: "jobsdb", mode: "paste", pattern: /(^|\.)jobsdb\.com$/, domains: ["jobsdb.com"] },
  { site: "ziprecruiter", mode: "paste", pattern: /(^|\.)ziprecruiter\.[a-z.]+$/, domains: ["ziprecruiter.com", "ziprecruiter.co.uk", "ziprecruiter.ca"] },
  { site: "wellfound", mode: "paste", pattern: /(^|\.)wellfound\.com$/, domains: ["wellfound.com"] },
  { site: "monster", mode: "paste", pattern: /(^|\.)monster\.[a-z.]+$/, domains: ["monster.com", "monster.co.uk", "monster.ca", "monster.com.sg"] },
];

export function domainPolicy(url: URL): { mode: DomainMode; site: string | null } {
  const host = url.hostname.toLowerCase();
  const rule = SITES.find((r) => r.pattern.test(host));
  return rule ? { mode: rule.mode, site: rule.site } : { mode: "fetch", site: null };
}

/** Domains that must never be fetched by Claude's web_fetch either. */
export function restrictedDomains(): string[] {
  return [...new Set(SITES.filter((s) => s.mode !== "api" && s.mode !== "fetch").flatMap((s) => s.domains))];
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
