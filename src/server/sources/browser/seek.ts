import type { Page } from "playwright-core";
import type { SearchFilters } from "@/shared/schemas/search";
import { capturePage, siteOrigin, type SiteAdapter, type SiteQuery } from "./common";

/**
 * SEEK (seek.com.au, seek.co.nz). No public search API, so Huntloop reads it in the user's browser
 * window: search pages → /job/{id} links → job pages.
 */
const ORIGINS: Record<string, string> = { AU: "https://www.seek.com.au", NZ: "https://www.seek.co.nz" };
const WORKTYPE: Record<string, string> = { full_time: "242", part_time: "243", contract: "244", casual: "245" };
const AREA: Record<string, string> = { AU: "All Australia", NZ: "All New Zealand" };

/** SEEK's date filter accepts 1, 3, 7, 14 or 31 days. */
export function seekDateRange(days: number | null): string | null {
  if (!days) return null;
  return String([1, 3, 7, 14, 31].find((d) => d >= days) ?? 31);
}

export function seekSearchUrl(filters: SearchFilters, location: { country: string; city: string | null }, title: string, pageIndex: number): string {
  const origin = siteOrigin("seek", ORIGINS[location.country] ?? ORIGINS.AU);
  const url = new URL("/jobs", origin);
  url.searchParams.set("keywords", [title, ...filters.keywords.slice(0, 2)].filter(Boolean).join(" "));
  url.searchParams.set("where", location.city ?? AREA[location.country] ?? "All Australia");
  const range = seekDateRange(filters.postedWithinDays);
  if (range) url.searchParams.set("daterange", range);
  const types = filters.employmentTypes.map((t) => WORKTYPE[t]).filter(Boolean);
  if (types.length) url.searchParams.set("worktype", types.join(","));
  if (filters.salaryMin) {
    url.searchParams.set("salaryrange", `${Math.round(filters.salaryMin)}-`);
    url.searchParams.set("salarytype", "annual");
  }
  url.searchParams.set("sortmode", "ListedDate");
  if (pageIndex > 0) url.searchParams.set("page", String(pageIndex + 1));
  return url.toString();
}

/**
 * SEEK masks phone numbers and emails for logged-out visitors ("18•• ••• 696") but keeps the full
 * value in the link's attributes. Puts the full value back as the link text before the page is read.
 */
export async function unmaskSeekContacts(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0;
    for (const el of Array.from(document.querySelectorAll('[data-contact-match-masked="true"]'))) {
      let value = el.getAttribute("data-contact-match")?.trim() ?? "";
      if (!value) {
        const href = el.getAttribute("href") ?? "";
        const match = /^(?:tel|mailto):([^?#]*)/i.exec(href.trim());
        if (match) {
          try {
            value = decodeURIComponent(match[1]).trim();
          } catch {
            value = match[1].trim();
          }
        }
      }
      if (!value) continue;
      el.textContent = value;
      count++;
    }
    return count;
  });
}

const countryOf = (url: URL) => (/\.co\.nz$/.test(url.hostname) ? "NZ" : /seek\.com\.au$/.test(url.hostname) ? "AU" : null);

export const seekAdapter: SiteAdapter = {
  site: "seek",
  queries(filters) {
    const locations = filters.locations.filter((l) => ORIGINS[l.country]);
    const titles = filters.titles.length ? filters.titles.slice(0, 2) : [filters.keywords.slice(0, 3).join(" ")].filter(Boolean);
    const out: SiteQuery[] = [];
    for (const location of locations.slice(0, 3)) for (const title of titles) out.push({ pageUrl: (i) => seekSearchUrl(filters, location, title, i) });
    return out;
  },
  jobIdFromUrl(url) {
    return /^\/job\/(\d+)(?:[/?#]|$)/.exec(url.pathname)?.[1] ?? null;
  },
  jobUrl(id, from) {
    const real = countryOf(from) === "NZ" ? ORIGINS.NZ : ORIGINS.AU;
    return { canonical: `${real}/job/${id}`, open: `${siteOrigin("seek", real)}/job/${id}` };
  },
  country(from) {
    return countryOf(from) ?? (process.env.HUNTLOOP_SEEK_BASE_URL ? "AU" : null);
  },
  async capture(page) {
    // Reading the page still works if this fails; the contacts just stay masked.
    await unmaskSeekContacts(page).catch(() => 0);
    return capturePage(page, {
      title: ['[data-automation="job-detail-title"]', "h1"],
      company: ['[data-automation="advertiser-name"]'],
      location: ['[data-automation="job-detail-location"]'],
      salary: ['[data-automation="job-detail-salary"]'],
      body: ['[data-automation="jobAdDetails"]', "main"],
    });
  },
};
