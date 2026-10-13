import { describe, expect, it } from "vitest";
import { checkPostingOpen, closedNotice } from "@/server/search/liveness";
import { FetchBlockedError } from "@/server/ingest/safe-fetch";
import { searchWithAgent } from "@/server/ai/tasks/search-agent";
import "@/server/ai/fake/generators/search";
import { filtersFromPreferences } from "@/shared/schemas/search";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";

const NOW = new Date("2026-10-13T00:00:00Z");
const page = (html: string, status = 200) => (async () => new Response(html, { status, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
const resolve = { now: NOW, resolve: async () => ["93.184.216.34"] };
const BODY = `<main><h1>Head of Data</h1><p>${"Lead our data platform, analytics and governance across the business. ".repeat(6)}</p></main>`;

describe("is the posting still open?", () => {
  it("recognises closed-posting notices, and not closing-date announcements", () => {
    expect(closedNotice("Head of Data … This vacancy has now expired. Please see similar roles below.")).toBeTruthy();
    expect(closedNotice("Sorry, this job is no longer available")).toBeTruthy();
    expect(closedNotice("Sorry, this job advertisement is no longer available.")).toBeTruthy();
    expect(closedNotice("The position has been filled.")).toBeTruthy();
    expect(closedNotice("We are no longer accepting applications for this role")).toBeTruthy();
    expect(closedNotice("Applications close on 30 October 2026. Apply now!")).toBeNull();
    expect(closedNotice("You will no longer be limited by legacy systems.")).toBeNull();
  });

  it("drops pages that are gone, show an expired notice, or passed their closing date", async () => {
    expect(await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: page("Not found", 404) })).toEqual({ status: "closed", reason: "gone" });
    expect(await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: page("Gone", 410) })).toEqual({ status: "closed", reason: "gone" });
    expect(await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: page(`<main><h1>Head of Data</h1><p>This vacancy has now expired.</p>${BODY}</main>`) })).toEqual({ status: "closed", reason: "notice" });
    const ld = (validThrough: string) =>
      `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Head of Data", description: BODY, validThrough, hiringOrganization: { name: "Acme" } })}</script>`;
    expect(await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: page(ld("2026-09-30")) })).toEqual({ status: "closed", reason: "past_closing_date" });
    const open = await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: page(ld("2026-11-30")) });
    expect(open).toMatchObject({ status: "open", hints: { title: "Head of Data", company: "Acme" } });
  });

  it("treats an applicant-tracking 404 as closed and anything unreadable as unknown", async () => {
    const atsGone = async () => {
      throw new FetchBlockedError("http_error", "HTTP 404", "https://api.lever.co/v0/postings/acme/x", 404);
    };
    expect(await checkPostingOpen("https://jobs.lever.co/acme/0f0e0d0c-0b0a-4908-8706-050403020100", { ...resolve, fetchJson: atsGone })).toEqual({ status: "closed", reason: "gone" });
    expect(await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: page("Forbidden", 403) })).toEqual({ status: "unknown" });
    expect(await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: page("<title>Just a moment...</title>") })).toEqual({ status: "unknown" });
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkPostingOpen("https://careers.example.com/jobs/1", { ...resolve, fetchImpl: offline })).toEqual({ status: "unknown" });
  });

  it("the search agent keeps only leads that are still open, with their full text", async () => {
    const { db, userId } = testDb();
    const filters = filtersFromPreferences({ ...defaultPreferences(), targetTitles: ["Frontend Engineer"] });
    const result = await searchWithAgent({ db, userId }, { filters, candidate: null }, undefined, NOW, {
      // The demo agent reports a Greenhouse and a Lever job: one has closed, one is open.
      fetchJson: async (url) => {
        if (url.includes("lever")) throw new FetchBlockedError("http_error", "HTTP 404", url, 404);
        return { id: 7001001, title: "Senior Frontend Engineer", content: `&lt;p&gt;${"Build our design tools with React and TypeScript. ".repeat(8)}&lt;/p&gt;`, location: { name: "Sydney, Australia" }, absolute_url: "https://job-boards.greenhouse.io/demo-tidewater/jobs/7001001" };
      },
    });
    expect(result.closed).toBe(1);
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({ url: "https://job-boards.greenhouse.io/demo-tidewater/jobs/7001001", full: true });
    expect(result.leads[0].text).toContain("React and TypeScript");
  });
});
