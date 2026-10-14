import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getFakeGenerator, registerFakeGenerator, type FakeGenerator } from "@/server/ai/fake/transport";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import { DEMO_UNSUPPORTED_BULLET } from "@/server/ai/fake/generators/tailoring";
import { saveProfileVersion, savePreferences, getCurrentProfile } from "@/server/repo/profile";
import { createJob, getJob } from "@/server/repo/jobs";
import { latestCvDocument } from "@/server/repo/cv-documents";
import { processJob } from "@/server/jobs/pipeline";
import { proceedWithJob, startTailoring } from "@/server/jobs/proceed";
import { isCvStale, tailorCvForJob, writeLinkedinForUser } from "@/server/cv/tailor";
import { assembleCv } from "@/server/cv/assemble";
import { setUserLocale } from "@/server/repo/users";
import { answerCvQuestion, resolveCvLine } from "@/server/cv/resolve";
import { loadJobFit } from "@/server/jobs/fit";
import { exportCv } from "@/server/cv/export";
import { getTask } from "@/server/tasks/runner";
import { blockingFlags } from "@/shared/schemas/cv";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-cv-"));
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

const demoWriter = getFakeGenerator("tailorCv")!;
let override: FakeGenerator | null = null;
registerFakeGenerator("tailorCv", (req) => (override ?? demoWriter)(req));
afterEach(() => {
  override = null;
});

export const HIGHLIGHTS = {
  harbour: ["Led the rebuild of the merchant dashboard in React and TypeScript, cutting page load time by 40%.", "Mentored 4 engineers."],
  koala: ["Built checkout flows in React used by 2 million monthly customers."],
};

export function tailoringProfile(rights = [right("AU", "permanent_resident", "au_pr")]) {
  const base = profile({}, rights);
  base.basics = { ...base.basics, name: "Jamie Park", email: "jamie@example.com", phone: "0400 000 000", city: "Sydney", country: "AU" };
  base.experience[0].highlights = HIGHLIGHTS.harbour;
  base.experience[1].highlights = HIGHLIGHTS.koala;
  base.skills = [
    { name: "React", category: "framework" },
    { name: "TypeScript", category: "language" },
    { name: "GraphQL", category: "tool" },
  ];
  return base;
}

async function setup(rights?: ReturnType<typeof right>[]) {
  const { db, userId } = testDb();
  saveProfileVersion(db, userId, { cvText: `${CV_TEXT}\nFrontend engineer with seven years of React and TypeScript experience building payment products.`, data: tailoringProfile(rights) });
  savePreferences(db, userId, { ...defaultPreferences(), targetTitles: ["Senior Frontend Engineer"] });
  const ctx = { db, userId };
  const job = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING }));
  return { db, userId, ctx, job };
}

describe("tailored CV (demo mode)", () => {
  it("writes a draft whose facts come from the profile and flags the unsupported line", async () => {
    const { db, userId, ctx, job } = await setup();
    const doc = await tailorCvForJob(ctx, job.id);

    expect(doc.content.roles.map((r) => [r.title, r.company, r.start, r.end])).toEqual([
      ["Senior Frontend Engineer", "Harbour Payments", "2021-03", null],
      ["Frontend Engineer", "Koala Commerce", "2018-01", "2021-02"],
    ]);
    expect(doc.content.header).toMatchObject({ name: "Jamie Park", email: "jamie@example.com" });
    expect(doc.content).toMatchObject({ market: "AU", locale: "en-AU", paper: "A4", referees: true, workRight: { status: "permanent_resident", country: "AU" } });

    const blocking = blockingFlags(doc.flags);
    expect(blocking.map((f) => f.kind)).toEqual(["number", "number"]);
    const flagged = doc.content.roles[0].bullets.find((b) => b.text === DEMO_UNSUPPORTED_BULLET.en)!;
    expect(blocking.every((f) => f.lineId === flagged.id)).toBe(true);
    expect(doc.checks!.keywordsAfter!.share!).toBeGreaterThanOrEqual(doc.checks!.keywordsBefore!.share!);

    // Export waits until the flag is dealt with. Removing it clears every blocking flag; the tier is untouched.
    await expect(exportCv(db, userId, doc.id, "docx")).rejects.toThrow("unresolved_flags");
    const tierBefore = getJob(db, userId, job.id)!.tier;
    const after = resolveCvLine(db, userId, doc.id, flagged.id, { kind: "remove" });
    expect(blockingFlags(after.flags)).toEqual([]);
    const file = await exportCv(db, userId, doc.id, "docx");
    expect(file).toMatchObject({ fileName: "Jamie-Park-CV-Bright-Harbour-Health.docx", mime: expect.stringContaining("wordprocessingml") });
    expect(after.edits).toEqual([expect.objectContaining({ kind: "remove", lineId: flagged.id })]);
    expect(getJob(db, userId, job.id)!.tier).toBe(tierBefore);
  });

  it("keeps titles, companies and dates from the profile even when the model changes them", async () => {
    const { ctx, job } = await setup();
    override = (req) => {
      const reply = demoWriter(req) as { content: Array<{ text: string }> };
      const out = JSON.parse(reply.content[0].text);
      out.roles = [{ ...out.roles[0], title: "Head of Engineering", start: "2015-01" }, { experienceId: "exp-99", bullets: [] }];
      out.skills = [...out.skills, "Kubernetes"];
      return { content: [{ type: "text", text: JSON.stringify(out) }] };
    };
    const doc = await tailorCvForJob(ctx, job.id);
    expect(doc.content.roles[0]).toMatchObject({ title: "Senior Frontend Engineer", start: "2021-03" });
    expect(doc.content.skills).not.toContain("Kubernetes");
    expect(doc.checks!.dropped).toBe(2);
    // A role the model skipped keeps its own CV bullets.
    expect(doc.content.roles[1].bullets.map((b) => [b.text, b.origin])).toEqual([[HIGHLIGHTS.koala[0], "profile"]]);
  });

  it("edits in the user's own words only warn; confirming a line adds a fact without changing the tier", async () => {
    const { db, userId, ctx, job } = await setup();
    const doc = await tailorCvForJob(ctx, job.id);
    const flagged = blockingFlags(doc.flags)[0].lineId!;

    const edited = resolveCvLine(db, userId, doc.id, flagged, { kind: "edit", text: "Improved release frequency by 25%." });
    expect(blockingFlags(edited.flags)).toEqual([]);
    expect(edited.flags.filter((f) => f.lineId === flagged).every((f) => f.severity === "warn")).toBe(true);

    const second = await tailorCvForJob(ctx, job.id);
    expect(second.version).toBe(2);
    const line = blockingFlags(second.flags)[0].lineId!;
    const tier = getJob(db, userId, job.id)!.tier;
    const confirmed = resolveCvLine(db, userId, second.id, line, { kind: "confirm_fact" });
    expect(blockingFlags(confirmed.flags)).toEqual([]);
    expect(getCurrentProfile(db, userId)!.data.facts.at(-1)).toMatchObject({ text: DEMO_UNSUPPORTED_BULLET.en, source: "user" });
    expect(isCvStale(confirmed, getCurrentProfile(db, userId), getJob(db, userId, job.id))).toBe(false);
    expect(getJob(db, userId, job.id)!.tier).toBe(tier);
    expect(loadJobFit(db, userId, getJob(db, userId, job.id)!)!.profileStale).toBe(true);
  });

  it("answers to the plan's questions become facts and make the draft stale", async () => {
    const { db, userId, ctx, job } = await setup();
    const doc = await tailorCvForJob(ctx, job.id);
    expect(doc.plan!.questions.length).toBeGreaterThan(0);
    answerCvQuestion(db, userId, doc.id, 0, "Yes — I added GraphQL to our dashboard API in 2023.");
    expect(getCurrentProfile(db, userId)!.data.facts.at(-1)!.text).toContain("GraphQL");
    expect(isCvStale(latestCvDocument(db, userId, "cv", job.id)!, getCurrentProfile(db, userId), job)).toBe(true);
  });

  it("revisions keep lines the user wrote and are checked again", async () => {
    const { db, userId, ctx, job } = await setup();
    const first = await tailorCvForJob(ctx, job.id);
    const keep = first.content.roles[0].bullets[0];
    resolveCvLine(db, userId, first.id, keep.id, { kind: "edit", text: keep.text });
    const revised = await tailorCvForJob(ctx, job.id, { revise: { fromDocId: first.id, instructions: "Make it shorter" } });
    expect(revised.version).toBe(2);
    expect(revised.plan).toEqual(first.plan);
    expect(revised.content.roles[0].bullets.find((b) => b.text === keep.text)?.origin).toBe("user");
    expect(revised.content.roles[0].bullets.length).toBeLessThanOrEqual(2);
    expect(blockingFlags(revised.flags)).toEqual([]);
  });

  it("Proceed sets Applying, queues one tailoring task, and needs an analysed job", async () => {
    const { db, userId, job } = await setup();
    const { taskId } = proceedWithJob(db, userId, job.id, "button");
    expect(getJob(db, userId, job.id)!.status).toBe("applying");
    expect(getTask(db, taskId!)).toMatchObject({ kind: "tailor-cv", status: "queued" });
    expect(proceedWithJob(db, userId, job.id, "chat").taskId).toBe(taskId);
    const raw = createJob(db, userId, { source: "paste", rawText: "x" });
    expect(startTailoring(db, userId, raw.id)).toBeNull();
  });

  it("adds the profile skill that spells out a posting keyword the draft doesn't use", () => {
    const data = tailoringProfile();
    data.skills = [...data.skills, { name: "Vendor and budget management", category: "domain" }, { name: "Vendor management", category: "domain" }];
    const plan = { summaryAngle: "", targetRequirementIds: [], roles: [], keywords: [], doNotClaim: [], questions: [], linkedinEmphasis: [], advice: [] };
    const output = { summary: [], roles: [], skills: ["React", "Vendor and budget management"] };
    const assemble = (keywords: string[], summary = "Frontend engineer.") =>
      assembleCv({
        profile: { cvText: CV_TEXT, data },
        job: { country: "AU", postingLanguage: "en", keywords },
        plan,
        output: { ...output, summary: [{ text: summary, sourceRefs: [], requirementIds: [] }] },
      }).doc.skills;

    expect(assemble(["vendor management", "Kubernetes"])).toEqual(["Vendor management", "React", "Vendor and budget management"]);
    // Already in the wording, or no matching skill: nothing to add.
    expect(assemble(["vendor management"], "Strong vendor management.")).toEqual(["React", "Vendor and budget management"]);
    expect(assemble([])).toEqual(["React", "Vendor and budget management"]);
  });

  it("writes the plan's notes in the interface language and the CV in the posting's", async () => {
    const { db, userId, ctx, job } = await setup();
    setUserLocale(db, userId, "ko");
    const doc = await tailorCvForJob(ctx, job.id);
    expect(doc.content.language).toBe("en");
    expect(doc.plan!.summaryAngle).toMatch(/[가-힣]/);
    for (const q of doc.plan!.questions) expect(q.text).toMatch(/[가-힣]/);
    expect(doc.content.roles[0].bullets.some((b) => b.text === DEMO_UNSUPPORTED_BULLET.en)).toBe(true);
  });

  it("Korean postings get a Korean CV; US jobs use Letter paper without referees or a rights line", async () => {
    const { db, userId, ctx } = await setup([right("US", "citizen", "us_citizen")]);
    const us = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING.replace(/Sydney NSW/g, "Austin, TX").replace(/Australia/g, "the United States").replace(/\+ super/, "") }));
    const usDoc = await tailorCvForJob(ctx, us.id);
    expect(usDoc.content).toMatchObject({ market: "US", paper: "Letter", locale: "en-US", referees: false, workRight: null });

    const koPosting = `시니어 프론트엔드 개발자\n바다물류 · 서울\n\n자격 요건\n• React와 TypeScript 경험 5년 이상\n• GraphQL 경험 우대\n\n바다물류는 물류 플랫폼을 만드는 회사입니다. 서울 본사에서 근무합니다.`;
    const ko = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: koPosting }));
    const koDoc = await tailorCvForJob(ctx, ko.id);
    expect(koDoc.content.language).toBe("ko");
    expect(koDoc.content.roles[0].bullets.some((b) => b.text === DEMO_UNSUPPORTED_BULLET.ko)).toBe(true);
  });
});

describe("LinkedIn profile text (demo mode)", () => {
  it("is written from the profile with sources and within LinkedIn's limits", async () => {
    const { db, userId, ctx } = await setup();
    const doc = await writeLinkedinForUser(ctx, "en");
    expect(doc.content.headline.text).toMatch(/^Senior Frontend Engineer \| React · TypeScript · GraphQL$/);
    expect(doc.content.positions.map((p) => p.company)).toEqual(["Harbour Payments", "Koala Commerce"]);
    expect(doc.content.topSkills).toEqual(["React", "TypeScript", "GraphQL"]);
    expect(blockingFlags(doc.flags)).toEqual([]);
    expect(latestCvDocument(db, userId, "linkedin", null)!.id).toBe(doc.id);
  });
});
