import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { chatMessages, interviewAnswers } from "@/server/db/schema";
import { listChatMessages, runChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { ensureInterviewConversation, interviewTools, verbatimGate } from "@/server/ai/chat/interview";
import { getFakeGenerator, registerFakeGenerator, type FakeGenerator, type FakeRequest } from "@/server/ai/fake/transport";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import { DEMO_UNSUPPORTED_BULLET } from "@/server/ai/fake/generators/tailoring";
import "@/server/ai/fake/generators/interview";
import { countUnionParams } from "@/server/ai/schema-limits";
import { createInterview, getInterview, listAnswers, saveStageForm, updateInterview, type Interview } from "@/server/repo/interviews";
import { getCurrentProfile, getPreferences, saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createJob } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { loadJobFit } from "@/server/jobs/fit";
import { tailorCvForJob, writeLinkedinForUser } from "@/server/cv/tailor";
import { buildProfileFromInterview, interviewReady, mergePreferences } from "@/server/cv/interview-build";
import { buildProvenanceContext, checkLine } from "@/server/cv/provenance";
import { blockingFlags, type CvLine } from "@/shared/schemas/cv";
import { testDb } from "../helpers/db";
import { right } from "../helpers/scoring";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-interview-"));
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

const requests: FakeRequest["body"][] = [];
const demoInterviewer = getFakeGenerator("cvInterview")!;
let override: FakeGenerator | null = null;
registerFakeGenerator("cvInterview", (req) => {
  requests.push(JSON.parse(JSON.stringify(req.body)));
  return (override ?? demoInterviewer)(req);
});
afterEach(() => {
  override = null;
  requests.length = 0;
});

export const ANSWERS = {
  scope: "I led a team of 6 frontend engineers building the merchant dashboard in React and TypeScript.",
  responsibility: "I was accountable for frontend architecture, code reviews and mentoring 4 engineers.",
  achievement: "I led the rebuild of the merchant dashboard and cut page load time by 40%.",
  korean: "리액트로 월 200만 명이 쓰는 결제 화면을 만들었습니다.",
  week: "Planning sprints with product, reviewing pull requests and pairing with junior engineers.",
  private: "The company is moving its engineering team offshore next year.",
};

async function turn(ctx: Parameters<typeof runChatTurn>[0], conversationId: number, text: string) {
  const events: ChatEvent[] = [];
  await runChatTurn(ctx, conversationId, text, (e) => events.push(e));
  return events;
}

/** An interview with a target, the current role (exp-1), an older role (exp-2) and a name. */
function setupInterview() {
  const { db, userId } = testDb();
  const ctx = { db, userId };
  let interview = createInterview(db, userId, { country: "AU", language: "en" });
  interview = saveStageForm(db, interview, "target", { titles: ["Senior Frontend Engineer"], seniority: ["senior"], cities: ["Sydney"], workRights: [right("AU", "citizen", "au_citizen")] });
  interview = saveStageForm(db, interview, "current", { status: "employed", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-03", country: "AU" });
  interview = saveStageForm(db, interview, "roles", [
    { ...interview.form.roles[0], location: "Sydney", industry: "fintech" },
    { id: "exp-2", title: "Frontend Engineer", company: "Koala Commerce", location: "Sydney", country: "AU", start: "2018-01", end: "2021-02", depth: "brief" },
  ]);
  interview = saveStageForm(db, interview, "contact", { name: "Morgan Ellis", email: "morgan@example.com", phone: "0400 111 222", city: "Sydney", country: "AU" });
  return { db, userId, ctx, interview };
}

const reload = (db: ReturnType<typeof testDb>["db"], userId: number, interview: Interview) => getInterview(db, userId, interview.id)!;

/** The full Phase 0 path: role chats → profile → posting → tailored CV. */
async function interviewOnlyProfile() {
  const env = setupInterview();
  const { db, userId, ctx } = env;
  const role1 = ensureInterviewConversation(ctx, env.interview.id, "role_deep", "exp-1");
  await turn(ctx, role1.id, ANSWERS.scope);
  await turn(ctx, role1.id, ANSWERS.responsibility);
  await turn(ctx, role1.id, ANSWERS.achievement);
  await turn(ctx, role1.id, "That's all");
  const role2 = ensureInterviewConversation(ctx, env.interview.id, "role_deep", "exp-2");
  await turn(ctx, role2.id, ANSWERS.korean);
  await turn(ctx, role2.id, "That's all");

  let interview = reload(db, userId, env.interview);
  // The candidate ticks every skill the interviewer noted.
  updateInterview(db, interview.id, { form: { ...interview.form, skills: interview.form.skills.map((s) => ({ ...s, ticked: true })) } });
  interview = reload(db, userId, interview);
  expect(interviewReady(interview)).toEqual({ ok: true });
  const built = buildProfileFromInterview(interview, listAnswers(db, interview.id, { includePrivate: true }), null);
  const profile = saveProfileVersion(db, userId, { cvText: built.cvText, data: built.data, simulated: false });
  savePreferences(db, userId, mergePreferences(getPreferences(db, userId), built.preferences));
  return { ...env, interview, built, profile, role1, role2 };
}

describe("CV interview — Phase 0 evidence path (G0)", () => {
  it("records answers verbatim, files them under the role, and notes skills the candidate named", async () => {
    const { db, interview, role1, role2 } = await interviewOnlyProfile();
    const answers = listAnswers(db, interview.id);
    expect(answers.map((a) => [a.experienceRef, a.topic, a.quote])).toEqual([
      ["exp-1", "scope", ANSWERS.scope],
      ["exp-1", "responsibility", ANSWERS.responsibility],
      ["exp-1", "achievement", ANSWERS.achievement],
      ["exp-2", "scope", ANSWERS.korean],
    ]);
    expect(answers.every((a) => a.origin === "chat" && a.messageId !== null)).toBe(true);
    expect(interview.stages).toMatchObject({ "role:exp-1": "done", "role:exp-2": "done" });
    expect(interview.form.skills.map((s) => [s.name, s.experienceRef])).toEqual([
      ["React", "exp-1"],
      ["TypeScript", "exp-1"],
    ]);
    // Each role has its own conversation; the transcript keeps what the candidate typed.
    expect(role1.id).not.toBe(role2.id);
    expect(listChatMessages({ db }, role1.id).filter((m) => m.kind === "user").map((m) => m.text)).toContain(ANSWERS.scope);
  });

  it("an interview-only profile passes the unchanged tailored-CV checks (A0)", async () => {
    const { db, userId, ctx, built } = await interviewOnlyProfile();
    expect(getCurrentProfile(db, userId)!.cvText).toBe(built.cvText);
    const job = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING }));
    const doc = await tailorCvForJob(ctx, job.id);

    const kinds = doc.flags.map((f) => f.kind);
    expect(kinds).not.toContain("unverified_source");
    expect(kinds).not.toContain("unsourced");
    expect(kinds).not.toContain("other_role");
    const blocking = blockingFlags(doc.flags);
    expect(blocking.map((f) => f.kind)).toEqual(["number", "number"]);
    const demo = doc.content.roles[0].bullets.find((b) => b.text === DEMO_UNSUPPORTED_BULLET.en)!;
    expect(blocking.every((f) => f.lineId === demo.id)).toBe(true);
    const lines = [...doc.content.summary, ...doc.content.roles.flatMap((r) => r.bullets)].filter((l) => l.id !== demo.id);
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((l) => l.sourceRefs.every((r) => r.verified))).toBe(true);
    expect(doc.content.roles[0].bullets.map((b) => b.text)).toContain(ANSWERS.achievement);
    expect(doc.content.roles[1].bullets.map((b) => b.text)).toEqual([ANSWERS.korean]);

    // Interview Chance found its evidence in the Career record.
    const score = loadJobFit(db, userId, job)!.score!;
    const quotes = score.items.flatMap((i) => i.verifiedEvidence.map((e) => e.quote));
    expect(quotes.some((q) => built.cvText.includes(q) && q.includes("React"))).toBe(true);

    // And the LinkedIn writer on the same profile.
    const linkedin = await writeLinkedinForUser(ctx, "en");
    expect(linkedin.flags.map((f) => f.kind)).not.toContain("unverified_source");
  });

  it("keeps private answers out of the Career record, highlights and facts, and contact details out of the Career record", async () => {
    const env = setupInterview();
    const { db, userId, ctx } = env;
    const current = ensureInterviewConversation(ctx, env.interview.id, "current", null);
    await turn(ctx, current.id, ANSWERS.week);
    await turn(ctx, current.id, "I report to the Head of Engineering and 3 engineers report to me.");
    await turn(ctx, current.id, "Shipping the new onboarding flow that doubled activation.");
    await turn(ctx, current.id, ANSWERS.private);
    const answers = listAnswers(db, env.interview.id, { includePrivate: true });
    expect(answers.find((a) => a.quote === ANSWERS.private)).toMatchObject({ private: true, experienceRef: "exp-1", stage: "current" });
    expect(listAnswers(db, env.interview.id).map((a) => a.quote)).not.toContain(ANSWERS.private);

    const built = buildProfileFromInterview(reload(db, userId, env.interview), answers, null);
    const everything = [built.cvText, ...built.data.experience.flatMap((e) => e.highlights), ...built.data.facts.map((f) => f.text)].join("\n");
    expect(everything).toContain(ANSWERS.week);
    expect(everything).not.toContain("offshore");
    expect(built.cvText).not.toMatch(/Morgan|morgan@example\.com|0400/);
    expect(built.data.basics).toMatchObject({ name: "Morgan Ellis", email: "morgan@example.com" });
  });
});

describe("CV interview — the verbatim gate (A1)", () => {
  const recordOnce = (quote: string): FakeGenerator => (req) => {
    const last = req.body.messages.at(-1)!;
    const hasResult = Array.isArray(last.content) && (last.content as Array<{ type: string }>).some((b) => b.type === "tool_result");
    return hasResult ? demoInterviewer(req) : { content: [{ type: "tool_use", id: `toolu_gate_${Math.random()}`, name: "record_answer", input: { topic: "scope", quote, private: false, question: "Scope?" } }] };
  };
  const lastResult = () => (requests.at(-1)!.messages.at(-1)!.content as Array<{ type: string; content?: string; is_error?: boolean }>).find((b) => b.type === "tool_result")!;

  it("rejects a reworded quote, an elided one and one shorter than three words", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    for (const quote of ["I managed six engineers on the dashboard.", "I led a team of 6 … in React and TypeScript.", "6 engineers"]) {
      override = recordOnce(quote);
      await turn(ctx, conversation.id, ANSWERS.scope);
      expect(lastResult()).toMatchObject({ is_error: true });
      expect(lastResult().content).toMatch(/^Not recorded/);
    }
    expect(listAnswers(db, interview.id, { includePrivate: true })).toEqual([]);
    // Whitespace differences and a contiguous part of the message are fine.
    override = recordOnce("  I led a team of 6 frontend engineers\n building the merchant dashboard ");
    await turn(ctx, conversation.id, ANSWERS.scope);
    expect(listAnswers(db, interview.id).map((a) => a.quote)).toEqual(["I led a team of 6 frontend engineers building the merchant dashboard"]);
  });

  it("rejects words from a context update, from the interviewer's own question, or from another conversation", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const role1 = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, role1.id, ANSWERS.scope);
    // The interviewer's next question is in its own words, not the candidate's.
    override = recordOnce("What were the main things you were accountable for?");
    await turn(ctx, role1.id, "Mostly the dashboard and the design system.");
    expect(lastResult()).toMatchObject({ is_error: true });

    // A form change becomes a <context_update> inside the next user message: still not the candidate's words.
    saveStageForm(db, reload(db, userId, interview), "current", { status: "employed", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-04", country: "AU" });
    override = recordOnce("The candidate updated the interview forms.");
    await turn(ctx, role1.id, "Also the component library used across 3 products.");
    const sent = requests.find((r) => JSON.stringify(r.messages).includes("<context_update>"));
    expect(sent).toBeDefined();
    expect(lastResult()).toMatchObject({ is_error: true });

    // Words typed in the exp-1 conversation can't be recorded from the exp-2 one.
    const role2 = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-2");
    override = recordOnce(ANSWERS.scope);
    await turn(ctx, role2.id, "Checkout flows for the web store.");
    expect(lastResult()).toMatchObject({ is_error: true });
    expect(listAnswers(db, interview.id).map((a) => a.quote)).toEqual([ANSWERS.scope]);
  });

  it("a failed turn leaves no recorded answers behind", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    // The follow-up request (carrying the tool result) is refused, so the whole turn is rolled back.
    override = (req) => {
      const last = req.body.messages.at(-1)!;
      const hasResult = Array.isArray(last.content) && (last.content as Array<{ type: string }>).some((b) => b.type === "tool_result");
      return hasResult ? { content: [{ type: "text", text: "" }], stop_reason: "refusal" } : demoInterviewer(req);
    };
    const events = await turn(ctx, conversation.id, ANSWERS.scope);
    expect(requests.length).toBe(2);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "refusal" }));
    expect(db.select().from(interviewAnswers).all()).toEqual([]);
    expect(db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversation.id)).all().map((m) => m.kind)).toEqual(["context"]);
  });

  it("checks one message at a time", () => {
    expect(verbatimGate("frontend engineers building", ["I led frontend engineers building it."])).toMatchObject({ ok: true, quote: "frontend engineers building" });
    expect(verbatimGate("first part and second part", ["first part", "and second part"])).toMatchObject({ ok: false, reason: "not_verbatim" });
    expect(verbatimGate("Led The Team Well", ["led the team well"])).toMatchObject({ ok: false, reason: "punctuation" });
    expect(verbatimGate("결제 화면을 만들었습니다", [ANSWERS.korean])).toMatchObject({ ok: true });
  });

  it("the interview tools have no union-typed parameters", () => {
    const unions = interviewTools().reduce((n, t) => n + countUnionParams(t.input_schema), 0);
    expect(unions).toBe(0);
  });
});

describe("CV interview — numbers must be typed as digits", () => {
  it("a bullet with 5 is backed by an answer typed as 5, not by one typed as five", () => {
    const line = (quote: string): CvLine => ({ id: "exp-1-b0", text: "Managed 5 direct reports.", sourceRefs: [{ source: "cv", quote, factId: null, verified: false }], requirementIds: [], origin: "ai" });
    const data = (highlight: string) => ({
      basics: { name: null, email: null, phone: null, headline: null, summary: null, city: null, country: null, links: [] },
      experience: [{ id: "exp-1", title: "Lead", company: "Wattle Labs", industry: null, location: null, country: null, start: "2020-01", end: null, seniority: null, skills: [], highlights: [highlight] }],
      skills: [],
      education: [],
      certifications: [],
      languages: [],
      clearances: [],
      workRights: [],
      facts: [],
    });
    const digits = "I have 5 direct reports in the platform team.";
    const words = "I have five direct reports in the platform team.";
    const flagsFor = (quote: string) => checkLine(line(quote), { roleId: "exp-1" }, buildProvenanceContext({ cvText: quote, data: data(quote) }, { analysis: null, score: null, plan: null })).map((f) => f.kind);
    expect(flagsFor(digits)).toEqual([]);
    expect(flagsFor(words)).toEqual(["number"]);
  });
});
