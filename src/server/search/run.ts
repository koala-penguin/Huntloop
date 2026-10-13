import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { filtersFromPreferences, searchFiltersSchema, type SearchFilters, type SearchRunSummary, type SearchSource } from "@/shared/schemas/search";
import type { Preferences } from "@/shared/schemas/preferences";
import type { Db } from "../db/database";
import { jobSightings, jobs, searches, type JobRow, type SearchRow } from "../db/schema";
import { AiError, currentAiMode, settingsFor, type AiContext } from "../ai/client";
import { parseSearch } from "../ai/tasks/parse-search";
import { searchWithAgent } from "../ai/tasks/search-agent";
import { normalizeUrl } from "../ai/agent-loop";
import { searchAdzuna, adzunaCredentials, type AdzunaFetcher } from "../sources/adzuna";
import { SourceQuotaError, type JobLead } from "../sources/types";
import type { JsonFetcher } from "../sources/ats";
import { canonicalizeUrl } from "../ingest/domain-policy";
import { createJob, dedupeKeyFor, findJobByUrl, getJob, normalizeCompanyName, updateJob } from "../repo/jobs";
import { getCurrentProfile, getPreferences } from "../repo/profile";
import { processJob, readJobUrl } from "../jobs/pipeline";
import { errorCodeOf, formatTaskError } from "../errors";
import { getSourceSettings } from "../repo/settings";
import { TaskCancelledError, type TaskContext } from "../tasks/runner";
import { searchBrowserSite, searchOtherSites } from "../sources/browser";
import { mapLimit } from "./limit";

export type SearchStage = "planning" | "sourcing" | "filtering" | "screening" | "deep" | "done";

export interface SearchProgress {
  stage: SearchStage;
  counts: { leads: number; unique: number; screened: number; toScreen: number; deep: number; toDeep: number };
  notes: string[];
}

export interface SearchRunOptions {
  taskId?: number | null;
  /** Pause for the user (CAPTCHA, sign-in) in browser sources; from the task runner. */
  waitForUser?: TaskContext["waitForUser"];
  onProgress?: (progress: SearchProgress) => void;
  /** Fetch full postings for the top results (off in demo mode: demo leads aren't real pages). */
  enrich?: boolean;
  adzunaFetcher?: AdzunaFetcher;
  fetchImpl?: typeof fetch;
  fetchJson?: JsonFetcher;
  /** Scheduled (daily) runs: only API sources — the browser never runs unattended. */
  apiOnly?: boolean;
  now?: Date;
}

/** Sources a scheduled run may use. SEEK, LinkedIn and the browsing agent only run when the user starts them. */
export const UNATTENDED_SOURCES: readonly SearchSource[] = ["adzuna", "web_agent"];

export function getSearch(db: Db, userId: number, id: number): SearchRow | undefined {
  return db
    .select()
    .from(searches)
    .where(and(eq(searches.userId, userId), eq(searches.id, id)))
    .get();
}

export function listSearches(db: Db, userId: number, limit = 20): SearchRow[] {
  return db.select().from(searches).where(eq(searches.userId, userId)).orderBy(desc(searches.id)).limit(limit).all();
}

/** Sources that can run right now: Adzuna needs its keys; the web agent always can. */
/** Sources that can run right now: Adzuna needs its keys; SEEK and LinkedIn must be turned on in Settings. */
export function availableSources(db: Db, userId: number): SearchSource[] {
  const sites = getSourceSettings(db, userId);
  return [
    ...(adzunaCredentials() ? (["adzuna"] as const) : []),
    "web_agent" as const,
    ...(sites.seek.enabled ? (["seek"] as const) : []),
    ...(sites.linkedin.enabled ? (["linkedin"] as const) : []),
    ...(sites.agent.enabled && sites.agent.sites.length ? (["browser_agent"] as const) : []),
  ];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((w) => w.length > 1 && !["and", "the", "of", "in", "for", "with", "job", "jobs", "role"].includes(w));

/** Leads seen more than once (same link, or same company + title + place) are kept once. */
export function dedupeLeads(leads: JobLead[]): JobLead[] {
  const seen = new Set<string>();
  const out: JobLead[] = [];
  for (const lead of leads) {
    const url = normalizeUrl(lead.url);
    const key = dedupeKeyFor(lead.company, lead.title, lead.location?.split(",")[0] ?? null);
    if ((url && seen.has(url)) || (key && seen.has(key))) continue;
    if (url) seen.add(url);
    if (key) seen.add(key);
    out.push(lead);
  }
  return out;
}

export interface Prefiltered {
  lead: JobLead;
  score: number;
  reason: string | null;
}

/** Free checks in code before any AI call: rule-outs, then a rough relevance score for ordering. */
export function prefilter(leads: JobLead[], filters: SearchFilters, preferences: Preferences, skills: string[], now: Date): Prefiltered[] {
  const excluded = preferences.excludedCompanies.map(normalizeCompanyName).filter(Boolean);
  const countries = new Set(filters.locations.map((l) => l.country));
  const maxAge = filters.postedWithinDays ?? preferences.maxPostingAgeDays;
  const titleWords = new Set(filters.titles.flatMap(words));
  const skillWords = new Set([...filters.keywords, ...skills].map((s) => s.toLowerCase()));
  return leads.map((lead) => {
    const text = `${lead.title} ${lead.text}`.toLowerCase();
    if (lead.company && excluded.includes(normalizeCompanyName(lead.company))) return { lead, score: 0, reason: "excluded_company" };
    if (filters.excludeKeywords.some((k) => k && text.includes(k.toLowerCase()))) return { lead, score: 0, reason: "excluded_keyword" };
    if (lead.postedAt) {
      const age = (now.getTime() - Date.parse(lead.postedAt)) / 86_400_000;
      if (Number.isFinite(age) && age > maxAge) return { lead, score: 0, reason: "too_old" };
    }
    const remote = /\bremote\b/i.test(text);
    if (lead.country && countries.size && !countries.has(lead.country) && !preferences.willingToRelocate && !remote) return { lead, score: 0, reason: "outside_markets" };
    const leadTitle = new Set(words(lead.title));
    const titleOverlap = titleWords.size ? [...titleWords].filter((w) => leadTitle.has(w)).length / titleWords.size : 0.5;
    if (titleWords.size && titleOverlap === 0) return { lead, score: 0, reason: "title_mismatch" };
    const skillHits = [...skillWords].filter((s) => s.length > 1 && text.includes(s)).length;
    const score = titleOverlap * 0.7 + Math.min(skillHits, 5) * 0.06;
    return { lead, score, reason: null };
  });
}

function leadText(lead: JobLead): string {
  return [lead.title, [lead.company, lead.location].filter(Boolean).join(" · "), lead.salaryText, lead.postedAt ? `Posted ${lead.postedAt.slice(0, 10)}` : null, "", lead.text]
    .filter((l) => l !== null)
    .join("\n")
    .trim();
}

function addSighting(db: Db, jobId: number, searchId: number, taskId: number | null, lead: JobLead, rank: number): void {
  db.insert(jobSightings).values({ jobId, searchId, taskId, source: lead.source, sourceId: lead.sourceId, url: lead.url, rank }).run();
}

function findKnownJob(db: Db, userId: number, lead: JobLead): JobRow | undefined {
  const url = canonicalizeUrl(lead.url);
  const byUrl = url ? findJobByUrl(db, userId, url) : undefined;
  if (byUrl) return byUrl;
  const key = dedupeKeyFor(lead.company, lead.title, lead.location?.split(",")[0] ?? null);
  return key
    ? db
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.dedupeKey, key)))
        .get()
    : undefined;
}

/**
 * One run of a saved search: plan → sources → dedupe → free code checks → screen the best
 * candidates (provisional tiers) → full posting + deep analysis for the top few.
 */
export async function runSearch(ctx: AiContext, searchId: number, options: SearchRunOptions = {}): Promise<SearchRunSummary> {
  const now = options.now ?? new Date();
  const search = getSearch(ctx.db, ctx.userId, searchId);
  if (!search) throw new Error(`Search ${searchId} not found`);
  const preferences = getPreferences(ctx.db, ctx.userId);
  const profile = getCurrentProfile(ctx.db, ctx.userId);
  const caps = settingsFor(ctx).search;
  const progress: SearchProgress = { stage: "planning", counts: { leads: 0, unique: 0, screened: 0, toScreen: 0, deep: 0, toDeep: 0 }, notes: [] };
  const emit = () => options.onProgress?.(structuredClone(progress));
  const note = (text: string) => {
    if (progress.notes.at(-1) === text) return;
    progress.notes = [...progress.notes, text].slice(-6);
    emit();
  };
  emit();

  // 1. Filters (the user's words → editable filters, once).
  let filters: SearchFilters;
  const stored = searchFiltersSchema.safeParse(search.filters);
  if (stored.success) filters = stored.data;
  else {
    filters = await parseSearch(ctx, search.query, filtersFromPreferences(preferences), preferences, now);
    ctx.db.update(searches).set({ filters }).where(eq(searches.id, search.id)).run();
  }

  // 2. Sources.
  progress.stage = "sourcing";
  emit();
  const summary: SearchRunSummary = { sources: {}, unique: 0, known: 0, filtered: {}, screened: 0, deep: 0, stoppedBy: null };
  const leads: JobLead[] = [];
  const candidate = profile ? { recentTitles: profile.data.experience.slice(0, 3).map((e) => e.title), topSkills: profile.data.skills.slice(0, 12).map((s) => s.name) } : null;
  const sources = (search.sources as SearchSource[]).filter((s) => !options.apiOnly || UNATTENDED_SOURCES.includes(s));
  for (const source of sources) {
    try {
      const found =
        source === "adzuna"
          ? await searchAdzuna(ctx.db, filters, options.adzunaFetcher)
          : source === "seek" || source === "linkedin"
            ? await searchBrowserSite(ctx, source, filters, { signal: ctx.signal, waitForUser: options.waitForUser, note })
            : source === "browser_agent"
              ? await searchOtherSites(ctx, filters, { signal: ctx.signal, waitForUser: options.waitForUser, note })
              : (await searchWithAgent(ctx, { filters, candidate }, note, now)).leads;
      leads.push(...found);
      summary.sources[source] = { leads: found.length, error: null };
    } catch (error) {
      if (error instanceof AiError && (error.code === "budget" || error.code === "subscription_limit")) summary.stoppedBy = error.code === "budget" ? "budget" : "limit";
      if (error instanceof TaskCancelledError) throw error;
      summary.sources[source] = {
        leads: 0,
        error: error instanceof SourceQuotaError ? "quota" : error instanceof AiError ? error.code : (errorCodeOf(error) ?? formatTaskError(error).slice(0, 200)),
      };
    }
    progress.counts.leads = leads.length;
    emit();
  }

  // 3. Dedupe; jobs already in Huntloop just get a new sighting.
  progress.stage = "filtering";
  emit();
  const unique = dedupeLeads(leads);
  summary.unique = unique.length;
  progress.counts.unique = unique.length;
  const fresh: JobLead[] = [];
  unique.forEach((lead, rank) => {
    const known = findKnownJob(ctx.db, ctx.userId, lead);
    if (known) {
      summary.known++;
      addSighting(ctx.db, known.id, search.id, options.taskId ?? null, lead, rank);
    } else fresh.push(lead);
  });

  // 4. Free code checks, then the best candidates go to screening.
  const checked = prefilter(fresh, filters, preferences, profile?.data.skills.map((s) => s.name) ?? [], now);
  for (const c of checked) if (c.reason) summary.filtered[c.reason] = (summary.filtered[c.reason] ?? 0) + 1;
  const toScreen = checked
    .filter((c) => !c.reason)
    .sort((a, b) => b.score - a.score)
    .slice(0, summary.stoppedBy ? 0 : caps.screenTopN);
  progress.stage = "screening";
  progress.counts.toScreen = toScreen.length;
  emit();

  // 5. Screening: one quick analysis per job on whatever text the source gave (provisional tier).
  // The first job runs alone so the shared prompt prefix is cached for the rest.
  const screenedIds: number[] = [];
  const screenOne = async ({ lead }: Prefiltered, index: number) => {
    if (summary.stoppedBy) return;
    const url = canonicalizeUrl(lead.url);
    const job = createJob(ctx.db, ctx.userId, {
      source: lead.source,
      sourceUrl: url,
      applyUrl: url,
      title: lead.title,
      companyName: lead.company,
      locationText: lead.location,
      country: lead.country,
      rawText: leadText(lead),
      descriptionIsFull: lead.full,
      intakeStatus: "processing",
      intake: {
        noisy: false,
        partial: !lead.full,
        hints: { title: lead.title, company: lead.company, locationText: lead.location, country: lead.country, postedAt: lead.postedAt, salaryText: lead.salaryText },
      },
    });
    addSighting(ctx.db, job.id, search.id, options.taskId ?? null, lead, index);
    try {
      await processJob(ctx, job, { screen: true });
      screenedIds.push(job.id);
    } catch (error) {
      if (error instanceof AiError && (error.code === "budget" || error.code === "subscription_limit")) summary.stoppedBy = error.code === "budget" ? "budget" : "limit";
      updateJob(ctx.db, job.id, { intakeStatus: "failed", intakeError: formatTaskError(error) });
    } finally {
      progress.counts.screened++;
      emit();
    }
  };
  if (toScreen.length) {
    await screenOne(toScreen[0], 0);
    await mapLimit(toScreen.slice(1), 3, (c, i) => screenOne(c, i + 1));
  }
  summary.screened = screenedIds.length;

  // 6. Deep pass: fetch the full posting for the best few and analyse them properly.
  const enrich = options.enrich ?? (await currentAiMode(ctx)) !== "fake";
  const ranked = screenedIds
    .map((id) => getJob(ctx.db, ctx.userId, id)!)
    .filter((j) => j.eligibility !== "ineligible" && !j.descriptionIsFull && j.sourceUrl)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, enrich && !summary.stoppedBy ? caps.deepTopN : 0);
  progress.stage = "deep";
  progress.counts.toDeep = ranked.length;
  emit();
  for (const job of ranked) {
    if (summary.stoppedBy) break;
    try {
      const content = await readJobUrl(job.sourceUrl!, { fetchImpl: options.fetchImpl, fetchJson: options.fetchJson });
      if (content.kind === "content" && content.text.length > 200) {
        const updated = updateJob(ctx.db, job.id, {
          rawText: content.text,
          intake: { ...(job.intake ?? {}), hints: { ...(job.intake?.hints ?? {}), ...(content.hints as Record<string, string | null>) }, noisy: content.noisy, partial: false },
        });
        await processJob(ctx, updated, {});
        summary.deep++;
      }
    } catch (error) {
      if (error instanceof AiError && (error.code === "budget" || error.code === "subscription_limit")) summary.stoppedBy = error.code === "budget" ? "budget" : "limit";
      // Keep the screened (provisional) result.
    } finally {
      progress.counts.deep++;
      emit();
    }
  }

  ctx.db.update(searches).set({ lastRunAt: now, lastSummary: summary }).where(eq(searches.id, search.id)).run();
  progress.stage = "done";
  emit();
  return summary;
}

export interface SearchResultJob {
  job: JobRow;
  /** First seen in this run. */
  isNew: boolean;
  sources: string[];
}

/** Jobs a search has found (any run), with which ones the latest run found for the first time. */
export function searchResults(db: Db, userId: number, searchId: number, latestTaskId: number | null): SearchResultJob[] {
  const sightings = db
    .select()
    .from(jobSightings)
    .where(eq(jobSightings.searchId, searchId))
    .orderBy(asc(jobSightings.id))
    .all();
  const byJob = new Map<number, { firstTask: number | null; sources: Set<string> }>();
  for (const s of sightings) {
    const entry = byJob.get(s.jobId) ?? { firstTask: s.taskId, sources: new Set<string>() };
    entry.sources.add(s.source);
    byJob.set(s.jobId, entry);
  }
  if (!byJob.size) return [];
  const rows = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.userId, userId), inArray(jobs.id, [...byJob.keys()])))
    .all();
  return rows.map((job) => ({ job, isNew: latestTaskId !== null && byJob.get(job.id)!.firstTask === latestTaskId, sources: [...byJob.get(job.id)!.sources] }));
}
