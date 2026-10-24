import { describe, expect, it } from "vitest";
import { detectAtsBoard, fetchAtsBoardJobs, type JsonFetcher } from "@/server/sources/ats";
import { addWatch, checkWatch, distinctiveTitleMatch, guessCountry, importMatches, listWatches } from "@/server/watchlist/watchlist";
import { runDueWork } from "@/server/tasks/scheduler";
import { saveSearch } from "@/server/search/tasks";
import { savePreferences } from "@/server/repo/profile";
import { getAiSettings, saveAiSettings } from "@/server/repo/settings";
import { logUsage } from "@/server/repo/usage";
import { searches, tasks } from "@/server/db/schema";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";

const GREENHOUSE = {
  jobs: [
    { id: 101, title: "Senior Frontend Engineer", absolute_url: "https://acme.example/careers?gh_jid=101", location: { name: "Sydney, Australia" }, updated_at: "2026-10-10T00:00:00Z" },
    { id: 102, title: "Account Executive", absolute_url: "https://acme.example/careers?gh_jid=102", location: { name: "Sydney, Australia" }, updated_at: "2026-10-10T00:00:00Z" },
    { id: 103, title: "Frontend Engineer", absolute_url: "https://acme.example/careers?gh_jid=103", location: { name: "Austin, TX" }, updated_at: "2026-10-10T00:00:00Z" },
  ],
};
const LEVER = [{ id: "0f6b1c2e-1111-4a8b-9c3d-123456789abc", text: "Frontend Developer", hostedUrl: "https://jobs.lever.co/tidal/0f6b1c2e-1111-4a8b-9c3d-123456789abc", categories: { team: "Engineering", location: "Melbourne" }, createdAt: 1760000000000 }];
const ASHBY = { jobs: [{ id: "a1b2c3d4-0000-4000-8000-000000000001", title: "Staff Frontend Engineer", jobUrl: "https://jobs.ashbyhq.com/reef/a1b2c3d4-0000-4000-8000-000000000001", department: "Product", location: "Remote", isRemote: true, publishedAt: "2026-10-01T00:00:00Z" }] };

const fetcher = (data: unknown): JsonFetcher & { urls: string[] } => {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    return data;
  }) as JsonFetcher & { urls: string[] };
  fn.urls = urls;
  return fn;
};

const now = new Date("2026-10-13T00:00:00Z");

function setup() {
  const { db, userId } = testDb();
  savePreferences(db, userId, { ...defaultPreferences(), targetTitles: ["Frontend Engineer"], markets: [{ country: "AU", primary: true, cities: ["Sydney"], remoteOk: true }] });
  return { db, userId };
}

describe("job boards", () => {
  it("recognises board and job links for each ATS", () => {
    expect(detectAtsBoard(new URL("https://boards.greenhouse.io/acme"))).toEqual({ type: "greenhouse", board: "acme", eu: false });
    expect(detectAtsBoard(new URL("https://job-boards.eu.greenhouse.io/acme/jobs/123"))).toEqual({ type: "greenhouse", board: "acme", eu: true });
    expect(detectAtsBoard(new URL("https://jobs.lever.co/tidal"))).toEqual({ type: "lever", board: "tidal", eu: false });
    expect(detectAtsBoard(new URL("https://jobs.ashbyhq.com/reef/a1b2c3d4-0000-4000-8000-000000000001"))).toEqual({ type: "ashby", board: "reef", eu: false });
    expect(detectAtsBoard(new URL("https://www.seek.com.au/acme"))).toBeNull();
  });

  it("lists every open role with an importable ATS link", async () => {
    const gh = await fetchAtsBoardJobs("greenhouse", "acme", false, fetcher(GREENHOUSE));
    expect(gh[0]).toMatchObject({ id: "101", title: "Senior Frontend Engineer", location: "Sydney, Australia", atsUrl: "https://job-boards.greenhouse.io/acme/jobs/101" });
    const lever = await fetchAtsBoardJobs("lever", "tidal", true, fetcher(LEVER));
    expect(lever[0]).toMatchObject({ department: "Engineering", atsUrl: "https://jobs.eu.lever.co/tidal/0f6b1c2e-1111-4a8b-9c3d-123456789abc" });
    const ashby = await fetchAtsBoardJobs("ashby", "reef", false, fetcher(ASHBY));
    expect(ashby[0]).toMatchObject({ title: "Staff Frontend Engineer", location: "Remote", department: "Product" });
  });

  it("needs a distinctive title word in common, not just 'engineer'", () => {
    expect(distinctiveTitleMatch("Senior Frontend Engineer", ["Frontend Engineer"])).toBe(true);
    expect(distinctiveTitleMatch("Mechanical Engineer", ["Senior Frontend Engineer"])).toBe(false);
    expect(distinctiveTitleMatch("Anything", ["Senior Engineer"])).toBe(true);
  });

  it("guesses the country of free-text locations", () => {
    expect(guessCountry("Sydney, Australia")).toBe("AU");
    expect(guessCountry("Melbourne VIC")).toBe("AU");
    expect(guessCountry("Austin, TX")).toBe("US");
    expect(guessCountry("Auckland")).toBe("NZ");
    expect(guessCountry("Remote")).toBeNull();
    const cases: Array<[string, string | null]> = [
      ["Indianapolis, IN", "US"],
      ["Indiana", "US"],
      ["Jersey City, NJ", "US"],
      ["Atlanta, Georgia", null],
      ["Georgia", null],
      ["Albuquerque, New Mexico", "US"],
      ["Albuquerque New Mexico", "US"],
      ["Bucharest, Romania", "RO"],
      ["Lagos, Nigeria", "NG"],
      ["Perth, WA", "AU"],
      ["Seattle, WA", "US"],
      ["Spokane, WA", null],
      ["Brisbane QLD", "AU"],
    ];
    for (const [location, country] of cases) expect(guessCountry(location), location).toBe(country);
  });
});

describe("watchlist", () => {
  it("records roles, matches them against preferences in code, and notices new and closed ones", async () => {
    const { db, userId } = setup();
    const watch = addWatch(db, userId, { url: "https://boards.greenhouse.io/acme" }, now);
    expect(addWatch(db, userId, { url: "https://job-boards.greenhouse.io/acme/jobs/1" }, now).id).toBe(watch.id);
    expect(await checkWatch(db, userId, watch.id, { fetchJson: fetcher(GREENHOUSE), now })).toEqual({ total: 3, added: 3, matched: 1, closed: 0 });

    let view = listWatches(db, userId, now)[0];
    expect(view.openings.map((o) => [o.title, o.matched, o.matchReason, o.isNew])).toEqual([
      ["Senior Frontend Engineer", true, null, false],
      ["Account Executive", false, "title_mismatch", false],
      ["Frontend Engineer", false, "outside_markets", false],
    ]);

    // Next day: one role closed, one new matching role appeared.
    const later = new Date(now.getTime() + 86_400_000);
    const next = { jobs: [GREENHOUSE.jobs[0], { ...GREENHOUSE.jobs[0], id: 104, title: "Frontend Engineer, Payments" }, GREENHOUSE.jobs[2]] };
    expect(await checkWatch(db, userId, watch.id, { fetchJson: fetcher(next), now: later })).toMatchObject({ added: 1, closed: 1 });
    view = listWatches(db, userId, later)[0];
    expect(view.openCount).toBe(3);
    expect(view.newMatchedCount).toBe(1);
    expect(view.openings.find((o) => o.isNew)?.title).toBe("Frontend Engineer, Payments");
  });

  it("records a board that can't be reached and tries again tomorrow", async () => {
    const { db, userId } = setup();
    const watch = addWatch(db, userId, { url: "https://jobs.lever.co/gone" }, now);
    const failing: JsonFetcher = async () => {
      throw new Error("HTTP 404");
    };
    await expect(checkWatch(db, userId, watch.id, { fetchJson: failing, now })).rejects.toThrow();
    expect(listWatches(db, userId, now)[0]).toMatchObject({ lastError: "HTTP 404", nextCheckAt: new Date(now.getTime() + 86_400_000) });
  });

  it("imports matching roles as jobs, best first, up to the limit", async () => {
    const { db, userId } = setup();
    const watch = addWatch(db, userId, { url: "https://boards.greenhouse.io/acme" }, now);
    const two = { jobs: [GREENHOUSE.jobs[0], { ...GREENHOUSE.jobs[0], id: 105, title: "Frontend Engineer" }] };
    await checkWatch(db, userId, watch.id, { fetchJson: fetcher(two), now });
    expect(await importMatches(db, userId, watch.id, 1)).toBe(1);
    expect(listWatches(db, userId, now)[0].openings.filter((o) => o.jobId).length).toBe(1);
    expect(await importMatches(db, userId, watch.id, 5)).toBe(1);
  });
});

describe("scheduler", () => {
  it("runs due daily searches (API sources only) and board checks, and skips searches when the budget is tight", () => {
    const { db, userId } = setup();
    const search = db.insert(searches).values({ userId, query: "frontend", sources: ["adzuna", "web_agent", "seek"] }).returning().get();
    saveSearch(db, userId, search.id, { name: "Frontend Sydney", daily: true }, now);
    const watch = addWatch(db, userId, { url: "https://boards.greenhouse.io/acme" }, now);

    // Not due yet: the first daily run is a day after saving. The new watch is due straight away.
    expect(runDueWork(db, now)).toEqual({ searches: [], skippedSearches: [], watches: [watch.id] });
    const tomorrow = new Date(now.getTime() + 86_400_000 + 1000);
    const work = runDueWork(db, tomorrow);
    expect(work.searches).toEqual([search.id]);
    const queued = db.select().from(tasks).all().find((t) => t.kind === "search")!;
    expect(queued.payload).toEqual({ searchId: search.id, scheduled: true });
    // Nothing is queued twice while a run is waiting.
    expect(runDueWork(db, new Date(tomorrow.getTime() + 2 * 86_400_000)).searches).toEqual([]);

    // Over the budget warning: the daily search is skipped and says why.
    db.delete(tasks).run();
    const ai = getAiSettings(db, userId);
    saveAiSettings(db, userId, { ...ai, budget: { ...ai.budget, dailyUsd: 1, warnAtPercent: 80 } });
    logUsage(db, { userId, task: "screen", model: "claude-opus-5-5", servedModel: "claude-opus-5-5", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0.9, simulated: false });
    const skipped = runDueWork(db, new Date(Date.now() + 10 * 86_400_000));
    expect(skipped.skippedSearches).toEqual([search.id]);
    expect(db.select().from(searches).get()!.scheduleNote).toBe("budget");
  });
});
