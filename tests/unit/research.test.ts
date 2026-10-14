import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tasks, usageLog } from "@/server/db/schema";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createJob, getJob } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { getFreshReport, reportDigest, startCompanyResearch } from "@/server/research/company";
import { applyCompanyReportProse, getCachedReportTranslation, translateCompanyReport } from "@/server/jobs/prose";
import { runCompanyResearch } from "@/server/tasks/handlers/company-research";
import { normalizeUrl, verifyReport } from "@/server/ai/tasks/company-research";
import { createJobConversation, listChatMessages, runJobChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import type { TaskRow } from "@/server/db/schema";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-research-"));
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

async function setup() {
  const { db, userId } = testDb();
  const ctx = { db, userId };
  saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
  savePreferences(db, userId, defaultPreferences());
  const job = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING, intake: { noisy: false } }));
  return { db, userId, ctx, job };
}

/** Runs a queued research task the way the runner would. */
async function runTask(db: ReturnType<typeof testDb>["db"], userId: number, taskId: number) {
  const task = db.select().from(tasks).all().find((t) => t.id === taskId) as TaskRow;
  const progress: unknown[] = [];
  const result = await runCompanyResearch({ db, task, userId, payload: task.payload, signal: new AbortController().signal, progress: (p) => progress.push(p) });
  return { result, progress };
}

describe("employer research", () => {
  it("researches, drops claims whose source wasn't seen, and caches the report for 30 days", async () => {
    const { db, userId, job } = await setup();
    expect(job.companyName).toBe("Bright Harbour Health");
    const started = startCompanyResearch(db, userId, job);
    expect(started).toMatchObject({ ok: true, reused: false });
    const { result, progress } = await runTask(db, userId, (started as { taskId: number }).taskId);
    expect(result.droppedClaims).toBe(1);
    expect(progress).toContainEqual(expect.objectContaining({ stage: "researching", notes: expect.arrayContaining(["Searching for the company"]) }));

    const stored = getFreshReport(db, job.companyId!)!;
    expect(stored.report.sections.map((s) => s.key)).toEqual(["business", "activities", "hiring"]);
    expect(stored.report.sections.flatMap((s) => s.claims).every((c) => c.sourceUrl.startsWith("https://www.example.com/"))).toBe(true);
    expect(stored.report.sources).toHaveLength(3);
    expect(stored.report.hiring.trackedJobs).toBe(1);
    expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBe(30 * 86_400_000);

    // A second request within 30 days reuses the report: no new task, no AI call.
    const calls = db.select().from(usageLog).all().length;
    expect(startCompanyResearch(db, userId, job)).toMatchObject({ ok: true, reused: true, taskId: null });
    expect(db.select().from(usageLog).all()).toHaveLength(calls);
    // Refresh forces a new run.
    expect(startCompanyResearch(db, userId, job, { force: true })).toMatchObject({ ok: true, reused: false });
  });

  it("is translated once into the reader's language, keeping sources and dates", async () => {
    const { db, userId, ctx, job } = await setup();
    const started = startCompanyResearch(db, userId, job);
    await runTask(db, userId, (started as { taskId: number }).taskId);
    const stored = getFreshReport(db, job.companyId!)!;
    expect(stored.report.language).toBe("en");

    const prose = await translateCompanyReport(ctx, stored.id, stored.report, "ko");
    const ko = applyCompanyReportProse(stored.report, prose);
    expect(ko.summary).toBe(`[ko] ${stored.report.summary}`);
    const claims = (r: typeof ko) => r.sections.flatMap((s) => s.claims);
    expect(claims(ko).every((c) => c.text.startsWith("[ko] "))).toBe(true);
    expect(claims(ko).map((c) => [c.sourceUrl, c.date])).toEqual(claims(stored.report).map((c) => [c.sourceUrl, c.date]));
    expect(ko.forYou.talkingPoints.every((p) => p.startsWith("[ko] "))).toBe(true);

    // Cached: reading it again costs nothing.
    const calls = db.select().from(usageLog).all().length;
    expect(await translateCompanyReport(ctx, stored.id, stored.report, "ko")).toEqual(prose);
    expect(getCachedReportTranslation(db, stored.id, "ko")).toEqual(prose);
    expect(db.select().from(usageLog).all()).toHaveLength(calls);
  });

  it("does not start twice while a run is queued", async () => {
    const { db, userId, job } = await setup();
    const a = startCompanyResearch(db, userId, job) as { taskId: number };
    const b = startCompanyResearch(db, userId, job) as { taskId: number };
    expect(b.taskId).toBe(a.taskId);
  });

  it("the chat can start research and receives the report when it's ready", async () => {
    const { db, userId, ctx, job } = await setup();
    const conversation = createJobConversation(ctx, job);
    const events: ChatEvent[] = [];
    await runJobChatTurn(ctx, conversation.id, "Can you research the company?", (e) => events.push(e));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "start_company_research" }));
    const task = db.select().from(tasks).all().find((t) => t.kind === "company-research")!;
    await runTask(db, userId, task.id);

    await runJobChatTurn(ctx, conversation.id, "What did you find?", () => {});
    const rows = listChatMessages(ctx, conversation.id);
    const lastUser = rows.filter((r) => r.kind === "user").at(-1)!.content as Array<{ type: string; text?: string }>;
    const update = lastUser.find((b) => b.text?.startsWith("<context_update>"))!;
    expect(update.text).toContain("Employer research has finished");
    expect(update.text).toContain("<employer_research>");
    expect(update.text).toContain("Launched a new platform");
    expect(getJob(db, userId, job.id)!.status).toBe("new");
  });

  it("a conversation started after research includes the report from the beginning", async () => {
    const { db, userId, ctx, job } = await setup();
    const started = startCompanyResearch(db, userId, job) as { taskId: number };
    await runTask(db, userId, started.taskId);
    const conversation = createJobConversation(ctx, job);
    const context = listChatMessages(ctx, conversation.id)[0].content as Array<{ type: string; text?: string }>;
    expect(context.some((b) => b.text?.includes("<employer_research>"))).toBe(true);
  });
});

describe("research helpers", () => {
  it("matches source URLs regardless of tracking parameters, www, trailing slash or fragment", () => {
    expect(normalizeUrl("https://www.Example.com/news/a/?utm_source=x#top")).toBe(normalizeUrl("https://example.com/news/a"));
    expect(normalizeUrl("not a url")).toBeNull();
  });

  it("keeps only claims whose URL was seen and drops empty sections", () => {
    const report = {
      summary: "s",
      facts: { website: null, headquarters: null, founded: null, size: null, ownership: "private" as const, industry: null },
      sections: [
        { key: "business" as const, confidence: "high" as const, claims: [{ text: "ok", sourceUrl: "https://a.com/x", date: null }] },
        { key: "red_flags" as const, confidence: "low" as const, claims: [{ text: "made up", sourceUrl: "https://b.com/y", date: null }] },
      ],
      forYou: { talkingPoints: [], cvAngles: [], questionsToAsk: [], referralAngles: [] },
    };
    const { report: verified, dropped } = verifyReport(report, [{ url: "https://www.a.com/x/" }]);
    expect(dropped).toBe(1);
    expect(verified.sections.map((s) => s.key)).toEqual(["business"]);
  });

  it("summarises a report for the chat", () => {
    const text = reportDigest({
      summary: "Makes widgets.",
      facts: { website: "https://w.com", headquarters: "Sydney", founded: null, size: "200", ownership: "private", industry: "Manufacturing" },
      sections: [{ key: "growth", confidence: "medium", claims: [{ text: "Opened a Melbourne office", sourceUrl: "https://w.com/news", date: "2026-05" }] }],
      forYou: { talkingPoints: [], cvAngles: [], questionsToAsk: [], referralAngles: [] },
      asOf: "2026-10-12",
      language: "en",
      droppedClaims: 0,
      sources: [],
      hiring: { ats: { type: "greenhouse", board: "w", total: 12, byDepartment: [{ name: "Engineering", count: 7 }], byLocation: [] }, trackedJobs: 1 },
    });
    expect(text).toContain("As of 2026-10-12. Makes widgets.");
    expect(text).toContain("Open roles on their greenhouse board: 12 (Engineering 7)");
    expect(text).toContain("- Opened a Melbourne office (2026-05) <https://w.com/news>");
  });
});
