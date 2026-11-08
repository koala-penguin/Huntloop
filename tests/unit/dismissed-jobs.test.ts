import { eq, sql } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dismissedJobs, jobs } from "@/server/db/schema";
import { createJob, dedupeKeyFor, deleteJob, deleteJobs } from "@/server/repo/jobs";
import { isDismissed } from "@/server/repo/dismissed";
import { bulkDeleteJobs } from "@/server/jobs/bulk-delete";
import { importJob } from "@/server/jobs/intake";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createSearch } from "@/server/search/tasks";
import { runSearch } from "@/server/search/run";
import { addWatch, checkWatch, importMatches, importOpening, listWatches } from "@/server/watchlist/watchlist";
import type { JsonFetcher } from "@/server/sources/ats";
import { canonicalizeUrl } from "@/server/ingest/domain-policy";
import { defaultPreferences, type Preferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";

type Db = ReturnType<typeof testDb>["db"];

const NOW = new Date("2026-10-12T00:00:00Z");
const fixture = (...parts: string[]) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", ...parts), "utf8"));
const adzuna = async () => fixture("api", "adzuna-search.json");
const saved = { dir: process.env.HUNTLOOP_DATA_DIR, id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };

beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-dismissed-"));
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

const prefs = (): Preferences => ({
  ...defaultPreferences(),
  targetTitles: ["Frontend Engineer"],
  markets: [{ country: "AU", primary: true, cities: ["Sydney"], remoteOk: true }],
});

function setup() {
  const { db, userId } = testDb();
  saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({ skills: [{ name: "React", category: "framework" }, { name: "TypeScript", category: "language" }] }, [right("AU", "citizen", "au_citizen")]) });
  savePreferences(db, userId, prefs());
  return { db, userId, ctx: { db, userId } };
}

const tombstones = (db: Db) => db.select().from(dismissedJobs).all();

describe("deleting a job remembers it", () => {
  it("writes one entry per deleted job with its listing link and labels", () => {
    const { db, userId } = testDb();
    const a = createJob(db, userId, {
      source: "url",
      sourceUrl: "https://example.com/jobs/1",
      applyUrl: "https://acme.example/apply/1",
      title: "Data Lead",
      companyName: "Acme",
      dedupeKey: "acme|data lead|sydney",
    });
    const kept = createJob(db, userId, { source: "url", sourceUrl: "https://example.com/jobs/2", title: "Engineer", status: "applied" });
    const result = bulkDeleteJobs(db, userId, { ids: [a.id, kept.id] });
    expect(result.body).toMatchObject({ deleted: [a.id], skipped: [{ id: kept.id, reason: "in_progress" }] });
    const rows = tombstones(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, sourceUrl: "https://example.com/jobs/1", title: "Data Lead", companyName: "Acme" });
    expect(rows[0].deletedAt).toBeInstanceOf(Date);
  });

  it("works for single delete; a job without a link isn't remembered", () => {
    const { db, userId } = testDb();
    const a = createJob(db, userId, { source: "url", sourceUrl: "https://example.com/jobs/1" });
    const pasted = createJob(db, userId, { source: "paste", rawText: "x", title: "Frontend Engineer", companyName: "Acme", dedupeKey: "acme|frontend engineer|sydney" });
    deleteJob(db, userId, a.id);
    deleteJob(db, userId, pasted.id);
    expect(tombstones(db)).toEqual([expect.objectContaining({ sourceUrl: "https://example.com/jobs/1" })]);
  });

  it("writes nothing when the delete rolls back", () => {
    const { db, userId } = testDb();
    const a = createJob(db, userId, { source: "url", sourceUrl: "https://example.com/jobs/1" });
    const b = createJob(db, userId, { source: "url", sourceUrl: "https://example.com/jobs/2" });
    db.run(sql.raw(`CREATE TRIGGER fail_second BEFORE DELETE ON jobs WHEN OLD.id = ${b.id} BEGIN SELECT RAISE(ABORT, 'boom'); END;`));
    expect(() => deleteJobs(db, userId, [a.id, b.id], { includeInProgress: true })).toThrow();
    expect(tombstones(db)).toHaveLength(0);
  });

  it("matches by the listing link only, per user", () => {
    const { db, userId } = testDb();
    // The apply link can be a generic careers page: it must not hide other listings there.
    const a = createJob(db, userId, { source: "url", sourceUrl: "https://example.com/jobs/1", applyUrl: "https://acme.example/careers", dedupeKey: "k1" });
    deleteJob(db, userId, a.id);
    expect(isDismissed(db, userId, "https://example.com/jobs/1")).toBe(true);
    expect(isDismissed(db, userId, "https://acme.example/careers")).toBe(false);
    expect(isDismissed(db, userId, "https://example.com/jobs/2")).toBe(false);
    expect(isDismissed(db, userId, null)).toBe(false);
    expect(isDismissed(db, userId + 1, "https://example.com/jobs/1")).toBe(false);
  });
});

describe("a search after deleting", () => {
  it("doesn't bring deleted jobs back by link, and says how many it skipped", async () => {
    const { db, userId, ctx } = setup();
    const { searchId, taskId } = createSearch(db, userId, "frontend engineer in Sydney");
    const first = await runSearch(ctx, searchId, { taskId, now: NOW, enrich: false, adzunaFetcher: adzuna });
    expect(first.screened).toBe(4);
    const ids = db.select({ id: jobs.id }).from(jobs).all().map((r) => r.id);
    deleteJobs(db, userId, ids, { includeInProgress: true });

    const second = await runSearch(ctx, searchId, { taskId: 999, now: NOW, enrich: false, adzunaFetcher: adzuna });
    expect(second).toMatchObject({ known: 0, screened: 0 });
    expect(second.filtered.previously_deleted).toBe(4);
    expect(second.rejected!.filter((r) => r.reason === "previously_deleted")).toHaveLength(4);
    expect(db.select().from(jobs).all()).toHaveLength(0);
  });

  it("shows a repost again: same company + title + place under a new link isn't skipped", async () => {
    const { db, userId, ctx } = setup();
    // The first Adzuna result, deleted when it was listed under another link (the old ad).
    const key = dedupeKeyFor("Bright Harbour Health", "Senior Frontend Engineer", "Sydney");
    const old = createJob(db, userId, { source: "url", sourceUrl: "https://elsewhere.example/job/9", companyName: "Bright Harbour Health", dedupeKey: key });
    deleteJob(db, userId, old.id);
    const { searchId, taskId } = createSearch(db, userId, "frontend engineer in Sydney");
    const summary = await runSearch(ctx, searchId, { taskId, now: NOW, enrich: false, adzunaFetcher: adzuna });
    expect(summary.filtered.previously_deleted ?? 0).toBe(0);
    expect(summary.screened).toBe(4);
    expect(db.select().from(jobs).all().some((j) => j.sourceUrl?.includes("4901234567"))).toBe(true);
  });

  it("doesn't hide a lead at a deleted job's generic apply link", async () => {
    const { db, userId, ctx } = setup();
    const lead = "https://www.adzuna.com.au/land/ad/4901234568?se=abc";
    const old = createJob(db, userId, { source: "url", sourceUrl: "https://elsewhere.example/job/9", applyUrl: canonicalizeUrl(lead) });
    deleteJob(db, userId, old.id);
    const { searchId, taskId } = createSearch(db, userId, "frontend engineer in Sydney");
    const summary = await runSearch(ctx, searchId, { taskId, now: NOW, enrich: false, adzunaFetcher: adzuna });
    expect(summary.filtered.previously_deleted ?? 0).toBe(0);
    expect(db.select().from(jobs).all().some((j) => j.sourceUrl === canonicalizeUrl(lead))).toBe(true);
  });

  it("lists other left-out leads before deleted ones", async () => {
    const { db, userId, ctx } = setup();
    const { searchId, taskId } = createSearch(db, userId, "frontend engineer in Sydney");
    await runSearch(ctx, searchId, { taskId, now: NOW, enrich: false, adzunaFetcher: adzuna });
    deleteJobs(db, userId, db.select({ id: jobs.id }).from(jobs).all().map((r) => r.id), { includeInProgress: true });
    const second = await runSearch(ctx, searchId, { taskId: 999, now: NOW, enrich: false, adzunaFetcher: adzuna });
    const reasons = second.rejected!.map((r) => r.reason);
    expect(reasons.indexOf("previously_deleted")).toBeGreaterThan(reasons.lastIndexOf("too_old"));
    expect(reasons.slice(reasons.indexOf("previously_deleted")).every((r) => r === "previously_deleted")).toBe(true);
  });
});

describe("importing a deleted job by hand", () => {
  it("adds it again and forgets the deletion", async () => {
    const { db, userId, ctx } = setup();
    const url = "https://www.adzuna.com.au/land/ad/4901234568?se=abc";
    const { searchId, taskId } = createSearch(db, userId, "frontend engineer in Sydney");
    await runSearch(ctx, searchId, { taskId, now: NOW, enrich: false, adzunaFetcher: adzuna });
    const job = db.select().from(jobs).all().find((j) => j.sourceUrl?.includes("4901234568"))!;
    deleteJob(db, userId, job.id);
    expect(tombstones(db)).toHaveLength(1);

    const imported = await importJob(db, userId, { url });
    expect(imported.duplicate).toBe(false);
    expect(db.select().from(jobs).where(eq(jobs.id, imported.jobId)).get()?.sourceUrl).toBe(job.sourceUrl);
    expect(tombstones(db)).toHaveLength(0);

    // The next run finds it as a known job, not a deleted one.
    const next = await runSearch(ctx, searchId, { taskId: 999, now: NOW, enrich: false, adzunaFetcher: adzuna });
    expect(next.filtered.previously_deleted ?? 0).toBe(0);
    expect(next.known).toBe(4);
  });
});

describe("watched boards after deleting", () => {
  const board = {
    jobs: [
      { id: 101, title: "Senior Frontend Engineer", absolute_url: "https://acme.example/careers?gh_jid=101", location: { name: "Sydney, Australia" }, updated_at: "2026-10-10T00:00:00Z" },
      { id: 105, title: "Frontend Engineer", absolute_url: "https://acme.example/careers?gh_jid=105", location: { name: "Sydney, Australia" }, updated_at: "2026-10-10T00:00:00Z" },
    ],
  };
  const fetchJson = (async () => board) as unknown as JsonFetcher;
  const now = new Date("2026-10-13T00:00:00Z");

  it("'Assess matches' skips openings the user deleted; adding one by hand still works", async () => {
    const { db, userId } = setup();
    const watch = addWatch(db, userId, { url: "https://boards.greenhouse.io/acme" }, now);
    await checkWatch(db, userId, watch.id, { fetchJson, now });
    expect(await importMatches(db, userId, watch.id, 5)).toBe(2);
    const opening = listWatches(db, userId, now)[0].openings.find((o) => o.externalId === "101")!;
    deleteJob(db, userId, opening.jobId!);

    const after = listWatches(db, userId, now)[0].openings.find((o) => o.externalId === "101")!;
    expect(after).toMatchObject({ jobId: null, dismissed: true });
    expect(await importMatches(db, userId, watch.id, 5)).toBe(0);

    const { jobId } = await importOpening(db, userId, opening.id);
    expect(jobId).toBeGreaterThan(0);
    expect(listWatches(db, userId, now)[0].openings.find((o) => o.externalId === "101")).toMatchObject({ jobId, dismissed: false });
    expect(tombstones(db)).toHaveLength(0);
  });
});
