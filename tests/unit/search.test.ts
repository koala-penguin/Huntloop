import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobSightings, jobs, searches, sourceCalls, tasks, usageLog } from "@/server/db/schema";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { parseSearch } from "@/server/ai/tasks/parse-search";
import { adzunaResultToLead, buildAdzunaQueries, searchAdzuna, takeAdzunaCall, ADZUNA_LIMITS } from "@/server/sources/adzuna";
import { SourceQuotaError, type JobLead } from "@/server/sources/types";
import { dedupeLeads, getSearch, prefilter, runSearch, searchResults } from "@/server/search/run";
import { activeSearchTask, createSearch, latestSearchTask, rerunSearch } from "@/server/search/tasks";
import { createJob, getJob } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { filtersFromPreferences, type SearchFilters } from "@/shared/schemas/search";
import { defaultPreferences, type Preferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";

const NOW = new Date("2026-10-12T00:00:00Z");
const fixture = (...parts: string[]) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", ...parts), "utf8"));
const saved = { dir: process.env.HUNTLOOP_DATA_DIR, id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };

beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-search-"));
  process.env.ADZUNA_APP_ID = "test-id";
  process.env.ADZUNA_APP_KEY = "test-key";
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = saved.dir;
  if (saved.id === undefined) delete process.env.ADZUNA_APP_ID;
  else process.env.ADZUNA_APP_ID = saved.id;
  if (saved.key === undefined) delete process.env.ADZUNA_APP_KEY;
  else process.env.ADZUNA_APP_KEY = saved.key;
});

const prefs = (patch: Partial<Preferences> = {}): Preferences => ({
  ...defaultPreferences(),
  targetTitles: ["Frontend Engineer"],
  markets: [{ country: "AU", primary: true, cities: ["Sydney"], remoteOk: true }],
  ...patch,
});

function setup(preferences = prefs()) {
  const { db, userId } = testDb();
  saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({ skills: [{ name: "React", category: "framework" }, { name: "TypeScript", category: "language" }] }, [right("AU", "citizen", "au_citizen")]) });
  savePreferences(db, userId, preferences);
  return { db, userId, ctx: { db, userId } };
}

const lead = (patch: Partial<JobLead>): JobLead => ({
  source: "adzuna",
  sourceId: null,
  url: "https://example.com/jobs/1",
  title: "Frontend Engineer",
  company: "Acme",
  location: "Sydney",
  country: "AU",
  text: "React and TypeScript",
  full: false,
  postedAt: "2026-10-10",
  salaryText: null,
  ...patch,
});

describe("search tasks", () => {
  it("treats a run waiting for the user as still running", () => {
    const { db, userId } = setup();
    const { searchId, taskId } = createSearch(db, userId, "frontend jobs in Sydney");
    db.update(tasks).set({ status: "needs_user_action" }).where(eq(tasks.id, taskId)).run();
    expect(activeSearchTask(db, userId, searchId)).toBe(taskId);
    const before = db.select().from(tasks).all().length;
    expect(rerunSearch(db, userId, searchId)).toBe(taskId);
    expect(db.select().from(tasks).all().length).toBe(before);
  });
});

describe("search planning", () => {
  it("turns a request into filters, starting from the saved preferences", async () => {
    const { ctx } = setup();
    const defaults = filtersFromPreferences(prefs());
    expect(defaults).toMatchObject({ titles: ["Frontend Engineer"], locations: [{ country: "AU", city: "Sydney" }], postedWithinDays: 30 });
    const filters = await parseSearch(ctx, "senior frontend roles in Melbourne, hybrid, posted this week", defaults, prefs(), NOW);
    expect(filters).toMatchObject({ titles: ["Frontend Engineer"], locations: [{ country: "AU", city: "Melbourne" }], seniority: ["senior"], postedWithinDays: 7 });
    expect(filters.workplace).toContain("hybrid");
    // Korean works too, and an empty request keeps the defaults without an AI call.
    expect((await parseSearch(ctx, "오클랜드 백엔드 개발자", defaults, prefs(), NOW)).locations).toEqual([{ country: "NZ", city: "Auckland" }]);
    expect(await parseSearch(ctx, "  ", defaults, prefs(), NOW)).toBe(defaults);
  });
});

describe("Adzuna", () => {
  const filters: SearchFilters = { ...filtersFromPreferences(prefs()), titles: ["Frontend Engineer", "Frontend Developer"], employmentTypes: ["full_time"], salaryMin: 150000 };

  it("builds one capped request per title and place, with Adzuna's parameters", () => {
    const queries = buildAdzunaQueries({ ...filters, locations: [{ country: "AU", city: "Sydney" }, { country: "KR", city: "Seoul" }] });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({ country: "au", what: "Frontend Engineer", where: "Sydney" });
    expect(queries[0].params).toMatchObject({ full_time: "1", salary_min: "150000", max_days_old: "30", results_per_page: "50" });
  });

  it("maps results to leads (HTML stripped, estimated salaries marked)", () => {
    const [first, second] = fixture("api", "adzuna-search.json").results;
    expect(adzunaResultToLead(first, "au")).toMatchObject({
      source: "adzuna",
      sourceId: "4901234567",
      title: "Senior Frontend Engineer",
      company: "Bright Harbour Health",
      country: "AU",
      salaryText: "165,000–185,000",
      full: false,
    });
    expect(adzunaResultToLead(first, "au").text).toContain("building React and TypeScript apps");
    expect(adzunaResultToLead(second, "au").salaryText).toBe("120,000 (Adzuna estimate)");
  });

  it("enforces Adzuna's rate limits from recorded calls", () => {
    const { db } = setup();
    for (let i = 0; i < ADZUNA_LIMITS.minute; i++) takeAdzunaCall(db, NOW);
    expect(() => takeAdzunaCall(db, NOW)).toThrow(SourceQuotaError);
    expect(() => takeAdzunaCall(db, new Date(NOW.getTime() + 61_000))).not.toThrow();
    expect(db.select().from(sourceCalls).all()).toHaveLength(ADZUNA_LIMITS.minute + 1);
  });

  it("calls the API with the keys and returns leads", async () => {
    const { db } = setup();
    const urls: string[] = [];
    const { leads, quotaHit } = await searchAdzuna(db, { ...filters, titles: ["Frontend Engineer"] }, async (url) => {
      urls.push(url);
      return fixture("api", "adzuna-search.json");
    });
    expect(urls[0]).toContain("https://api.adzuna.com/v1/api/jobs/au/search/1?app_id=test-id&app_key=test-key&what=Frontend+Engineer&where=Sydney");
    expect(leads).toHaveLength(3);
    expect(quotaHit).toBe(false);
  });

  it("keeps the leads it already has when a quota runs out mid-run", async () => {
    const { db } = setup();
    for (let i = 0; i < ADZUNA_LIMITS.minute - 1; i++) db.insert(sourceCalls).values({ source: "adzuna", createdAt: new Date() }).run();
    let calls = 0;
    const result = await searchAdzuna(db, { ...filters, titles: ["Frontend Engineer", "Frontend Developer"] }, async () => {
      calls++;
      return fixture("api", "adzuna-search.json");
    });
    expect(calls).toBe(1);
    expect(result.leads).toHaveLength(3);
    expect(result.quotaHit).toBe(true);
  });
});

describe("dedupe and free checks", () => {
  it("keeps one lead per link or company + title + place", () => {
    const leads = dedupeLeads([
      lead({ url: "https://example.com/jobs/1?utm_source=x" }),
      lead({ url: "https://www.example.com/jobs/1/", source: "web_agent" }),
      lead({ url: "https://other.example/2" }),
      lead({ url: "https://other.example/3", title: "Backend Engineer" }),
    ]);
    expect(leads.map((l) => l.url)).toEqual(["https://example.com/jobs/1?utm_source=x", "https://other.example/3"]);
  });

  it("rules leads out for clear reasons and ranks the rest", () => {
    const filters = { ...filtersFromPreferences(prefs({ excludedCompanies: ["Bad Corp Pty Ltd"] })), excludeKeywords: ["unpaid"] };
    const results = prefilter(
      [
        lead({ company: "Bad Corp" }),
        lead({ text: "Unpaid trial" }),
        lead({ postedAt: "2026-06-01" }),
        lead({ country: "US", location: "Austin" }),
        lead({ title: "Accountant" }),
        lead({ title: "Senior Frontend Engineer", text: "React, TypeScript" }),
        lead({ title: "Frontend Engineer", text: "Vue" }),
      ],
      filters,
      prefs({ excludedCompanies: ["Bad Corp Pty Ltd"] }),
      ["React", "TypeScript"],
      NOW,
    );
    expect(results.map((r) => r.reason)).toEqual(["excluded_company", "excluded_keyword", "too_old", "outside_markets", "title_mismatch", null, null]);
    expect(results[5].score).toBeGreaterThan(results[6].score);
  });
});

describe("a search run (demo mode)", () => {
  it("finds, dedupes, filters and screens jobs, and recognises them next time", async () => {
    const { db, userId, ctx } = setup();
    const { searchId, taskId } = createSearch(db, userId, "frontend engineer in Sydney");
    expect(getSearch(db, userId, searchId)!.sources).toEqual(["adzuna", "web_agent"]);
    const stages: string[] = [];
    const summary = await runSearch(ctx, searchId, {
      taskId,
      now: NOW,
      enrich: false,
      adzunaFetcher: async () => fixture("api", "adzuna-search.json"),
      onProgress: (p) => stages.push(p.stage),
    });

    expect(summary.sources).toEqual({ adzuna: { leads: 3, error: null }, web_agent: { leads: 2, error: null } });
    expect(summary.filtered).toEqual({ too_old: 1 });
    expect(summary.screened).toBe(4);
    expect([...new Set(stages)]).toEqual(["planning", "sourcing", "filtering", "screening", "deep", "done"]);

    const rows = db.select().from(jobs).all();
    expect(rows).toHaveLength(4);
    expect(rows.every((j) => j.intakeStatus === "ready" && j.descriptionIsFull === false && j.tier)).toBe(true);
    expect(rows.map((j) => j.source).sort()).toEqual(["adzuna", "adzuna", "web_agent", "web_agent"]);
    // The agent's SEEK link and the URL it never saw were dropped; job boards are never fetched.
    expect(rows.some((j) => j.sourceUrl?.includes("seek.com.au") || j.sourceUrl?.includes("unseen"))).toBe(false);
    // Screening uses the screening task settings and stores "screen" assessments.
    expect(new Set(db.select().from(usageLog).all().map((u) => u.task))).toEqual(new Set(["parseSearch", "searchAgent", "screen"]));

    db.update(tasks).set({ status: "succeeded" }).run();
    const first = searchResults(db, userId, searchId, latestSearchTask(db, userId, searchId));
    expect(first.filter((r) => r.isNew)).toHaveLength(4);

    // Second run: everything is already known — new sightings, no new screening.
    const calls = db.select().from(usageLog).all().length;
    const second = await runSearch(ctx, searchId, { taskId: 999, now: NOW, enrich: false, adzunaFetcher: async () => fixture("api", "adzuna-search.json") });
    expect(second).toMatchObject({ known: 4, screened: 0 });
    expect(db.select().from(usageLog).all().length - calls).toBe(1); // only the search agent ran again
    expect(db.select().from(jobSightings).all()).toHaveLength(8);
    expect(searchResults(db, userId, searchId, 999).filter((r) => r.isNew)).toHaveLength(0);
  });

  it("keeps and screens Adzuna's results when its quota runs out part way", async () => {
    const { db, userId, ctx } = setup();
    const { searchId, taskId } = createSearch(db, userId, "frontend engineer in Sydney");
    db.update(searches)
      .set({ filters: { ...filtersFromPreferences(prefs()), titles: ["Frontend Engineer", "Frontend Developer"] } })
      .where(eq(searches.id, searchId))
      .run();
    for (let i = 0; i < ADZUNA_LIMITS.minute - 1; i++) db.insert(sourceCalls).values({ source: "adzuna", createdAt: new Date() }).run();
    const summary = await runSearch(ctx, searchId, { taskId, now: NOW, enrich: false, adzunaFetcher: async () => fixture("api", "adzuna-search.json") });
    expect(summary.sources.adzuna).toEqual({ leads: 3, error: null, partial: "quota" });
    expect(summary.screened).toBeGreaterThan(0);
  });

  it("deep-analyses the top results using the full posting when it can be read", async () => {
    const { db, userId, ctx } = setup();
    const { searchId } = createSearch(db, userId, "frontend engineer in Sydney");
    const greenhouse = fixture("api", "greenhouse-job.json");
    const summary = await runSearch(ctx, searchId, {
      now: NOW,
      enrich: true,
      adzunaFetcher: async () => ({ results: [] }),
      fetchJson: async () => greenhouse,
      fetchImpl: (async () => new Response("<title>Just a moment...</title>")) as unknown as typeof fetch,
    });
    expect(summary.deep).toBe(1);
    // The web agent found it; the full text came from the employer's Greenhouse board.
    const deep = db.select().from(jobs).all().find((j) => j.sourceUrl?.includes("greenhouse"));
    expect(deep).toMatchObject({ source: "web_agent", descriptionIsFull: true, companyName: "Canva" });
    expect(deep!.description).toContain("full working rights in Australia");
  });
});

describe("upgrading a search result to the full posting", () => {
  const snippetJob = (db: ReturnType<typeof testDb>["db"], userId: number, url: string) =>
    createJob(db, userId, {
      source: "web_agent",
      sourceUrl: url,
      rawText: "Senior Frontend Engineer\nCanva · Sydney\n\nBuild editing experiences with React and TypeScript.",
      descriptionIsFull: false,
      intake: { noisy: false, partial: true },
    });

  it("replaces the snippet with the full posting from the link", async () => {
    const { db, userId, ctx } = setup();
    const job = await processJob(ctx, snippetJob(db, userId, "https://job-boards.greenhouse.io/canva/jobs/4012345"), { screen: true });
    expect(job.descriptionIsFull).toBe(false);
    const full = await processJob(ctx, job, { preferUrl: true, fetchJson: async () => fixture("api", "greenhouse-job.json") });
    expect(full).toMatchObject({ descriptionIsFull: true, intakeStatus: "ready", source: "greenhouse" });
    expect(full.intake?.partial).toBe(false);
  });

  it("keeps the provisional report when the site can't be read, and says why", async () => {
    const { db, userId, ctx } = setup();
    const job = await processJob(ctx, snippetJob(db, userId, "https://www.seek.com.au/job/81234567"), { screen: true });
    const after = await processJob(ctx, job, { preferUrl: true });
    expect(after).toMatchObject({ intakeStatus: "ready", descriptionIsFull: false, intake: { partial: true, reason: "site_browser", site: "seek" } });
    expect(after.intakeError).toMatch(/^\[full_posting_unavailable\]/);
    expect(getJob(db, userId, job.id)!.analysisId).toBe(job.analysisId);
  });
});
