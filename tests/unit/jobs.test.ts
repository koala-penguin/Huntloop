import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageLog } from "@/server/db/schema";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { addAttachments, createJob, getJob, setJobAnswer } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { loadJobFit } from "@/server/jobs/fit";
import { saveUpload } from "@/server/storage";
import { assessmentProfileView, profileHash, redactContacts } from "@/server/ai/tasks/assess";
import { finalizeAnalysis } from "@/server/ai/tasks/analyze-posting";
import { fakePostingAnalysis, DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { placeLabel } from "@/shared/countries";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-jobs-"));
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

const fixture = (...parts: string[]) => fs.readFileSync(path.join(__dirname, "..", "fixtures", ...parts), "utf8");

function setup(rights = [right("AU", "citizen", "au_citizen")]) {
  const { db, userId } = testDb();
  saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, rights) });
  savePreferences(db, userId, defaultPreferences());
  return { db, userId, ctx: { db, userId } };
}

const aiCalls = (db: ReturnType<typeof testDb>["db"]) => db.select().from(usageLog).all().map((r) => r.task);

const PASTE = `Home  Jobs  Companies  Sign in
Cookie settings — we use cookies to improve your experience.

${DEMO_SCREENSHOT_POSTING}

Similar jobs
Frontend Developer — Acme — Melbourne
Report this job`;

describe("job pipeline (demo mode)", () => {
  it("turns a pasted posting into analysis, assessment and an Interview Chance tier", async () => {
    const { db, userId, ctx } = setup();
    const job = createJob(db, userId, { source: "paste", rawText: PASTE, intake: { noisy: true } });
    const stages: string[] = [];
    const done = await processJob(ctx, job, { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(["reading", "analyzing", "assessing", "scoring", "done"]);
    expect(done).toMatchObject({ intakeStatus: "ready", title: "Senior Frontend Engineer", companyName: "Bright Harbour Health", country: "AU", city: "Sydney", workplace: "hybrid" });
    const fit = loadJobFit(db, userId, getJob(db, userId, job.id)!)!;
    expect(fit.analysis.requirements.length).toBeGreaterThan(4);
    expect(fit.analysis.sponsorship).toBe("not_offered");
    expect(fit.score?.eligibility).toBe("eligible");
    expect(["strong", "good", "stretch", "long_shot"]).toContain(fit.score?.tier);
    expect(getJob(db, userId, job.id)!.tier).toBe(fit.score?.tier);
    expect(aiCalls(db)).toEqual(["analyzePosting", "assess"]);
  });

  it("reuses cached analysis and assessment, and re-tiers answers without AI calls", async () => {
    const { db, userId, ctx } = setup();
    const a = createJob(db, userId, { source: "paste", rawText: PASTE, intake: { noisy: true } });
    await processJob(ctx, a);
    const b = createJob(db, userId, { source: "paste", rawText: PASTE, intake: { noisy: true } });
    await processJob(ctx, b);
    expect(aiCalls(db)).toEqual(["analyzePosting", "assess"]);

    const fit = loadJobFit(db, userId, getJob(db, userId, b.id)!)!;
    const question = fit.assessment!.items.find((i) => i.question);
    expect(question).toBeDefined();
    setJobAnswer(db, userId, b.id, question!.requirementId, "yes");
    const after = loadJobFit(db, userId, getJob(db, userId, b.id)!)!;
    expect(after.score!.items.find((i) => i.requirementId === question!.requirementId)).toMatchObject({ status: "met", overridden: true });
    expect(after.score!.score).toBeGreaterThanOrEqual(fit.score!.score);
    expect(aiCalls(db)).toHaveLength(2);
  });

  it("a work-rights change re-tiers without re-assessment; a CV change marks it stale", async () => {
    const { db, userId, ctx } = setup([right("AU", "unknown")]);
    const job = createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING, intake: { noisy: false } });
    await processJob(ctx, job);
    expect(loadJobFit(db, userId, getJob(db, userId, job.id)!)!.score!.eligibility).toBe("verify");

    saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "needs_sponsorship", "au_needs_sponsorship")]) });
    const fit = loadJobFit(db, userId, getJob(db, userId, job.id)!)!;
    expect(fit.score!.eligibility).toBe("ineligible");
    expect(fit.profileStale).toBe(false);

    saveProfileVersion(db, userId, { cvText: `${CV_TEXT}\nAlso: GraphQL`, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
    expect(loadJobFit(db, userId, getJob(db, userId, job.id)!)!.profileStale).toBe(true);
    expect(aiCalls(db)).toEqual(["analyzePosting", "assess"]);
  });

  it("transcribes screenshots into one job", async () => {
    const { db, userId, ctx } = setup();
    const job = createJob(db, userId, { source: "screenshot" });
    const items = [];
    for (let i = 0; i < 3; i++) {
      const png = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: "#ffffff" } }).png().toBuffer();
      items.push({ kind: "image", path: await saveUpload("postings", `shot-${i}.png`, png), mime: "image/png", fileName: `shot-${i}.png` });
    }
    addAttachments(db, job.id, items);
    const done = await processJob(ctx, job, { transcribe: true });
    expect(done.intakeStatus).toBe("ready");
    expect(done.description).toBe(DEMO_SCREENSHOT_POSTING);
    expect(aiCalls(db)).toEqual(["transcribePosting", "analyzePosting", "assess"]);
  });

  it("asks for content for SEEK and LinkedIn links instead of fetching them", async () => {
    const { db, userId, ctx } = setup();
    for (const url of ["https://www.seek.com.au/job/81234567", "https://www.linkedin.com/jobs/view/4011"]) {
      const job = createJob(db, userId, { source: "url", sourceUrl: url });
      const done = await processJob(ctx, job, { fetchImpl: (() => Promise.reject(new Error("must not fetch"))) as unknown as typeof fetch });
      expect(done).toMatchObject({ intakeStatus: "needs_content", intake: { reason: "site_browser" } });
    }
    expect(aiCalls(db)).toEqual([]);
  });

  it("reads Greenhouse jobs through the public API", async () => {
    const { db, userId, ctx } = setup();
    const job = createJob(db, userId, { source: "url", sourceUrl: "https://job-boards.greenhouse.io/canva/jobs/4012345" });
    const done = await processJob(ctx, job, { fetchJson: async () => JSON.parse(fixture("api", "greenhouse-job.json")) });
    expect(done).toMatchObject({ intakeStatus: "ready", source: "greenhouse", companyName: "Canva", title: "Senior Frontend Engineer" });
    expect(done.description).toContain("React and TypeScript");
  });

  it("falls back to asking for content when a page can't be fetched", async () => {
    const { db, userId, ctx } = setup();
    const job = createJob(db, userId, { source: "url", sourceUrl: "https://careers.example.com/jobs/1" });
    const done = await processJob(ctx, job, { fetchImpl: (async () => new Response("<title>Just a moment...</title>", { status: 200 })) as unknown as typeof fetch });
    expect(done.intake).toMatchObject({ reason: expect.stringMatching(/challenge|fetch_failed/) });
  });
});

describe("eligibility scenarios", () => {
  const run = async (text: string, rights: Parameters<typeof setup>[0]) => {
    const { db, userId, ctx } = setup(rights);
    const job = createJob(db, userId, { source: "paste", rawText: text, intake: { noisy: false } });
    await processJob(ctx, job);
    return loadJobFit(db, userId, getJob(db, userId, job.id)!)!;
  };

  it("AU government role needing citizenship + Baseline → Ineligible for a 482 holder, with the quote", async () => {
    const fit = await run(
      `Senior Data Analyst — Department of Example, Canberra ACT\n• 4+ years of SQL experience\n• Applicants must be Australian citizens\n• Ability to obtain and maintain a Baseline security clearance`,
      [right("AU", "needs_sponsorship", "au_482")],
    );
    expect(fit.score!.eligibility).toBe("ineligible");
    const failed = fit.score!.gates.filter((g) => g.status === "fail");
    expect(failed.map((g) => g.postingQuote)).toContain("Applicants must be Australian citizens");
  });

  it("US posting without sponsorship → Ineligible for someone needing sponsorship", async () => {
    const fit = await run(`Backend Engineer, Austin TX, United States\n• 3+ years of Go\n• We are unable to sponsor visas for this role`, [right("US", "needs_sponsorship")]);
    expect(fit.score!.eligibility).toBe("ineligible");
  });

  it("SG posting without SG work rights on file → Verify with a work-rights question", async () => {
    const fit = await run(`Data Engineer, Singapore\n• 4+ years of data engineering\n• Experience with Spark`, [right("AU", "citizen", "au_citizen")]);
    expect(fit.score!.eligibility).toBe("verify");
    expect(fit.score!.gates.find((g) => g.kind === "work_rights")).toMatchObject({ status: "unclear", reasonKey: "work_rights_unknown", params: { country: "SG" } });
  });
});

describe("analysis and assessment helpers", () => {
  it("cuts page noise with anchors and drops requirements whose quotes aren't in the posting", () => {
    const output = fakePostingAnalysis(PASTE, {}, "2026-10-12");
    const withAnchors = {
      ...output,
      postingStart: "Senior Frontend Engineer\nBright Harbour Health",
      postingEnd: "a product you are proud of.",
      requirements: [...output.requirements, { postingQuote: "10+ years of Rust", kind: "must" as const, category: "skill" as const, gate: "none" as const, minYears: null, normalized: "Rust" }],
    };
    const { analysis, canonicalText } = finalizeAnalysis(withAnchors as never, PASTE, true);
    expect(canonicalText.startsWith("Senior Frontend Engineer")).toBe(true);
    expect(canonicalText).not.toContain("Similar jobs");
    expect(canonicalText).not.toContain("Cookie settings");
    expect(analysis.droppedRequirements).toBe(1);
    expect(analysis.requirements.map((r) => r.id)).toEqual(analysis.requirements.map((_, i) => `r${i + 1}`));
  });

  it("redacts contact details and keeps the profile hash stable across work-rights edits", () => {
    const data = profile({ basics: { ...profile().basics, name: "Jamie Park" } }, [right("AU", "citizen")]);
    const cv = `Jamie Park\njamie.park@example.com · +61 412 345 678 · linkedin.com/in/jamiepark\n${CV_TEXT}`;
    const redacted = redactContacts(cv, data);
    expect(redacted).not.toMatch(/jamie\.park@|412 345|linkedin\.com|Jamie Park/);
    expect(redacted).toContain("Led the rebuild of the merchant dashboard");
    expect(JSON.stringify(assessmentProfileView(cv, data))).not.toContain("workRights");
    expect(profileHash(cv, data)).toBe(profileHash(cv, { ...data, workRights: [right("AU", "needs_sponsorship")] }));
    expect(profileHash(cv, data)).not.toBe(profileHash(`${cv}\nKubernetes`, data));
  });

  it("keeps employment dates while redacting phone numbers", () => {
    const data = profile({ basics: { ...profile().basics, phone: "+61 412 345 678" } }, [right("AU", "citizen")]);
    const plain = profile({ basics: { ...profile().basics, phone: null } }, [right("AU", "citizen")]);
    expect(redactContacts("Acme (2015-2019), 2019 - 2023, +61 412 345 678", plain)).toBe("Acme (2015-2019), 2019 - 2023, [phone]");
    expect(redactContacts("Call (+61) 412-345-678 today", data)).toBe("Call [phone] today");
    expect(redactContacts("Acme 2015.03 - 2019.06", plain)).toBe("Acme 2015.03 - 2019.06");
    expect(redactContacts("Acme 2015-03 - 2019-06", plain)).toBe("Acme 2015-03 - 2019-06");
    expect(redactContacts("Office +61 2 9123 4567", plain)).toBe("Office [phone]");
    expect(redactContacts("Mobile 0412 345 678", plain)).toBe("Mobile [phone]");
  });
});

describe("place labels", () => {
  it("adds the country name only when the location doesn't already say it", () => {
    expect(placeLabel("Sydney NSW", "AU", "en")).toBe("Sydney NSW · Australia");
    expect(placeLabel("Singapore", "SG", "en")).toBe("Singapore");
    expect(placeLabel("Singapore", "SG", "ko")).toBe("Singapore");
    expect(placeLabel("Sydney, Australia", "AU", "ko")).toBe("Sydney, Australia");
    expect(placeLabel("Austin, TX, US", "US", "en")).toBe("Austin, TX, US");
    expect(placeLabel(null, "NZ", "ko")).toBe("뉴질랜드");
    expect(placeLabel(null, null, "en")).toBeNull();
  });
});
