import { and, eq, gte } from "drizzle-orm";
import type { SearchFilters } from "@/shared/schemas/search";
import { marketPack } from "@/shared/markets";
import type { Db } from "../db/database";
import { sourceCalls } from "../db/schema";
import { readEnv } from "../config/env";
import { htmlToText } from "../ingest/html";
import { safeFetch } from "../ingest/safe-fetch";
import { SourceQuotaError, type JobLead } from "./types";

/**
 * Adzuna job search API (free key; AU, NZ, SG, US, GB, …). Results are ~500-character snippets and
 * salaries may be Adzuna's estimate. Adzuna requires "Jobs by Adzuna" attribution next to results.
 */
export const ADZUNA_LIMITS = { minute: 25, day: 250, month: 2500 } as const;
const MAX_REQUESTS_PER_RUN = 9;

export function adzunaCredentials(): { appId: string; appKey: string } | null {
  const env = readEnv();
  return env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY ? { appId: env.ADZUNA_APP_ID, appKey: env.ADZUNA_APP_KEY } : null;
}

/** Throws when another call would exceed Adzuna's limits; otherwise records the call. */
export function takeAdzunaCall(db: Db, now = new Date()): void {
  const count = (since: Date) =>
    db
      .select({ id: sourceCalls.id })
      .from(sourceCalls)
      .where(and(eq(sourceCalls.source, "adzuna"), gte(sourceCalls.createdAt, since)))
      .all().length;
  const minute = new Date(now.getTime() - 60_000);
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (count(month) >= ADZUNA_LIMITS.month) throw new SourceQuotaError("adzuna", "month");
  if (count(day) >= ADZUNA_LIMITS.day) throw new SourceQuotaError("adzuna", "day");
  if (count(minute) >= ADZUNA_LIMITS.minute) throw new SourceQuotaError("adzuna", "minute");
  db.insert(sourceCalls).values({ source: "adzuna", createdAt: now }).run();
}

export interface AdzunaQuery {
  country: string;
  what: string;
  where: string | null;
  params: Record<string, string>;
}

/** One request per (title × location), capped; filters map to Adzuna's parameters. */
export function buildAdzunaQueries(filters: SearchFilters): AdzunaQuery[] {
  const titles = filters.titles.length ? filters.titles.slice(0, 3) : [filters.keywords.slice(0, 3).join(" ")].filter(Boolean);
  const locations = filters.locations.filter((l) => marketPack(l.country).adzunaCountry).slice(0, 3);
  const params: Record<string, string> = { results_per_page: "50", sort_by: "date", "content-type": "application/json" };
  if (filters.postedWithinDays) params.max_days_old = String(filters.postedWithinDays);
  if (filters.salaryMin) params.salary_min = String(Math.round(filters.salaryMin));
  const types = new Set(filters.employmentTypes);
  if (types.size === 1 && types.has("full_time")) params.full_time = "1";
  else if (types.size === 1 && types.has("part_time")) params.part_time = "1";
  else if (types.size === 1 && types.has("contract")) params.contract = "1";
  if (filters.excludeKeywords.length) params.what_exclude = filters.excludeKeywords.join(" ");
  const out: AdzunaQuery[] = [];
  for (const location of locations) {
    for (const title of titles) {
      const what = [title, ...(filters.titles.length ? filters.keywords.slice(0, 2) : [])].join(" ").trim();
      if (what) out.push({ country: marketPack(location.country).adzunaCountry!, what, where: location.city, params });
    }
  }
  return out.slice(0, MAX_REQUESTS_PER_RUN);
}

export function adzunaUrl(query: AdzunaQuery, credentials: { appId: string; appKey: string }): string {
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${query.country}/search/1`);
  url.searchParams.set("app_id", credentials.appId);
  url.searchParams.set("app_key", credentials.appKey);
  url.searchParams.set("what", query.what);
  if (query.where) url.searchParams.set("where", query.where);
  for (const [k, v] of Object.entries(query.params)) url.searchParams.set(k, v);
  return url.toString();
}

type Json = Record<string, unknown>;

export function adzunaResultToLead(result: Json, country: string): JobLead {
  const company = (result.company as Json | undefined)?.display_name as string | undefined;
  const location = (result.location as Json | undefined)?.display_name as string | undefined;
  const min = result.salary_min as number | undefined;
  const max = result.salary_max as number | undefined;
  const predicted = String(result.salary_is_predicted ?? "0") === "1";
  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const salaryText = min || max ? `${[min, max].filter(Boolean).map((n) => fmt(n!)).join("–")}${predicted ? " (Adzuna estimate)" : ""}` : null;
  return {
    source: "adzuna",
    sourceId: result.id != null ? String(result.id) : null,
    url: String(result.redirect_url ?? ""),
    title: htmlToText(String(result.title ?? "")),
    company: company ? htmlToText(company) : null,
    location: location ?? null,
    country: country.toUpperCase() === "GB" ? "GB" : country.toUpperCase(),
    text: htmlToText(String(result.description ?? "")),
    full: false,
    postedAt: (result.created as string) ?? null,
    salaryText,
  };
}

export type AdzunaFetcher = (url: string) => Promise<unknown>;
const defaultFetcher: AdzunaFetcher = async (url) => JSON.parse((await safeFetch(url, { accept: "application/json" })).body);

/** Runs the queries (respecting quotas) and returns leads; stops early when a quota is hit. */
export async function searchAdzuna(db: Db, filters: SearchFilters, fetcher: AdzunaFetcher = defaultFetcher): Promise<JobLead[]> {
  const credentials = adzunaCredentials();
  if (!credentials) return [];
  const leads: JobLead[] = [];
  for (const query of buildAdzunaQueries(filters)) {
    takeAdzunaCall(db);
    const data = (await fetcher(adzunaUrl(query, credentials))) as Json;
    for (const result of (data.results as Json[] | undefined) ?? []) {
      const lead = adzunaResultToLead(result, query.country);
      if (lead.url && lead.title) leads.push(lead);
    }
  }
  return leads;
}
