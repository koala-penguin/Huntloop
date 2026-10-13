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

/** A search on SEEK or LinkedIn in the user's browser window (only when turned on in Settings). */
export async function searchBrowserSite(
  ctx: Pick<AiContext, "db" | "userId">,
  site: BrowserSite,
  filters: SearchFilters,
  run: Omit<BrowserRunContext, "maxPages">,
): Promise<JobLead[]> {
  const settings = getSourceSettings(ctx.db, ctx.userId)[site];
  if (!settings.enabled) return [];
  return runSiteSearch(adapterFor(ctx, site), filters, { ...run, maxPages: settings.maxPages });
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
