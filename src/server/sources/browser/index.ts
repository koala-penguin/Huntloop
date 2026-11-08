import type { RejectedLead, SearchFilters, SourceDetail } from "@/shared/schemas/search";
import type { BrowserSite } from "@/shared/source-settings";
import type { AiContext } from "../../ai/client";
import { getSourceSettings } from "../../repo/settings";
import { domainPolicy } from "../../ingest/domain-policy";
import type { JobLead } from "../types";
import { readJobPage, runSiteSearch, type BrowserRunContext, type BrowserRunStats, type CapturedPage, type SiteAdapter } from "./common";
import { seekAdapter } from "./seek";
import { createLinkedinAdapter } from "./linkedin";

function adapterFor(ctx: Pick<AiContext, "db" | "userId">, site: BrowserSite): SiteAdapter {
  return site === "seek" ? seekAdapter : createLinkedinAdapter({ useLogin: getSourceSettings(ctx.db, ctx.userId).linkedin.useLogin });
}

/**
 * A search on SEEK or LinkedIn in the user's browser window (only when turned on in Settings).
 * If the site's pages load but no job links are found — e.g. after a redesign — and the browsing
 * agent's fallback is on, Claude browses the same search instead.
 */
export async function searchBrowserSite(
  ctx: AiContext,
  site: BrowserSite,
  filters: SearchFilters,
  run: Omit<BrowserRunContext, "maxPages" | "stats">,
): Promise<BrowserSearchResult> {
  const all = getSourceSettings(ctx.db, ctx.userId);
  const settings = all[site];
  if (!settings.enabled) return { leads: [], rejected: [] };
  const adapter = adapterFor(ctx, site);
  const stats: BrowserRunStats = { resultPages: 0, jobLinks: 0, blocked: false, jobPagesRead: 0 };
  const leads = await runSiteSearch(adapter, filters, { ...run, maxPages: settings.maxPages, stats });
  const done = (found: JobLead[], rejected: RejectedLead[] = []): BrowserSearchResult => ({ leads: found, rejected, detail: sourceDetail(stats, found.length) });
  if (leads.length || stats.blocked || stats.resultPages === 0 || !all.agent.enabled || !all.agent.fallback) return done(leads);
  const start = adapter.queries(filters)[0]?.pageUrl(0);
  if (!start) return done(leads);
  run.note?.({ key: "agentFallback", params: { site } });
  const { runBrowserAgent } = await import("../../ai/browser-agent/agent");
  const result = await runBrowserAgent(
    ctx,
    { kind: "search", site: { name: site === "seek" ? "SEEK" : "LinkedIn", url: start }, filters, maxJobs: Math.min(all.agent.maxJobs, settings.maxPages), source: site },
    { signal: run.signal, waitForUser: run.waitForUser, onProgress: run.note },
  );
  return done(result.leads, result.rejected);
}

export interface BrowserSearchResult {
  leads: JobLead[];
  /** Leads the browsing agent reported but couldn't use. */
  rejected: RejectedLead[];
  /** Why the site found nothing, when it found nothing. */
  detail?: SourceDetail;
}

/** Why a site search found no jobs (leadCount = the final count, after any agent fallback). */
export function sourceDetail(stats: BrowserRunStats, leadCount: number): SourceDetail | undefined {
  if (leadCount > 0) return undefined;
  if (stats.blocked) return "blocked_skipped";
  if (stats.resultPages === 0) return undefined;
  return stats.jobLinks === 0 ? "no_job_links" : "pages_unreadable";
}

/** For a pasted SEEK/LinkedIn link: the site, if it's turned on and the link is a job page. */
export function browserSiteFor(ctx: Pick<AiContext, "db" | "userId">, url: URL): BrowserSite | null {
  const policy = domainPolicy(url);
  if (policy.mode !== "browser" || (policy.site !== "seek" && policy.site !== "linkedin")) return null;
  const site = policy.site;
  if (!getSourceSettings(ctx.db, ctx.userId)[site].enabled) return null;
  return adapterFor(ctx, site).jobIdFromUrl(url) ? site : null;
}

export function readJobInBrowser(ctx: Pick<AiContext, "db" | "userId">, site: BrowserSite, url: URL, run: Omit<BrowserRunContext, "maxPages">): Promise<CapturedPage | null> {
  return readJobPage(adapterFor(ctx, site), url, run);
}

/** "Other job sites" from Settings, browsed by the agent (each site is a separate, capped run). */
export async function searchOtherSites(ctx: AiContext, filters: SearchFilters, run: Omit<BrowserRunContext, "maxPages" | "stats">): Promise<BrowserSearchResult> {
  const { agent } = getSourceSettings(ctx.db, ctx.userId);
  if (!agent.enabled) return { leads: [], rejected: [] };
  const { runBrowserAgent } = await import("../../ai/browser-agent/agent");
  const leads: JobLead[] = [];
  const rejected: RejectedLead[] = [];
  for (const site of agent.sites.slice(0, 3)) {
    run.note?.({ key: "siteBrowsing", params: { site: site.name } });
    const result = await runBrowserAgent(
      ctx,
      { kind: "search", site, filters, maxJobs: agent.maxJobs, source: "browser_agent" },
      { signal: run.signal, waitForUser: run.waitForUser, onProgress: run.note },
    );
    leads.push(...result.leads);
    rejected.push(...result.rejected);
  }
  return { leads, rejected };
}
