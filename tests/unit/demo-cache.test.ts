import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MODEL_IDS } from "@/shared/models";
import { resetAiClient } from "@/server/ai/client";
import { createFakeFetch } from "@/server/ai/fake/transport";
import { analyzePosting } from "@/server/ai/tasks/analyze-posting";
import { assessJob } from "@/server/ai/tasks/assess";
import { aiTexts, assessments, postingAnalyses, profileVersions, tasks, usageLog } from "@/server/db/schema";
import { getCurrentProfile, saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createJob, getJob } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { loadJobFit } from "@/server/jobs/fit";
import { translateAssessment } from "@/server/jobs/prose";
import { getFreshReport, getLatestReport, researchForChat, startCompanyResearch } from "@/server/research/company";
import { enqueueTask, getTask, TaskRunner } from "@/server/tasks/runner";
import { EXTRACT_PROFILE_TASK } from "@/server/tasks/handlers/extract-profile";
import { runCompanyResearch } from "@/server/tasks/handlers/company-research";
import type { TaskRow } from "@/server/db/schema";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";
import { eq } from "drizzle-orm";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-demo-cache-"));
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

const TEXT =
  "Senior Frontend Engineer at Acme, Auckland. Requirements: 5+ years of React. Experience with TypeScript. Nice to have: GraphQL. Full working rights in New Zealand required.";
const INPUT = { text: TEXT, hints: {}, noisy: false, sourceUrl: null };

/** Answers like the real API would, but locally: the demo generators, served as a "live" client. */
let liveTask = "chat";
function installOfflineLiveClient() {
  const fake = createFakeFetch({ streamDelayMs: 0, models: [...MODEL_IDS] });
  const fetchImpl: typeof fetch = (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-huntloop-task", liveTask);
    return fake(input, { ...init, headers });
  };
  (globalThis as unknown as { huntloopAi: { clients: Record<string, Anthropic> } }).huntloopAi.clients.live = new Anthropic({
    apiKey: "x",
    maxRetries: 0,
    fetch: fetchImpl,
  });
}

async function inMode<T>(mode: "live" | "fake", task: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.HUNTLOOP_AI;
  process.env.HUNTLOOP_AI = mode;
  resetAiClient();
  if (mode === "live") {
    liveTask = task;
    installOfflineLiveClient();
  }
  try {
    return await fn();
  } finally {
    process.env.HUNTLOOP_AI = prev;
    resetAiClient();
  }
}

afterEach(() => resetAiClient());

const usageSimulated = (db: ReturnType<typeof testDb>["db"], task?: string) =>
  db
    .select()
    .from(usageLog)
    .all()
    .filter((u) => !task || u.task === task)
    .map((u) => u.simulated);

describe("demo output is labelled and never reused in live mode", () => {
  it("posting analyses: demo rows serve demo mode only, live rows live mode only", async () => {
    const { db, userId } = testDb();
    const ctx = { db, userId };
    const first = await analyzePosting(ctx, INPUT);
    expect(first.cached).toBe(false);
    expect(db.select().from(postingAnalyses).all().map((r) => r.simulated)).toEqual([true]);
    const again = await analyzePosting(ctx, INPUT);
    expect(again).toMatchObject({ cached: true, analysisId: first.analysisId });

    const live = await inMode("live", "analyzePosting", () => analyzePosting(ctx, INPUT));
    expect(live.cached).toBe(false);
    expect(live.analysisId).not.toBe(first.analysisId);
    expect(db.select().from(postingAnalyses).where(eq(postingAnalyses.id, live.analysisId)).get()?.simulated).toBe(false);
    expect(usageSimulated(db)).toEqual([true, false]);

    const liveAgain = await inMode("live", "analyzePosting", () => analyzePosting(ctx, INPUT));
    expect(liveAgain).toMatchObject({ cached: true, analysisId: live.analysisId });
    const demoAgain = await analyzePosting(ctx, INPUT);
    expect(demoAgain).toMatchObject({ cached: true, analysisId: first.analysisId });
  });

  it("posting analyses: an unknown (pre-label) row is not reused", async () => {
    const { db, userId } = testDb();
    const ctx = { db, userId };
    const first = await analyzePosting(ctx, INPUT);
    // A row written before the column existed: inserted without it, as the old code did.
    const raw = (db as unknown as { $client: import("better-sqlite3").Database }).$client;
    raw.exec(`insert into posting_analyses (text_hash, prompt_version, model, effort, data, created_at)
              select text_hash, prompt_version, model, effort, data, created_at from posting_analyses where id = ${first.analysisId}`);
    raw.exec(`delete from posting_analyses where id = ${first.analysisId}`);
    const legacy = db.select().from(postingAnalyses).get()!;
    expect(legacy.simulated).toBeNull();

    const demo = await analyzePosting(ctx, INPUT);
    expect(demo.cached).toBe(false);
    expect(demo.analysisId).not.toBe(legacy.id);
    const live = await inMode("live", "analyzePosting", () => analyzePosting(ctx, INPUT));
    expect(live.cached).toBe(false);
    expect(live.analysisId).not.toBe(legacy.id);
  });

  it("assessments: same rules", async () => {
    const { db, userId } = testDb();
    const ctx = { db, userId };
    const analysis = await analyzePosting(ctx, INPUT);
    const input = { analysis: analysis.analysis, profile: { version: 1, cvText: CV_TEXT, data: profile({}, [right("NZ", "citizen", "nz_citizen")]) }, language: "en" };
    const first = await assessJob(ctx, analysis.analysisId, input);
    expect(first.cached).toBe(false);
    expect(db.select().from(assessments).get()?.simulated).toBe(true);
    expect(await assessJob(ctx, analysis.analysisId, input)).toMatchObject({ cached: true, assessmentId: first.assessmentId });

    const live = await inMode("live", "assess", () => assessJob(ctx, analysis.analysisId, input));
    expect(live.cached).toBe(false);
    expect(db.select().from(assessments).where(eq(assessments.id, live.assessmentId)).get()?.simulated).toBe(false);
    expect(usageSimulated(db, "assess")).toEqual([true, false]);
    expect(await inMode("live", "assess", () => assessJob(ctx, analysis.analysisId, input))).toMatchObject({ cached: true, assessmentId: live.assessmentId });
    expect(await assessJob(ctx, analysis.analysisId, input)).toMatchObject({ cached: true, assessmentId: first.assessmentId });

    db.update(assessments).set({ simulated: null }).run();
    expect((await assessJob(ctx, analysis.analysisId, input)).cached).toBe(false);
  });

  it("company reports: reuse decisions only take a report made in the same mode", async () => {
    const { db, userId } = testDb();
    saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
    savePreferences(db, userId, defaultPreferences());
    const job = await processJob({ db, userId }, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING, intake: { noisy: false } }));
    expect(job.companyId).toBeTruthy();
    // Demo research, the way the runner does it.
    const started = startCompanyResearch(db, userId, job, { simulated: true }) as { taskId: number };
    const task = db.select().from(tasks).where(eq(tasks.id, started.taskId)).get() as TaskRow;
    await runCompanyResearch({ db, task, userId, payload: task.payload, signal: new AbortController().signal, progress: () => {} });
    db.update(tasks).set({ status: "succeeded" }).where(eq(tasks.id, task.id)).run();
    const stored = getLatestReport(db, job.companyId!)!;
    expect(stored.simulated).toBe(true);

    expect(getFreshReport(db, job.companyId!, new Date(), { simulated: false })).toBeNull();
    expect(getFreshReport(db, job.companyId!)?.id).toBe(stored.id);
    expect(getFreshReport(db, job.companyId!, new Date(), { simulated: true })?.id).toBe(stored.id);

    const live = startCompanyResearch(db, userId, job, { simulated: false });
    expect(live).toMatchObject({ ok: true, reused: false });
    expect(db.select().from(tasks).all().filter((t) => t.kind === "company-research")).toHaveLength(2);
    expect(startCompanyResearch(db, userId, job, { simulated: true })).toMatchObject({ ok: true, reused: true });

    // A live chat never gets the demo report in its context.
    const prev = process.env.HUNTLOOP_AI;
    process.env.HUNTLOOP_AI = "live";
    try {
      const full = getJob(db, userId, job.id)!;
      expect(researchForChat.isReady({ db, userId }, full)).toBe(false);
      expect(researchForChat.summaryFor({ db, userId }, full)).toBeNull();
    } finally {
      process.env.HUNTLOOP_AI = prev;
    }
  });

  it("profile versions: extraction stores the call's label; edits inherit it, unknown stays unknown", async () => {
    const { db, userId } = testDb();
    const task = enqueueTask(db, userId, EXTRACT_PROFILE_TASK, { filePath: null, fileName: null, text: CV_TEXT });
    await Promise.all(await new TaskRunner(db).tick());
    expect(getTask(db, task.id)?.status).toBe("succeeded");
    const v1 = getCurrentProfile(db, userId)!;
    expect(v1.simulated).toBe(true);
    const v2 = saveProfileVersion(db, userId, { cvText: v1.cvText, data: v1.data });
    expect(v2.simulated).toBe(true);
    const v3 = saveProfileVersion(db, userId, { cvText: v1.cvText, data: v1.data, simulated: false });
    expect(v3.simulated).toBe(false);
    expect(saveProfileVersion(db, userId, { cvText: v1.cvText, data: v1.data }).simulated).toBe(false);

    // A version written before labels existed (null) stays unknown when edited.
    const other = testDb();
    const typed = saveProfileVersion(other.db, other.userId, { cvText: CV_TEXT, data: profile({}, []) });
    expect(typed.simulated).toBe(false);
    other.db.update(profileVersions).set({ simulated: null }).run();
    expect(getCurrentProfile(other.db, other.userId)!.simulated).toBeNull();
    expect(saveProfileVersion(other.db, other.userId, { cvText: CV_TEXT, data: profile({}, []) }).simulated).toBeNull();
  });

  it("translations: a demo translation isn't served in live mode", async () => {
    const { db, userId } = testDb();
    const ctx = { db, userId };
    saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
    savePreferences(db, userId, defaultPreferences());
    const job = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING, intake: { noisy: false } }));
    const fit = loadJobFit(db, userId, getJob(db, userId, job.id)!)!;
    expect(fit.assessmentId).toBeTruthy();
    const translate = () => translateAssessment(ctx, fit.assessmentId!, fit.assessment!, fit.assessmentLanguage ?? "en", fit.analysis, "ko");

    const demo = await translate();
    expect(Object.keys(demo).length).toBeGreaterThan(0);
    expect(db.select().from(aiTexts).all().map((r) => r.simulated)).toEqual([true]);
    await translate();
    expect(db.select().from(aiTexts).all()).toHaveLength(1);

    await inMode("live", "translate", translate);
    expect(db.select().from(aiTexts).all().map((r) => r.simulated)).toEqual([true, false]);
    expect(usageSimulated(db, "translate")).toEqual([true, false]);
    await inMode("live", "translate", translate);
    expect(db.select().from(aiTexts).all()).toHaveLength(2);
  });
});
