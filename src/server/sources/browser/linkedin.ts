import type { SearchFilters } from "@/shared/schemas/search";
import { countryName } from "@/shared/countries";
import { capturePage, siteOrigin, type SiteAdapter, type SiteQuery } from "./common";
import { detectBlock } from "../../browser/challenge";

/**
 * LinkedIn jobs. Guest mode by default (public job search and /jobs/view/{id} pages, so no account
 * is involved). With "use my LinkedIn login", the user signs in by hand in the browser window first;
 * Huntloop never sees credentials.
 */
const ORIGIN = "https://www.linkedin.com";
const WORKPLACE: Record<string, string> = { onsite: "1", remote: "2", hybrid: "3" };
const JOB_TYPE: Record<string, string> = { full_time: "F", part_time: "P", contract: "C", casual: "T", internship: "I" };

export function linkedinTimeRange(days: number | null): string | null {
  if (!days) return null;
  return days <= 1 ? "r86400" : days <= 7 ? "r604800" : "r2592000";
}

export function linkedinSearchUrl(filters: SearchFilters, location: { country: string; city: string | null } | null, title: string, pageIndex: number): string {
  const url = new URL("/jobs/search", siteOrigin("linkedin", ORIGIN));
  url.searchParams.set("keywords", [title, ...filters.keywords.slice(0, 2)].filter(Boolean).join(" "));
  if (location) url.searchParams.set("location", [location.city, countryName(location.country, "en")].filter(Boolean).join(", "));
  const range = linkedinTimeRange(filters.postedWithinDays);
  if (range) url.searchParams.set("f_TPR", range);
  const workplace = filters.workplace.map((w) => WORKPLACE[w]).filter(Boolean);
  if (workplace.length && workplace.length < 3) url.searchParams.set("f_WT", workplace.join(","));
  const types = filters.employmentTypes.map((t) => JOB_TYPE[t]).filter(Boolean);
  if (types.length) url.searchParams.set("f_JT", types.join(","));
  url.searchParams.set("sortBy", "DD");
  if (pageIndex > 0) url.searchParams.set("start", String(pageIndex * 25));
  return url.toString();
}

export function createLinkedinAdapter(options: { useLogin: boolean }): SiteAdapter {
  return {
    site: "linkedin",
    queries(filters) {
      const locations = filters.locations.length ? filters.locations.slice(0, 3) : [null];
      const titles = filters.titles.length ? filters.titles.slice(0, 2) : [filters.keywords.slice(0, 3).join(" ")].filter(Boolean);
      const out: SiteQuery[] = [];
      for (const location of locations) for (const title of titles) out.push({ pageUrl: (i) => linkedinSearchUrl(filters, location, title, i) });
      return out;
    },
    jobIdFromUrl(url) {
      return /^\/jobs\/view\/(?:[^/?#]*?-)?(\d+)\/?$/.exec(url.pathname)?.[1] ?? null;
    },
    jobUrl(id) {
      return { canonical: `${ORIGIN}/jobs/view/${id}`, open: `${siteOrigin("linkedin", ORIGIN)}/jobs/view/${id}` };
    },
    country() {
      return null;
    },
    async prepare(page, ctx) {
      if (!options.useLogin) return true;
      // Signed in already? Otherwise the user signs in by hand in the window, then we check again.
      const feed = `${siteOrigin("linkedin", ORIGIN)}/feed/`;
      await page.goto(feed, { waitUntil: "domcontentloaded", timeout: 45_000 });
      if (!(await detectBlock(page))) return true;
      if (!ctx.waitForUser) return false;
      const answer = await ctx.waitForUser({ kind: "login", site: "linkedin", url: page.url() }, async () => !(await detectBlock(page)));
      if (answer === "skipped") return false;
      await page.goto(feed, { waitUntil: "domcontentloaded", timeout: 45_000 });
      return !(await detectBlock(page));
    },
    capture(page) {
      return capturePage(page, {
        title: ["h1.top-card-layout__title", ".job-details-jobs-unified-top-card__job-title", "h1"],
        company: [".topcard__org-name-link", ".job-details-jobs-unified-top-card__company-name"],
        location: [".topcard__flavor--bullet", ".job-details-jobs-unified-top-card__primary-description-container"],
        body: [".show-more-less-html__markup", ".description__text", ".jobs-description__content", "main"],
      });
    },
  };
}
