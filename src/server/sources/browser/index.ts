import type { SearchFilters } from "@/shared/schemas/search";
import type { BrowserSite } from "@/shared/source-settings";
import type { AiContext } from "../../ai/client";
import { getSourceSettings } from "../../repo/settings";
import { domainPolicy } from "../../ingest/domain-policy";
import type { JobLead } from "../types";
import { readJobPage, runSiteSearch, type BrowserRunContext, type CapturedPage, type SiteAdapter } from "./common";
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
): Promise<JobLead[]> {
  const all = getSourceSettings(ctx.db, ctx.userId);
  const settings = all[site];
  if (!settings.enabled) return [];
  const adapter = adapterFor(ctx, site);
  const stats = { resultPages: 0, jobLinks: 0, blocked: false };
  const leads = await runSiteSearch(adapter, filters, { ...run, maxPages: settings.maxPages, stats });
  if (leads.length || stats.blocked || stats.resultPages === 0 || !all.agent.enabled || !all.agent.fallback) return leads;
  const start = adapter.queries(filters)[0]?.pageUrl(0);
  if (!start) return leads;
  run.note?.(`${site}: no job links found; the browsing agent will try`);
  const { runBrowserAgent } = await import("../../ai/browser-agent/agent");
  const result = await runBrowserAgent(
    ctx,
    { kind: "search", site: { name: site === "seek" ? "SEEK" : "LinkedIn", url: start }, filters, maxJobs: Math.min(all.agent.maxJobs, settings.maxPages), source: site },
    { signal: run.signal, waitForUser: run.waitForUser, onProgress: run.note },
  );
  return result.leads;
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
export async function searchOtherSites(ctx: AiContext, filters: SearchFilters, run: Omit<BrowserRunContext, "maxPages" | "stats">): Promise<JobLead[]> {
  const { agent } = getSourceSettings(ctx.db, ctx.userId);
  if (!agent.enabled) return [];
  const { runBrowserAgent } = await import("../../ai/browser-agent/agent");
  const leads: JobLead[] = [];
  for (const site of agent.sites.slice(0, 3)) {
    run.note?.(`${site.name}: browsing`);
    const result = await runBrowserAgent(
      ctx,
      { kind: "search", site, filters, maxJobs: agent.maxJobs, source: "browser_agent" },
      { signal: run.signal, waitForUser: run.waitForUser, onProgress: run.note },
    );
    leads.push(...result.leads);
  }
  return leads;
}
