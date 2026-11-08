import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tasks } from "@/server/db/schema";
import { classifyBlock } from "@/server/browser/challenge";
import { closeBrowser } from "@/server/browser/service";
import { seekAdapter, seekDateRange, seekSearchUrl } from "@/server/sources/browser/seek";
import { createLinkedinAdapter, linkedinSearchUrl, linkedinTimeRange } from "@/server/sources/browser/linkedin";
import { runSiteSearch, readJobPage, type BrowserRunContext } from "@/server/sources/browser/common";
import { sourceDetail } from "@/server/sources/browser";
import { answerTask, enqueueTask, getTask, waitForUserOnTask } from "@/server/tasks/runner";
import { saveSourceSettings } from "@/server/repo/settings";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createJob } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { defaultSourceSettings, normalizeSourceSettings } from "@/shared/source-settings";
import { filtersFromPreferences, type SearchFilters } from "@/shared/schemas/search";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";
import { startFixtureSites } from "../fixtures/browser/sites.mjs";

const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const hasChromium = fs.existsSync(CHROMIUM);
const saved = { ...process.env };
let sites: { url: string; state: Record<string, unknown> & { requests: string[] }; close: () => Promise<void> };

beforeAll(async () => {
  sites = await startFixtureSites();
  Object.assign(process.env, {
    HUNTLOOP_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-browser-")),
    HUNTLOOP_BROWSER_PATH: CHROMIUM,
    HUNTLOOP_BROWSER_HEADLESS: "1",
    HUNTLOOP_BROWSER_PACING_MS: "0",
    HUNTLOOP_SEEK_BASE_URL: sites.url,
    HUNTLOOP_LINKEDIN_BASE_URL: sites.url,
    // CAPTCHA alerts go to the fixture server's stand-in webhook, never a real one.
    HUNTLOOP_DISCORD_WEBHOOK: `${sites.url}/__webhook`,
  });
});
afterAll(async () => {
  await closeBrowser();
  await sites.close();
  for (const key of ["HUNTLOOP_DATA_DIR", "HUNTLOOP_BROWSER_PATH", "HUNTLOOP_BROWSER_HEADLESS", "HUNTLOOP_BROWSER_PACING_MS", "HUNTLOOP_SEEK_BASE_URL", "HUNTLOOP_LINKEDIN_BASE_URL", "HUNTLOOP_DISCORD_WEBHOOK"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
beforeEach(async () => {
  await fetch(`${sites.url}/__reset`);
});

const filters = (patch: Partial<SearchFilters> = {}): SearchFilters => ({
  ...filtersFromPreferences({ ...defaultPreferences(), targetTitles: ["Frontend Engineer"], markets: [{ country: "AU", primary: true, cities: ["Sydney"], remoteOk: true }] }),
  postedWithinDays: 7,
  ...patch,
});

describe("search URLs", () => {
  it("builds SEEK searches from filters", () => {
    delete process.env.HUNTLOOP_SEEK_BASE_URL;
    try {
      const url = new URL(seekSearchUrl(filters({ salaryMin: 150000, employmentTypes: ["full_time", "contract"] }), { country: "AU", city: "Sydney" }, "Frontend Engineer", 1));
      expect(url.origin).toBe("https://www.seek.com.au");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        keywords: "Frontend Engineer",
        where: "Sydney",
        daterange: "7",
        worktype: "242,244",
        salaryrange: "150000-",
        salarytype: "annual",
        page: "2",
      });
      expect(new URL(seekSearchUrl(filters(), { country: "NZ", city: null }, "Frontend Engineer", 0)).origin).toBe("https://www.seek.co.nz");
      expect(seekDateRange(10)).toBe("14");
      expect(seekAdapter.queries(filters({ locations: [{ country: "SG", city: null }] }))).toHaveLength(0);
    } finally {
      process.env.HUNTLOOP_SEEK_BASE_URL = sites.url;
    }
  });

  it("builds LinkedIn guest searches from filters", () => {
    delete process.env.HUNTLOOP_LINKEDIN_BASE_URL;
    try {
      const url = new URL(linkedinSearchUrl(filters({ workplace: ["hybrid", "remote"] }), { country: "AU", city: "Sydney" }, "Frontend Engineer", 2));
      expect(url.href.startsWith("https://www.linkedin.com/jobs/search?")).toBe(true);
      expect(Object.fromEntries(url.searchParams)).toMatchObject({ keywords: "Frontend Engineer", location: "Sydney, Australia", f_TPR: "r604800", f_WT: "3,2", f_JT: "F", start: "50" });
      expect(linkedinTimeRange(30)).toBe("r2592000");
    } finally {
      process.env.HUNTLOOP_LINKEDIN_BASE_URL = sites.url;
    }
  });

  it("recognises job links and keeps the public URL", () => {
    const li = createLinkedinAdapter({ useLogin: false });
    expect(li.jobIdFromUrl(new URL("https://www.linkedin.com/jobs/view/senior-dev-at-acme-4011223344?refId=x"))).toBe("4011223344");
    expect(li.jobIdFromUrl(new URL("https://www.linkedin.com/jobs/collections/recommended/"))).toBeNull();
    expect(seekAdapter.jobIdFromUrl(new URL("https://www.seek.com.au/job/81234567?type=standout"))).toBe("81234567");
    expect(seekAdapter.jobIdFromUrl(new URL("https://www.seek.com.au/jobs?keywords=x"))).toBeNull();
    expect(seekAdapter.jobUrl("81234567", new URL("https://www.seek.co.nz/job/81234567")).canonical).toBe("https://www.seek.co.nz/job/81234567");
  });

  it("classifies CAPTCHAs, sign-in walls and checkpoints", () => {
    expect(classifyBlock("https://www.seek.com.au/job/1", "Just a moment...", "Checking your browser")).toBe("captcha");
    expect(classifyBlock("https://www.linkedin.com/authwall?trk=x", "LinkedIn", "")).toBe("login");
    expect(classifyBlock("https://www.linkedin.com/checkpoint/challenge/abc", "Security check", "")).toBe("checkpoint");
    expect(classifyBlock("https://www.seek.com.au/job/1", "Frontend Engineer - SEEK", "A long job description ".repeat(50))).toBeNull();
  });

  it("says why a browser site found nothing", () => {
    const stats = (patch: Partial<{ resultPages: number; jobLinks: number; blocked: boolean; jobPagesRead: number }>) => ({ resultPages: 1, jobLinks: 0, blocked: false, jobPagesRead: 0, ...patch });
    expect(sourceDetail(stats({ jobLinks: 4 }), 3)).toBeUndefined();
    expect(sourceDetail(stats({ blocked: true }), 2)).toBeUndefined();
    expect(sourceDetail(stats({ resultPages: 0 }), 0)).toBeUndefined();
    expect(sourceDetail(stats({ blocked: true }), 0)).toBe("blocked_skipped");
    expect(sourceDetail(stats({ resultPages: 2 }), 0)).toBe("no_job_links");
    expect(sourceDetail(stats({ jobLinks: 5, jobPagesRead: 5 }), 0)).toBe("pages_unreadable");
  });

  it("treats LinkedIn's country subdomains as the same site", () => {
    const li = createLinkedinAdapter({ useLogin: false });
    expect(li.sameSite!(new URL("https://au.linkedin.com/jobs/view/1"), new URL("https://www.linkedin.com/jobs/search"))).toBe(true);
    expect(li.sameSite!(new URL("https://linkedin.com.evil.example/jobs/view/1"), new URL("https://www.linkedin.com/jobs/search"))).toBe(false);
    expect(li.sameSite!(new URL("http://127.0.0.1:3299/jobs/view/1"), new URL("http://127.0.0.1:3299/jobs/search"))).toBe(true);
    expect(li.sameSite!(new URL("http://127.0.0.1:4000/jobs/view/1"), new URL("http://127.0.0.1:3299/jobs/search"))).toBe(false);
  });

  it("can't be turned on without accepting the risk notice", () => {
    const settings = defaultSourceSettings();
    settings.seek.enabled = true;
    expect(normalizeSourceSettings(settings).seek.enabled).toBe(false);
    settings.seek.acceptedRiskAt = "2026-10-13";
    expect(normalizeSourceSettings(settings).seek.enabled).toBe(true);
  });
});

describe.skipIf(!hasChromium)("browser adapters (headless Chromium against local pages)", () => {
  const ctx = (patch: Partial<BrowserRunContext> = {}): BrowserRunContext => ({ maxPages: 25, ...patch });

  it("SEEK: harvests job links across pages until results run out, then reads each job", async () => {
    const leads = await runSiteSearch(seekAdapter, filters(), ctx());
    expect(leads.map((l) => l.sourceId)).toEqual(["81000001", "81000002", "81000003"]);
    expect(leads.every((l) => l.source === "seek" && l.full && l.url.startsWith("https://www.seek.com.au/job/"))).toBe(true);
    // JSON-LD page and plain page are both read.
    expect(leads[0]).toMatchObject({ title: "Senior Frontend Engineer", company: "Harbour Lights Health", country: "AU" });
    expect(leads[0].text).toContain("Strong React and TypeScript skills");
    expect(leads[1]).toMatchObject({ title: "Frontend Developer", company: "Koala Retail", location: "Sydney NSW", salaryText: "$130,000 – $145,000 + super" });
    expect(leads[1].text).toContain("e-commerce platforms is desirable");
    // Results pages 1–3 (3 is empty → stop), then 3 job pages; nothing off-site.
    const searches = sites.state.requests.filter((r) => r.startsWith("/jobs?"));
    expect(searches).toHaveLength(3);
    expect(searches[0]).toContain("keywords=Frontend+Engineer");
    expect(sites.state.requests.filter((r) => r.startsWith("/job/"))).toHaveLength(3);
  });

  it("respects the page cap", async () => {
    const leads = await runSiteSearch(seekAdapter, filters(), ctx({ maxPages: 2 }));
    expect(leads).toHaveLength(2);
    expect(sites.state.requests.filter((r) => r.startsWith("/jobs?"))).toHaveLength(1);
  });

  it("pauses on a CAPTCHA until the user solves it", async () => {
    await fetch(`${sites.url}/__captcha?on=1`);
    const waits: unknown[] = [];
    const leads = await runSiteSearch(seekAdapter, filters(), ctx({
      waitForUser: async (reason, isResolved) => {
        waits.push(reason);
        expect(await isResolved()).toBe(false);
        await fetch(`${sites.url}/__solve`); // the user solves it in the window
        return "resolved";
      },
    }));
    expect(waits).toEqual([expect.objectContaining({ kind: "captcha", site: "seek" })]);
    expect(leads.map((l) => l.sourceId)).toContain("81000003");
    // The pause was recorded (screenshot + count) and sent to the webhook with the screenshot.
    const events = path.join(process.env.HUNTLOOP_DATA_DIR!, "captcha-events");
    const counts = JSON.parse(fs.readFileSync(path.join(events, "counts.json"), "utf8"));
    expect(counts.seek.byKind.captcha).toBeGreaterThanOrEqual(1);
    expect(fs.readdirSync(events).some((f) => f.endsWith("-seek-captcha.png"))).toBe(true);
    const webhooks = sites.state.webhooks as Array<{ contentType: string }>;
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].contentType).toMatch(/^multipart\/form-data/);
  });

  it("stops the site when the user skips, keeping what was read", async () => {
    await fetch(`${sites.url}/__captcha?on=1`);
    const stats = { resultPages: 0, jobLinks: 0, blocked: false, jobPagesRead: 0 };
    const leads = await runSiteSearch(seekAdapter, filters(), ctx({ waitForUser: async () => "skipped", stats }));
    expect(leads.map((l) => l.sourceId)).toEqual(["81000001", "81000002"]);
    // A skipped check on a job page counts as blocked, not as "no job links".
    expect(stats.blocked).toBe(true);
  });

  it("LinkedIn guest mode: reads public job pages; a sign-in wall pauses for the user", async () => {
    await fetch(`${sites.url}/__authwall?on=1`);
    const reasons: unknown[] = [];
    const leads = await runSiteSearch(createLinkedinAdapter({ useLogin: false }), filters(), ctx({
      waitForUser: async (reason) => {
        reasons.push(reason);
        return "skipped";
      },
    }));
    expect(leads.map((l) => [l.sourceId, l.company])).toEqual([["3900000001", "Tidal Labs"]]);
    expect(leads[0].url).toBe("https://www.linkedin.com/jobs/view/3900000001");
    expect(reasons).toEqual([expect.objectContaining({ kind: "login", site: "linkedin" })]);
  });

  it("LinkedIn with the user's login: waits for them to sign in first", async () => {
    let asked = 0;
    const leads = await runSiteSearch(createLinkedinAdapter({ useLogin: true }), filters(), ctx({
      waitForUser: async (reason) => {
        asked++;
        expect(reason).toMatchObject({ kind: "login", site: "linkedin" });
        await fetch(`${sites.url}/__signin`); // signs in by hand in the window
        return "resolved";
      },
    }));
    expect(asked).toBe(1);
    expect(leads).toHaveLength(2);
  });

  it("LinkedIn with the user's login: skipping the sign-in skips the site and says so", async () => {
    const stats = { resultPages: 0, jobLinks: 0, blocked: false, jobPagesRead: 0 };
    const leads = await runSiteSearch(createLinkedinAdapter({ useLogin: true }), filters(), ctx({ waitForUser: async () => "skipped", stats }));
    expect(leads).toEqual([]);
    expect(stats.blocked).toBe(true);
  });

  it("without someone to ask (no task), a blocked site is skipped", async () => {
    await fetch(`${sites.url}/__captcha?on=1`);
    const page = await readJobPage(seekAdapter, new URL("https://www.seek.com.au/job/81000003"), {});
    expect(page).toBeNull();
    const ok = await readJobPage(seekAdapter, new URL("https://www.seek.com.au/job/81000002"), {});
    expect(ok?.hints.company).toBe("Koala Retail");
  });

  it("SEEK contact details masked for logged-out visitors are read in full", async () => {
    const page = await readJobPage(seekAdapter, new URL("https://www.seek.com.au/job/81000004"), {});
    expect(page?.text).toContain("HR Direct on 1800 989 696.");
    expect(page?.text).toContain("Email Jane.Citizen@banksia.example or call +61 3 9000 1234.");
    // No data-contact-match: the value comes from the link.
    expect(page?.text).toContain("Applications to careers@banksia.example.");
    expect(page?.text).not.toContain("•");
  });

  it("a pasted SEEK link is read in the browser once SEEK is turned on", async () => {
    const { db, userId } = testDb();
    saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
    savePreferences(db, userId, defaultPreferences());
    const job = createJob(db, userId, { source: "url", sourceUrl: "https://www.seek.com.au/job/81000001" });
    expect((await processJob({ db, userId }, job)).intakeStatus).toBe("needs_content");

    const settings = defaultSourceSettings();
    settings.seek = { enabled: true, acceptedRiskAt: "2026-10-13", maxPages: 25 };
    saveSourceSettings(db, userId, settings);
    const done = await processJob({ db, userId }, job);
    expect(done).toMatchObject({ intakeStatus: "ready", source: "seek", companyName: "Harbour Lights Health", descriptionIsFull: true });
  });
});

describe("waiting for the user in a task", () => {
  it("pauses the task, then continues, skips or cancels on the user's answer", async () => {
    const { db, userId } = testDb();
    const task = enqueueTask(db, userId, "search", {});
    db.update(tasks).set({ status: "running" }).run();

    let resolved = false;
    const waiting = waitForUserOnTask(db, task.id, { kind: "captcha", site: "seek" }, async () => resolved, { pollMs: 10, currentProgress: { stage: "sourcing" } });
    await new Promise((r) => setTimeout(r, 30));
    expect(getTask(db, task.id)).toMatchObject({ status: "needs_user_action", progress: { stage: "sourcing", action: { kind: "captcha", site: "seek" } } });
    resolved = true;
    expect(await waiting).toBe("resolved");
    expect(getTask(db, task.id)).toMatchObject({ status: "running", progress: { stage: "sourcing" } });

    const skipping = waitForUserOnTask(db, task.id, { kind: "login" }, async () => false, { pollMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    expect(answerTask(db, task.id, "skip")).toBe(true);
    expect(await skipping).toBe("skipped");

    const cancelled = waitForUserOnTask(db, task.id, { kind: "login" }, async () => false, { pollMs: 10 });
    await new Promise((r) => setTimeout(r, 30));
    db.update(tasks).set({ status: "cancelled" }).run();
    await expect(cancelled).rejects.toThrow("Task cancelled");
    expect(answerTask(db, task.id, "continue")).toBe(false);
  });
});
