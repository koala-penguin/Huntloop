import type { Page } from "playwright-core";
import type { SearchFilters } from "@/shared/schemas/search";
import type { BrowserSite } from "@/shared/source-settings";
import type { TaskContext } from "../../tasks/runner";
import { TaskCancelledError } from "../../tasks/runner";
import { detectBlock } from "../../browser/challenge";
import { pause } from "../../browser/pacing";
import { withBrowserPage } from "../../browser/service";
import { extractFromHtml, htmlToText, type PostingHints } from "../../ingest/html";
import type { JobLead } from "../types";

export interface BrowserRunContext {
  signal?: AbortSignal;
  /** Job pages to open at most (per site, per run). */
  maxPages: number;
  waitForUser?: TaskContext["waitForUser"];
  note?: (text: string) => void;
  /** Filled in by a run: results pages loaded, job links found, whether a wall stopped it. */
  stats?: { resultPages: number; jobLinks: number; blocked: boolean };
}

export interface SiteQuery {
  /** Results page URL for a 0-based page index. */
  pageUrl: (index: number) => string;
}

export interface CapturedPage {
  text: string;
  hints: PostingHints;
}

export interface SiteAdapter {
  site: BrowserSite;
  /** Search queries for these filters (empty when the site doesn't cover the filters' places). */
  queries(filters: SearchFilters): SiteQuery[];
  /** Job id from a link on a results page, or null if it isn't a job link of this site. */
  jobIdFromUrl(url: URL): string | null;
  /** The public URL of a job (stored and shown), and the URL actually opened (differs only in tests). */
  jobUrl(id: string, from: URL): { canonical: string; open: string };
  /** Reads the job page that is open. */
  capture(page: Page): Promise<CapturedPage>;
  /** Runs before searching (e.g. wait for the user to sign in). Return false to skip the site. */
  prepare?(page: Page, ctx: BrowserRunContext): Promise<boolean>;
  country(from: URL): string | null;
}

const MAX_RESULT_PAGES = 5;

/** Test seam: serve a site from a local fixture server instead of the real one. */
export function siteOrigin(site: BrowserSite, real: string): string {
  const override = site === "seek" ? process.env.HUNTLOOP_SEEK_BASE_URL : process.env.HUNTLOOP_LINKEDIN_BASE_URL;
  return override ? override.replace(/\/+$/, "") : real;
}

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new TaskCancelledError();
}

/**
 * If the page shows a CAPTCHA, sign-in wall or checkpoint, pause the task until the user deals with
 * it in the window (or skips). Returns false when the site should be skipped.
 */
export async function clearBlocks(page: Page, site: BrowserSite, ctx: BrowserRunContext): Promise<boolean> {
  const block = await detectBlock(page);
  if (!block) return true;
  if (!ctx.waitForUser) return false;
  ctx.note?.(`${site}: ${block}`);
  const answer = await ctx.waitForUser({ kind: block, site, url: page.url() }, async () => !(await detectBlock(page)));
  if (answer === "skipped") return false;
  if (await detectBlock(page)) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    return !(await detectBlock(page));
  }
  return true;
}

async function goto(page: Page, url: string, ctx: BrowserRunContext): Promise<void> {
  checkAbort(ctx.signal);
  await pause(ctx.signal);
  checkAbort(ctx.signal);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
}

/** Structured data when the page has it, else the given main element's visible text. */
export async function capturePage(page: Page, selectors: { title?: string[]; company?: string[]; location?: string[]; salary?: string[]; body: string[] }): Promise<CapturedPage> {
  const extracted = extractFromHtml(await page.content());
  const first = (list: string[] | undefined, html: boolean) =>
    list?.length
      ? page.evaluate(
          ({ sels, html }) => {
            for (const sel of sels) {
              const el = document.querySelector(sel) as HTMLElement | null;
              const value = html ? el?.innerHTML : el?.innerText?.trim();
              if (value && value.trim()) return value;
            }
            return null;
          },
          { sels: list, html },
        )
      : Promise.resolve(null);
  const [title, company, location, salary, bodyHtml] = await Promise.all([
    first(selectors.title, false),
    first(selectors.company, false),
    first(selectors.location, false),
    first(selectors.salary, false),
    first(selectors.body, true),
  ]);
  // HTML → text keeps headings and bullet points, which the analysis quotes.
  const visible = htmlToText(bodyHtml ?? (await page.evaluate(() => document.body?.innerHTML ?? "")));
  const text = extracted.structured ? extracted.text : visible;
  return {
    text,
    hints: {
      ...extracted.hints,
      title: extracted.hints.title && extracted.structured ? extracted.hints.title : (title ?? extracted.hints.title ?? null),
      company: extracted.hints.company ?? company,
      locationText: extracted.hints.locationText ?? location,
      salaryText: extracted.hints.salaryText ?? salary,
    },
  };
}

function toLead(adapter: SiteAdapter, id: string, url: { canonical: string }, from: URL, captured: CapturedPage): JobLead {
  const header = [captured.hints.title, [captured.hints.company, captured.hints.locationText].filter(Boolean).join(" · "), captured.hints.salaryText].filter(Boolean).join("\n");
  return {
    source: adapter.site,
    sourceId: id,
    url: url.canonical,
    title: captured.hints.title ?? "",
    company: captured.hints.company ?? null,
    location: captured.hints.locationText ?? null,
    country: adapter.country(from) ?? (captured.hints.country ? captured.hints.country.toUpperCase() : null),
    // Keep the title/company/location with the text so analysis and quotes see them.
    text: captured.hints.title && captured.text.slice(0, 300).includes(captured.hints.title) ? captured.text : `${header}\n\n${captured.text}`.trim(),
    full: true,
    postedAt: captured.hints.postedAt ?? null,
    salaryText: captured.hints.salaryText ?? null,
  };
}

/**
 * Runs a site search in the user's browser: results pages → job links (by URL pattern) → each job
 * page, read in full. Paced, capped, and paused for the user on any wall or CAPTCHA.
 */
export async function runSiteSearch(adapter: SiteAdapter, filters: SearchFilters, ctx: BrowserRunContext): Promise<JobLead[]> {
  const queries = adapter.queries(filters);
  if (!queries.length) return [];
  return withBrowserPage(async (page) => {
    if (adapter.prepare && !(await adapter.prepare(page, ctx))) return [];
    const found = new Map<string, { open: string; canonical: string; from: URL }>();
    search: for (const query of queries) {
      for (let index = 0; index < MAX_RESULT_PAGES; index++) {
        if (found.size >= ctx.maxPages) break search;
        await goto(page, query.pageUrl(index), ctx);
        if (!(await clearBlocks(page, adapter.site, ctx))) {
          if (ctx.stats) ctx.stats.blocked = true;
          break search;
        }
        if (ctx.stats) ctx.stats.resultPages++;
        const current = new URL(page.url());
        const hrefs = await page.$$eval("a[href]", (links) => links.map((a) => (a as HTMLAnchorElement).href));
        let added = 0;
        for (const href of hrefs) {
          let url: URL;
          try {
            url = new URL(href, current);
          } catch {
            continue;
          }
          if (url.host !== current.host) continue;
          const id = adapter.jobIdFromUrl(url);
          if (!id || found.has(id)) continue;
          found.set(id, { ...adapter.jobUrl(id, current), from: current });
          added++;
          if (found.size >= ctx.maxPages) break;
        }
        if (ctx.stats) ctx.stats.jobLinks = found.size;
        ctx.note?.(`${adapter.site}: ${found.size} job links`);
        if (added === 0) break; // no more results
      }
    }

    const leads: JobLead[] = [];
    for (const [id, url] of found) {
      await goto(page, url.open, ctx);
      if (!(await clearBlocks(page, adapter.site, ctx))) break;
      if (page.url() !== url.open && !page.url().includes(id)) await goto(page, url.open, ctx);
      const captured = await adapter.capture(page);
      if (captured.text.length < 100) continue;
      leads.push(toLead(adapter, id, url, url.from, captured));
      ctx.note?.(`${adapter.site}: read ${leads.length} of ${found.size}`);
    }
    return leads;
  });
}

/** Reads one job page (a link the user pasted) in the browser. */
export async function readJobPage(adapter: SiteAdapter, url: URL, ctx: Omit<BrowserRunContext, "maxPages">): Promise<CapturedPage | null> {
  const id = adapter.jobIdFromUrl(url);
  if (!id) return null;
  const target = adapter.jobUrl(id, url);
  return withBrowserPage(async (page) => {
    const run = { ...ctx, maxPages: 1 };
    if (adapter.prepare && !(await adapter.prepare(page, run))) return null;
    await goto(page, target.open, run);
    if (!(await clearBlocks(page, adapter.site, run))) return null;
    if (!page.url().includes(id)) await goto(page, target.open, run);
    const captured = await adapter.capture(page);
    return captured.text.length >= 100 ? captured : null;
  });
}
