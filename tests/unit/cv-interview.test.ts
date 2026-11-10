import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { chatActions, chatMessages, conversations, interviewAnswers, tasks, type InterviewAnswerRow } from "@/server/db/schema";
import { listChatMessages, runChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { ensureInterviewConversation, interviewOpening, interviewTools, verbatimGate } from "@/server/ai/chat/interview";
import { acceptEditedPolish, resolveChatAction } from "@/server/ai/chat/actions";
import { getFakeGenerator, registerFakeGenerator, type FakeGenerator, type FakeRequest } from "@/server/ai/fake/transport";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import { DEMO_UNSUPPORTED_BULLET } from "@/server/ai/fake/generators/tailoring";
import { fakePolish } from "@/server/ai/fake/generators/interview";
import { countUnionParams } from "@/server/ai/schema-limits";
import {
  completeChatStage,
  createInterview,
  deleteAnswer,
  discardInterview,
  editAnswer,
  getInterview,
  listAnswers,
  reopenStage,
  saveStageForm,
  setStageStatus,
  stageHasAnswers,
  updateInterview,
  type Interview,
} from "@/server/repo/interviews";
import { getCurrentProfile, getPreferences, saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createJob } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { loadJobFit } from "@/server/jobs/fit";
import { isCvStale, recheckDocument, tailorCvForJob, writeLinkedinForUser } from "@/server/cv/tailor";
import { applyInterviewEdits, buildProfileFromInterview, generateBaseCv, interviewReady, mergePreferences, targetFromPreferences } from "@/server/cv/interview-build";
import { resolveCvLine } from "@/server/cv/resolve";
import { exportCv } from "@/server/cv/export";
import { cvProfileHash, latestCvDocument } from "@/server/repo/cv-documents";
import { enqueueTask } from "@/server/tasks/runner";
import { EXTRACT_PROFILE_TASK } from "@/server/tasks/handlers/extract-profile";
import { startBuildBaseCv } from "@/server/tasks/handlers/build-base-cv";
import { CONVERSATION_STAGES, interviewFormSchema } from "@/shared/schemas/interview";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { buildProvenanceContext, checkLine } from "@/server/cv/provenance";
import { blockingFlags, type CvLine } from "@/shared/schemas/cv";
import { testDb } from "../helpers/db";
import { right } from "../helpers/scoring";
import { ANSWERS } from "../helpers/interview";

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


/** The request carries tool results only (the model is called again within a turn), not a new message from the candidate. */
function toolRound(req: FakeRequest): boolean {
  const last = req.body.messages.at(-1)!;
  const blocks = Array.isArray(last.content) ? (last.content as Array<{ type: string; text?: string }>) : [];
  return blocks.some((b) => b.type === "tool_result") && !blocks.some((b) => b.type === "text" && !b.text?.startsWith("<context_update>"));
}

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
  // The demo interviewer opens with responsibilities, then asks about scope and an achievement.
  await turn(ctx, role1.id, ANSWERS.responsibility);
  await turn(ctx, role1.id, ANSWERS.scope);
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
      ["exp-1", "responsibility", ANSWERS.responsibility],
      ["exp-1", "scope", ANSWERS.scope],
      ["exp-1", "achievement", ANSWERS.achievement],
      ["exp-2", "responsibility", ANSWERS.korean],
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
    return toolRound(req) ? demoInterviewer(req) : { content: [{ type: "tool_use", id: `toolu_gate_${Math.random()}`, name: "record_answer", input: { topic: "scope", quote, private: false, question: "Scope?" } }] };
  };
  /** The result of the last record_answer call this test made. */
  const lastResult = () =>
    requests
      .flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) : [])))
      .filter((b) => b.type === "tool_result" && b.tool_use_id?.startsWith("toolu_gate_"))
      .at(-1)!;

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
      return toolRound(req) ? { content: [{ type: "text", text: "" }], stop_reason: "refusal" } : demoInterviewer(req);
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
    for (const stage of CONVERSATION_STAGES) {
      const unions = interviewTools(stage, { intake: true }).reduce((n, t) => n + countUnionParams(t.input_schema), 0);
      expect(unions, stage).toBe(0);
    }
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

// ---------------------------------------------------------------------------------------------
// MVP: the profile builder, readiness, Generate and the base CV

const row = (id: number, partial: Partial<InterviewAnswerRow>): InterviewAnswerRow => ({
  id,
  interviewId: 1,
  stage: "role_deep",
  topic: "achievement",
  experienceRef: "exp-1",
  question: "",
  quote: "",
  polished: null,
  private: false,
  origin: "chat",
  messageId: null,
  supersededBy: null,
  createdAt: new Date(0),
  ...partial,
});

function goldenSource() {
  const form = interviewFormSchema.parse({
    setup: { country: "NZ", language: "en" },
    target: { titles: ["Data Engineering Lead"], seniority: ["lead"], cities: ["Wellington"], workRights: [right("NZ", "citizen", "nz_citizen")] },
    current: { title: "Senior Data Engineer", company: "Kea Analytics", start: "2021-03" },
    roles: [
      { id: "exp-2", title: "Data Analyst", company: "Tui Insurance", start: "2016-02", end: "2021-02", depth: "brief" },
      { id: "exp-1", title: "Senior Data Engineer", company: "Kea Analytics", location: "Wellington", country: "NZ", start: "2021-03", end: "" },
    ],
    education: [{ id: "edu-1", institution: "Example University", degree: "BSc", field: "Statistics", country: "NZ", start: "2012", end: "2015" }],
    languages: [{ language: "English", level: "native" }],
    contact: { name: "Morgan Ellis", email: "morgan@example.com", phone: "021 555 0101" },
    skills: [
      { name: "SQL", category: "language", experienceRef: "exp-1", ticked: true },
      { name: "Airflow", category: "tool", experienceRef: "exp-1", ticked: false },
    ],
  });
  const answers = [
    row(1, { topic: "scope", quote: "I lead a team of 6 data engineers." }),
    row(2, { quote: "Cut   month-end close from 10 days\nto 4 days." }),
    row(3, { stage: "current", topic: "context", quote: "My manager is leaving and the team is shrinking.", private: true }),
    row(4, { experienceRef: "exp-2", topic: "responsibility", quote: "Built weekly claims reports in SQL for 3 regions." }),
    row(5, { experienceRef: null, stage: "contact", topic: "extra", quote: "Volunteer treasurer for a local rowing club since 2019." }),
    row(6, { topic: "tool", quote: "Old wording that I edited later.", supersededBy: 7 }),
    row(7, { topic: "tool", quote: "Mostly SQL, Python and Airflow.", origin: "user_edit" }),
  ];
  return { source: { form, stages: { "role:exp-1": "done" as const }, createdAt: new Date("2026-11-09T08:00:00Z") }, answers };
}

describe("CV interview — building the profile", () => {
  it("writes the Career record and profile from the answers, verbatim and in CV order", () => {
    const { source, answers } = goldenSource();
    const built = buildProfileFromInterview(source, answers, null);
    expect(built.cvText).toBe(
      [
        "CAREER RECORD — Huntloop interview, 2026-11-09",
        "CURRENT: Senior Data Engineer, Kea Analytics, 2021-03 – present",
        "ROLE exp-1: Senior Data Engineer — Kea Analytics (2021-03 – present, Wellington NZ)",
        "  scope: I lead a team of 6 data engineers.",
        "  achievement: Cut month-end close from 10 days to 4 days.",
        "  tool: Mostly SQL, Python and Airflow.",
        "ROLE exp-2: Data Analyst — Tui Insurance (2016-02 – 2021-02)",
        "  responsibility: Built weekly claims reports in SQL for 3 regions.",
        "EDUCATION: BSc, Statistics — Example University (2012 – 2015)",
        "LANGUAGES: English (native)",
        "SKILLS: SQL",
        "FACTS:",
        "  extra: Volunteer treasurer for a local rowing club since 2019.",
      ].join("\n"),
    );
    expect(built.data.experience.map((e) => [e.id, e.end, e.highlights])).toEqual([
      ["exp-1", null, ["I lead a team of 6 data engineers.", "Cut month-end close from 10 days to 4 days.", "Mostly SQL, Python and Airflow."]],
      ["exp-2", "2021-02", ["Built weekly claims reports in SQL for 3 regions."]],
    ]);
    expect(built.data.experience[0].skills).toEqual(["SQL"]);
    expect(built.data.skills).toEqual([{ name: "SQL", category: "language" }]);
    expect(built.data.facts).toEqual([{ id: "fact-int-5", text: "Volunteer treasurer for a local rowing club since 2019.", source: "interview" }]);
    expect(built.data.basics).toMatchObject({ name: "Morgan Ellis", email: "morgan@example.com", phone: "021 555 0101" });
    expect(built.data.workRights).toEqual([right("NZ", "citizen", "nz_citizen")]);
    expect(built.preferences).toMatchObject({ targetTitles: ["Data Engineering Lead"], markets: [{ country: "NZ", primary: true, cities: ["Wellington"], remoteOk: true }] });
    // Same input, same profile: Generate can tell a retry from a change.
    const again = buildProfileFromInterview(source, answers, null);
    expect(cvProfileHash(again.cvText, again.data)).toBe(cvProfileHash(built.cvText, built.data));
  });

  it("replacing a profile keeps the user's own and chat facts and other countries' work rights", () => {
    const { source, answers } = goldenSource();
    const previous = {
      ...buildProfileFromInterview(source, answers, null).data,
      facts: [
        { id: "f1", text: "From the old CV.", source: "cv" as const },
        { id: "f2", text: "Typed by me.", source: "user" as const },
        { id: "f3", text: "Said in a chat.", source: "chat" as const },
        { id: "fact-int-9", text: "From an older interview.", source: "interview" as const },
      ],
      workRights: [right("AU", "unrestricted_visa", "au_nz_citizen"), right("NZ", "needs_sponsorship")],
    };
    const built = buildProfileFromInterview(source, answers, previous);
    expect(built.data.facts.map((f) => f.id)).toEqual(["f2", "f3", "fact-int-5"]);
    expect(built.data.workRights).toEqual([right("AU", "unrestricted_visa", "au_nz_citizen"), right("NZ", "citizen", "nz_citizen")]);
  });

  it("needs a target, a role, the current role's chat and a name before generating", () => {
    const { source } = goldenSource();
    expect(interviewReady(source)).toEqual({ ok: true });
    expect(interviewReady({ ...source, stages: {} })).toEqual({ ok: false, missing: ["role_deep"] });
    const empty = interviewFormSchema.parse({});
    expect(interviewReady({ form: empty, stages: {} })).toEqual({ ok: false, missing: ["target", "roles", "contact"] });
    // An email is needed too, except when a finished interview is generated again.
    const noEmail = { ...source, form: { ...source.form, contact: { ...source.form.contact, email: "" } } };
    expect(interviewReady(noEmail)).toEqual({ ok: false, missing: ["contact"] });
    expect(interviewReady(noEmail, { regenerate: true })).toEqual({ ok: true });
  });
});

describe("CV interview — Generate and the base CV", () => {
  it("saves the profile and writes a base CV for the target market; flags block the download until dealt with", async () => {
    const { db, userId, ctx, interview } = await interviewOnlyProfile();
    const versionBefore = getCurrentProfile(db, userId)!.version;
    const doc = await generateBaseCv(ctx, interview.id);
    // The profile saved by interviewOnlyProfile() is the same: no duplicate version.
    expect(getCurrentProfile(db, userId)!.version).toBe(versionBefore);
    expect(doc).toMatchObject({ kind: "base", jobId: null, market: "AU", simulated: true });
    expect(doc.content).toMatchObject({ market: "AU", paper: "A4", pages: [2, 3], referees: true, workRight: { status: "citizen", country: "AU" } });
    expect(doc.content.header).toMatchObject({ name: "Morgan Ellis", email: "morgan@example.com", city: "Sydney" });
    expect(doc.content.roles.map((r) => r.experienceId)).toEqual(["exp-1", "exp-2"]);
    expect(doc.content.skills).toEqual(["React", "TypeScript"]);
    const blocking = blockingFlags(doc.flags);
    expect(blocking.map((f) => f.kind)).toEqual(["number", "number"]);
    expect(doc.flags.map((f) => f.kind)).not.toContain("unverified_source");
    expect(getInterview(db, userId, interview.id)).toMatchObject({ status: "completed", baseDocId: doc.id, profileVersion: versionBefore });
    expect(latestCvDocument(db, userId, "base", null)!.id).toBe(doc.id);

    await expect(exportCv(db, userId, doc.id, "docx")).rejects.toThrow("unresolved_flags");
    const after = resolveCvLine(db, userId, doc.id, blocking[0].lineId!, { kind: "remove" });
    expect(after.kind).toBe("base");
    expect(blockingFlags(after.flags)).toEqual([]);
    const file = await exportCv(db, userId, doc.id, "docx");
    expect(file).toMatchObject({ fileName: "Morgan-Ellis-CV.docx", mime: expect.stringContaining("wordprocessingml") });
    expect(() => recheckDocument(db, userId, latestCvDocument(db, userId, "base", null)!)).not.toThrow();

    // The tailored-CV flow still works on the new profile.
    const job = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING }));
    const tailored = await tailorCvForJob(ctx, job.id);
    expect(tailored.kind).toBe("cv");
    expect(isCvStale(latestCvDocument(db, userId, "base", null)!, getCurrentProfile(db, userId))).toBe(false);
  });

  it("refuses to generate an interview that isn't ready", async () => {
    const { ctx, interview } = setupInterview();
    await expect(generateBaseCv(ctx, interview.id)).rejects.toThrow("interview_too_short");
  });

  it("queues one Generate at a time, and none while a CV upload is being read", () => {
    const { db, userId, interview } = setupInterview();
    const first = startBuildBaseCv(db, userId, interview.id);
    expect(startBuildBaseCv(db, userId, interview.id)).toBe(first);
    db.update(tasks).set({ status: "succeeded" }).where(eq(tasks.id, first)).run();
    enqueueTask(db, userId, EXTRACT_PROFILE_TASK, { filePath: null, fileName: null, text: "x" });
    expect(() => startBuildBaseCv(db, userId, interview.id)).toThrow("task_running");
    expect(() => startBuildBaseCv(db, userId, 999)).toThrow("not_found");
  });
});

describe("CV interview — editing, resuming and discarding", () => {
  it("an edit supersedes the answer, a delete removes it with its history, and the interviewer hears about both", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.scope);
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    const [first, second] = listAnswers(db, interview.id);
    const current = reload(db, userId, interview);

    const edited = editAnswer(db, current, first.id, { quote: "I led a team of 7 frontend engineers." });
    expect(edited).toMatchObject({ origin: "user_edit", messageId: null, experienceRef: "exp-1", topic: "responsibility" });
    expect(listAnswers(db, interview.id).map((a) => a.quote)).toEqual([ANSWERS.responsibility, "I led a team of 7 frontend engineers."]);
    expect(listAnswers(db, interview.id, { includeSuperseded: true })).toHaveLength(3);
    expect(() => editAnswer(db, current, first.id, { quote: "again" })).toThrow("not_found");

    deleteAnswer(db, current, edited.id);
    expect(listAnswers(db, interview.id, { includeSuperseded: true }).map((a) => a.id)).toEqual([second.id]);

    await turn(ctx, conversation.id, ANSWERS.achievement);
    const update = (requests.find((r) => JSON.stringify(r.messages).includes("review drawer"))?.messages.at(-1)!.content as Array<{ text?: string }>).find((b) => b.text?.startsWith("<context_update>"));
    expect(update?.text).toContain("edited or deleted answers in the review drawer");
  });

  it("a conversation picked up on a later day is told it resumed", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.scope);
    const digest = JSON.parse(db.select().from(conversations).where(eq(conversations.id, conversation.id)).get()!.stateDigest!);
    db.update(conversations).set({ stateDigest: JSON.stringify({ ...digest, day: "2000-01-01" }) }).where(eq(conversations.id, conversation.id)).run();
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("The candidate resumed the interview on");
    // The same conversation continues: its earlier answer is still in the transcript.
    expect(listChatMessages({ db }, conversation.id).filter((m) => m.kind === "user").map((m) => m.text)).toEqual([ANSWERS.scope, ANSWERS.responsibility]);
  });

  it("discarding deletes the interview, its answers and every message of its conversations", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "current", null);
    await turn(ctx, conversation.id, ANSWERS.private);
    discardInterview(db, reload(db, userId, interview));
    expect(getInterview(db, userId, interview.id)).toBeNull();
    expect(db.select().from(interviewAnswers).all()).toEqual([]);
    expect(db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversation.id)).all()).toEqual([]);
    expect(db.select().from(conversations).where(eq(conversations.id, conversation.id)).get()).toBeUndefined();
  });
});

describe("CV interview — review fixes", () => {
  it("M1: a role added after another was removed gets a new id, never the removed role's answers or chat", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const acme = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-2");
    await turn(ctx, acme.id, "I cut month-end close from 10 days to 4 days.");
    await turn(ctx, acme.id, "That's all");
    let current = reload(db, userId, interview);
    // Remove exp-2 and add another role in the same save: new rows get their id from the server.
    current = saveStageForm(db, current, "roles", [current.form.roles[0], { id: "new-1", title: "Analyst", company: "Globex", start: "2015-01", end: "2017-12" }]);
    const globex = current.form.roles.find((r) => r.company === "Globex")!;
    expect(globex.id).not.toBe("exp-2");
    expect(current.stages[`role:${globex.id}`]).toBeUndefined();
    expect(ensureInterviewConversation(ctx, interview.id, "role_deep", globex.id).id).not.toBe(acme.id);

    // The removed role's answers are neither Globex highlights nor free-floating facts.
    const built = buildProfileFromInterview(current, listAnswers(db, interview.id, { includePrivate: true }), null);
    const everything = [built.cvText, ...built.data.experience.flatMap((e) => e.highlights), ...built.data.facts.map((f) => f.text)].join("\n");
    expect(everything).not.toContain("month-end close");
  });

  it("M1: seeding the current role never reuses an id that already has answers", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const role1 = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, role1.id, ANSWERS.scope);
    let current = saveStageForm(db, reload(db, userId, interview), "roles", []);
    current = saveStageForm(db, current, "current", { status: "employed", title: "Staff Engineer", company: "Initech", start: "2024-01", country: "AU" });
    expect(current.form.roles.map((r) => r.id)).not.toContain("exp-1");
  });

  it("M2: answers made private or deleted after Generate leave the saved profile at once", async () => {
    const { db, userId, ctx, interview } = await interviewOnlyProfile();
    const doc = await generateBaseCv(ctx, interview.id);
    const done = reload(db, userId, interview);
    const target = listAnswers(db, interview.id).find((a) => a.quote === ANSWERS.achievement)!;
    editAnswer(db, done, target.id, { private: true });
    applyInterviewEdits(db, userId, reload(db, userId, interview));
    const profile = getCurrentProfile(db, userId)!;
    expect([profile.cvText, ...profile.data.experience.flatMap((e) => e.highlights)].join("\n")).not.toContain("page load time");
    expect(reload(db, userId, interview).profileVersion).toBe(profile.version);
    // The base CV line that used it no longer verifies, and the CV says it's out of date.
    const base = latestCvDocument(db, userId, "base", null)!;
    expect(base.id).toBe(doc.id);
    expect(base.flags.some((f) => f.kind === "unverified_source")).toBe(true);
    expect(isCvStale(base, profile)).toBe(true);

    const other = listAnswers(db, interview.id).find((a) => a.quote === ANSWERS.responsibility)!;
    deleteAnswer(db, reload(db, userId, interview), other.id);
    applyInterviewEdits(db, userId, reload(db, userId, interview));
    expect(getCurrentProfile(db, userId)!.cvText).not.toContain("code reviews");
  });

  it("M2: edits never touch a profile that came from somewhere else (an uploaded CV)", async () => {
    const { db, userId, ctx, interview } = await interviewOnlyProfile();
    await generateBaseCv(ctx, interview.id);
    saveProfileVersion(db, userId, { cvText: "Morgan Ellis — uploaded CV text", data: getCurrentProfile(db, userId)!.data });
    const before = getCurrentProfile(db, userId)!.version;
    applyInterviewEdits(db, userId, reload(db, userId, interview));
    expect(getCurrentProfile(db, userId)!.version).toBe(before);
  });

  it("M3: the target job is not in the Career record, so it can't be quoted as experience", async () => {
    const { built } = await interviewOnlyProfile();
    expect(built.cvText).not.toMatch(/TARGET/);
    const pctx = buildProvenanceContext({ cvText: built.cvText, data: built.data }, { analysis: null, score: null, plan: null });
    const line: CvLine = { id: "summary-0", text: "Senior Frontend Engineer.", sourceRefs: [{ source: "cv", quote: "Senior Frontend Engineer · Sydney (AU) · senior", factId: null, verified: false }], requirementIds: [], origin: "ai" };
    expect(checkLine(line, { roleId: null }, pctx).map((f) => f.kind)).toContain("unverified_source");
  });

  it("m1: Generate keeps saved search preferences the interview didn't set", () => {
    const saved = { ...defaultPreferences(), seniority: ["senior" as const], workplace: ["remote" as const], employmentTypes: ["contract" as const], willingToRelocate: true };
    const merged = mergePreferences(saved, { targetTitles: ["Data Lead"], seniority: [], workplace: [], employmentTypes: [], willingToRelocate: false, markets: [{ country: "AU", primary: true, cities: [], remoteOk: true }] });
    expect(merged).toMatchObject({ targetTitles: ["Data Lead"], seniority: ["senior"], workplace: ["remote"], employmentTypes: ["contract"] });
  });
});

describe("CV interview — review round 2", () => {
  it("R2-1: a drawer edit after Generate keeps the user's own profile edits", async () => {
    const { db, userId, ctx, interview } = await interviewOnlyProfile();
    await generateBaseCv(ctx, interview.id);
    const generated = getCurrentProfile(db, userId)!;
    const data = structuredClone(generated.data);
    data.experience[0].title = "Lead Frontend Engineer";
    data.certifications.push({ name: "AWS Certified Developer", issuer: "AWS", year: "2024" });
    data.skills.push({ name: "GraphQL", category: "tool" });
    data.basics.phone = "0400 999 888";
    data.facts.push({ id: "fact-mine", text: "Typed by me in the editor.", source: "user" });
    saveProfileVersion(db, userId, { cvText: generated.cvText, data });

    const target = listAnswers(db, interview.id).find((a) => a.quote === ANSWERS.achievement)!;
    editAnswer(db, reload(db, userId, interview), target.id, { private: true });
    expect(applyInterviewEdits(db, userId, reload(db, userId, interview))).toBe(true);
    const after = getCurrentProfile(db, userId)!;
    expect(after.data.experience[0].title).toBe("Lead Frontend Engineer");
    expect(after.data.certifications.map((c) => c.name)).toContain("AWS Certified Developer");
    expect(after.data.skills.map((s) => s.name)).toContain("GraphQL");
    expect(after.data.basics.phone).toBe("0400 999 888");
    expect(after.data.facts.map((f) => f.id)).toContain("fact-mine");
    expect([after.cvText, ...after.data.experience.flatMap((e) => e.highlights)].join("\n")).not.toContain("page load time");
  });

  it("R2-2: answers about the most recent job, given before any role was on file, belong to that role, not to facts", async () => {
    const { db, userId } = testDb();
    const ctx = { db, userId };
    let interview = createInterview(db, userId, { country: "AU", language: "en" });
    interview = saveStageForm(db, interview, "current", { status: "between_roles", title: "Frontend Engineer", company: "Koala Commerce" });
    expect(interview.form.roles).toEqual([]);
    const conversation = ensureInterviewConversation(ctx, interview.id, "current", null);
    await turn(ctx, conversation.id, ANSWERS.week);
    expect(listAnswers(db, interview.id)[0].experienceRef).toBeNull();
    interview = saveStageForm(db, reload(db, userId, interview), "roles", [{ id: "new-1", title: "Frontend Engineer", company: "Koala Commerce", start: "2018-01", end: "2024-02" }]);
    const roleId = interview.form.roles[0].id;
    const built = buildProfileFromInterview(interview, listAnswers(db, interview.id, { includePrivate: true }), null);
    expect(built.data.experience[0].highlights).toEqual([ANSWERS.week]);
    expect(built.data.facts).toEqual([]);
    expect(built.cvText).toContain(`ROLE ${roleId}`);
    expect(built.cvText).not.toContain("FACTS:");
  });

  it("R2-3: saved preferences beyond the interview form's limits still pre-fill it", () => {
    const prefs = { ...defaultPreferences(), targetTitles: Array.from({ length: 30 }, (_, i) => `Title ${i} ${"x".repeat(150)}`), markets: [{ country: "AU", primary: true, cities: Array.from({ length: 25 }, (_, i) => `City ${i}`), remoteOk: false }] };
    const target = targetFromPreferences(prefs, "AU");
    expect(target.titles).toHaveLength(20);
    expect(target.titles[0].length).toBeLessThanOrEqual(120);
    expect(target.cities).toHaveLength(20);
    expect(target.remoteOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Owner feedback round: skip a question vs finish a part, undo, coverage, cleaner versions

const toolUsesIn = (db: ReturnType<typeof testDb>["db"], conversationId: number, from = 0) =>
  listChatMessages({ db }, conversationId)
    .filter((m) => m.kind === "assistant" && m.seq >= from)
    .flatMap((m) => (m.content as Array<{ type: string; name?: string; input?: Record<string, unknown> }>).filter((b) => b.type === "tool_use"));
const textsIn = (db: ReturnType<typeof testDb>["db"], conversationId: number, from = 0) =>
  listChatMessages({ db }, conversationId)
    .filter((m) => m.kind === "assistant" && m.seq >= from)
    .flatMap((m) => (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? ""));
const nextSeq = (db: ReturnType<typeof testDb>["db"], conversationId: number) => listChatMessages({ db }, conversationId).length;

describe("CV interview — skipping a question, finishing a part, undo", () => {
  it("one answer turn asks exactly one next question, with examples, after offering a cleaner version", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    expect(toolUsesIn(db, conversation.id).map((b) => b.name)).toEqual(["record_answer", "propose_polish", "suggest_options"]);
    const texts = textsIn(db, conversation.id).filter(Boolean);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/How big was that\?/);
    expect(texts[0]).not.toContain("—");
  });

  it("'Skip this question' moves on without recording; a short reply gets a re-ask; 'That's all for this part' finishes once (bug 2)", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    const before = listAnswers(db, interview.id).length;

    let from = nextSeq(db, conversation.id);
    await turn(ctx, conversation.id, "Skip this question");
    expect(toolUsesIn(db, conversation.id, from).map((b) => b.name)).toEqual(["suggest_options"]);
    expect(textsIn(db, conversation.id, from).join(" ")).toMatch(/proudest/);
    expect(listAnswers(db, interview.id)).toHaveLength(before);
    expect(reload(db, userId, interview).stages["role:exp-1"]).toBeUndefined();

    from = nextSeq(db, conversation.id);
    await turn(ctx, conversation.id, "Ok");
    expect(toolUsesIn(db, conversation.id, from).map((b) => b.name)).toEqual(["suggest_options"]);
    expect(textsIn(db, conversation.id, from).join(" ")).toMatch(/say a bit more[\s\S]*proudest/);

    from = nextSeq(db, conversation.id);
    await turn(ctx, conversation.id, "That's all for this part");
    const finish = toolUsesIn(db, conversation.id, from).filter((b) => b.name === "complete_stage");
    expect(finish).toHaveLength(1);
    expect(finish[0].input).toMatchObject({ reason: "candidate_finished" });
    expect(reload(db, userId, interview).stages["role:exp-1"]).toBe("done");

    from = nextSeq(db, conversation.id);
    await turn(ctx, conversation.id, "That's all for this part");
    expect(toolUsesIn(db, conversation.id, from)).toEqual([]);
    expect(textsIn(db, conversation.id, from).join(" ")).toMatch(/already finished/);
  });

  it("a skipped part can be undone, and Continue counts a skipped part with answers as done (bug 1)", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    let current = setStageStatus(db, interview, "role:exp-1", "skipped");
    current = reopenStage(db, current, "role:exp-1");
    expect(reload(db, userId, interview).stages["role:exp-1"]).toBe("pending");
    current = reopenStage(db, setStageStatus(db, current, "education", "skipped"), "education");
    expect(reload(db, userId, interview)).toMatchObject({ stage: "education", stages: { education: "pending" } });

    current = setStageStatus(db, current, "role:exp-1", "skipped");
    expect(stageHasAnswers(db, current, "role:exp-1")).toBe(false);
    expect(completeChatStage(db, current, "role:exp-1", false).stages["role:exp-1"]).toBe("skipped");
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    current = reload(db, userId, interview);
    expect(stageHasAnswers(db, current, "role:exp-1")).toBe(true);
    expect(stageHasAnswers(db, current, "role:exp-2")).toBe(false);
    expect(completeChatStage(db, current, "role:exp-1", true).stages["role:exp-1"]).toBe("done");
  });

  it("after Reopen the interviewer carries on with the next question", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    await turn(ctx, conversation.id, "That's all for this part");
    reopenStage(db, reload(db, userId, interview), "role:exp-1");
    const from = nextSeq(db, conversation.id);
    await turn(ctx, conversation.id, ANSWERS.scope);
    expect(toolUsesIn(db, conversation.id, from).map((b) => b.name)).toContain("record_answer");
    expect(listAnswers(db, interview.id).at(-1)).toMatchObject({ quote: ANSWERS.scope, topic: "scope" });
  });

  it("'covered' is refused while a required topic is missing; the candidate can always finish", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    const finishWith = (reason: string) => (req: FakeRequest) =>
      toolRound(req) ? { content: [{ type: "text", text: "Ok." }] } : { content: [{ type: "tool_use", id: `toolu_finish_${Math.random()}`, name: "complete_stage", input: { summary: "Done.", reason } }] };
    override = finishWith("covered");
    await turn(ctx, conversation.id, "I think we covered it all.");
    const result = requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) : []))).filter((b) => b.type === "tool_result" && b.tool_use_id?.startsWith("toolu_finish_")).at(-1)!;
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toMatch(/scope, achievement/);
    expect(reload(db, userId, interview).stages["role:exp-1"]).toBeUndefined();
    override = finishWith("candidate_finished");
    await turn(ctx, conversation.id, "Let's stop here please.");
    expect(reload(db, userId, interview).stages["role:exp-1"]).toBe("done");
  });

  it("a conversation from the older interviewer is replaced; its answers stay", async () => {
    const { db, ctx, interview } = setupInterview();
    const old = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, old.id, ANSWERS.responsibility);
    db.update(conversations).set({ toolsetVersion: 1 }).where(eq(conversations.id, old.id)).run();
    const fresh = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    expect(fresh.id).not.toBe(old.id);
    expect(ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1").id).toBe(fresh.id);
    expect(listAnswers(db, interview.id).map((a) => a.quote)).toEqual([ANSWERS.responsibility]);
  });

  it("the opening question names the role and gives examples for it", () => {
    const { db, userId } = testDb();
    let interview = createInterview(db, userId, { country: "NZ", language: "en" });
    interview = saveStageForm(db, interview, "current", { status: "employed", title: "Head of Data", company: "PB" });
    const opening = interviewOpening(interview, "role_deep", interview.form.roles[0].id);
    expect(opening.text).toMatch(/Head of Data at PB/);
    expect(opening.options).toEqual(expect.arrayContaining(["Data governance and quality"]));
    expect(interviewOpening(interview, "current", null).text).toMatch(/You're Head of Data at PB right now/);
  });
});

describe("CV interview — cleaner versions of answers", () => {
  const polishCards = (db: ReturnType<typeof testDb>["db"], conversationId: number) => db.select().from(chatActions).where(eq(chatActions.conversationId, conversationId)).all();

  it("offers a checked cleaner version as a card; accepting it makes it the evidence, the raw words stay", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    const [card] = polishCards(db, conversation.id);
    expect(card).toMatchObject({ kind: "interview_polish", status: "pending", payload: { raw: ANSWERS.responsibility, text: fakePolish(ANSWERS.responsibility) } });

    resolveChatAction(ctx, card.id, "accept");
    const [answer] = listAnswers(db, interview.id);
    expect(answer).toMatchObject({ quote: ANSWERS.responsibility, polished: fakePolish(ANSWERS.responsibility) });
    const built = buildProfileFromInterview(reload(db, userId, interview), listAnswers(db, interview.id, { includePrivate: true }), null);
    expect(built.cvText).toContain(`responsibility: ${fakePolish(ANSWERS.responsibility)}`);
    expect(built.cvText).not.toContain(ANSWERS.responsibility);
    expect(built.data.experience[0].highlights).toEqual([fakePolish(ANSWERS.responsibility)]);

    // Editing the answer in the drawer goes back to the user's own (new) words.
    const edited = editAnswer(db, reload(db, userId, interview), answer.id, { quote: "Frontend architecture and code reviews for the team." });
    expect(edited.polished).toBeNull();
  });

  it("keeping their words leaves the answer as typed", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    const [card] = polishCards(db, conversation.id);
    resolveChatAction(ctx, card.id, "dismiss");
    expect(listAnswers(db, interview.id)[0].polished).toBeNull();
    expect(polishCards(db, conversation.id)[0].status).toBe("dismissed");
  });

  it("refuses a version that adds a number or a stock phrase", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    for (const [text, why] of [
      ["Accountable for frontend architecture, code reviews and mentoring 6 engineers.", /adds the number "6"/],
      ["Spearheaded frontend architecture, code reviews and mentoring 4 engineers.", /style rules/],
    ] as const) {
      override = (req) => {
        if (!toolRound(req)) return demoInterviewer(req);
        const last = req.body.messages.at(-1)!.content as Array<{ content?: string }>;
        const id = /Recorded #(\d+)/.exec(last.map((b) => String(b.content)).join(" "))?.[1];
        return id ? { content: [{ type: "tool_use", id: `toolu_polish_${Math.random()}`, name: "propose_polish", input: { answer_id: Number(id), text } }] } : { content: [{ type: "text", text: "Next?" }] };
      };
      await turn(ctx, conversation.id, ANSWERS.responsibility);
      const result = requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) : []))).filter((b) => b.type === "tool_result" && b.tool_use_id?.startsWith("toolu_polish_")).at(-1)!;
      expect(result).toMatchObject({ is_error: true });
      expect(result.content).toMatch(why);
    }
    expect(polishCards(db, conversation.id)).toEqual([]);
  });

  it("a refused turn after a cleaner version was offered leaves no card and no answer behind", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    override = (req) => {
      const reply = demoInterviewer(req) as { content: Array<{ name?: string }> };
      const polishResult = JSON.stringify(req.body.messages.at(-1)).includes("Shown to the candidate as a card");
      return polishResult ? { content: [{ type: "text", text: "" }], stop_reason: "refusal" } : reply;
    };
    const events = await turn(ctx, conversation.id, ANSWERS.responsibility);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "refusal" }));
    expect(polishCards(db, conversation.id)).toEqual([]);
    expect(db.select().from(interviewAnswers).all()).toEqual([]);
  });

  it("a revision may not drop an employer from the forms, even one that looks like a verb", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const current = reload(db, userId, interview);
    saveStageForm(db, current, "roles", [{ ...current.form.roles[0], company: "Boeing" }, current.form.roles[1]]);
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    override = (req) => {
      if (!toolRound(req)) return demoInterviewer(req);
      const last = req.body.messages.at(-1)!.content as Array<{ content?: string }>;
      const id = /Recorded #(\d+)/.exec(last.map((b) => String(b.content)).join(" "))?.[1];
      return id ? { content: [{ type: "tool_use", id: `toolu_keep_${Math.random()}`, name: "propose_polish", input: { answer_id: Number(id), text: "Hired to lead 6 frontend engineers." } }] } : { content: [{ type: "text", text: "Next?" }] };
    };
    await turn(ctx, conversation.id, "Boeing hired me to lead 6 frontend engineers.");
    const result = requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) : []))).filter((b) => b.type === "tool_result" && b.tool_use_id?.startsWith("toolu_keep_")).at(-1)!;
    expect(result).toMatchObject({ is_error: true });
    expect(result.content).toMatch(/drops "Boeing"/);
  });

  it("a one-word job title doesn't hold a revision to that word", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const current = reload(db, userId, interview);
    saveStageForm(db, current, "roles", [{ ...current.form.roles[0], title: "Manager" }, { ...current.form.roles[1], title: "Lead" }]);
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    for (const [said, text] of [
      ["I was the manager of 5 analysts.", "Managed 5 analysts."],
      ["I lead the team of 5 analysts.", "Led the team of 5 analysts."],
    ]) {
      override = (req) => {
        if (!toolRound(req)) return demoInterviewer(req);
        const last = req.body.messages.at(-1)!.content as Array<{ content?: string }>;
        const id = /Recorded #(\d+)/.exec(last.map((b) => String(b.content)).join(" "))?.[1];
        return id ? { content: [{ type: "tool_use", id: `toolu_title_${Math.random()}`, name: "propose_polish", input: { answer_id: Number(id), text } }] } : { content: [{ type: "text", text: "Next?" }] };
      };
      await turn(ctx, conversation.id, said);
      const result = requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) : []))).filter((b) => b.type === "tool_result" && b.tool_use_id?.startsWith("toolu_title_")).at(-1)!;
      expect(result.is_error, String(result.content)).toBeFalsy();
    }
  });

  it("a quick reply is never recorded as an answer", async () => {
    const { db, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    for (const control of ["Skip this question", "That's all for this part"]) {
      override = (req) => (toolRound(req) ? { content: [{ type: "text", text: "Ok." }] } : { content: [{ type: "tool_use", id: `toolu_ctl_${Math.random()}`, name: "record_answer", input: { topic: "extra", quote: control, private: false, question: "?" } }] });
      await turn(ctx, conversation.id, control);
      const result = requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; content?: string; is_error?: boolean }>) : []))).filter((b) => b.type === "tool_result" && b.tool_use_id?.startsWith("toolu_ctl_")).at(-1)!;
      expect(result).toMatchObject({ is_error: true });
      expect(result.content).toMatch(/quick replies/);
    }
    expect(listAnswers(db, interview.id, { includePrivate: true })).toEqual([]);
  });

  it("the user's own edit of a cleaner version is used; on an answer changed since, the card just closes", async () => {
    const { db, userId, ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    await turn(ctx, conversation.id, ANSWERS.responsibility);
    await turn(ctx, conversation.id, ANSWERS.scope);
    const [first, second] = polishCards(db, conversation.id);
    acceptEditedPolish(ctx, reload(db, userId, interview), first.id, "Owned frontend architecture, code reviews and mentoring 4 engineers.");
    expect(listAnswers(db, interview.id)[0].polished).toBe("Owned frontend architecture, code reviews and mentoring 4 engineers.");
    expect(polishCards(db, conversation.id)[0]).toMatchObject({ status: "accepted", payload: { edited: true } });

    const answer = listAnswers(db, interview.id).find((a) => a.quote === ANSWERS.scope)!;
    editAnswer(db, reload(db, userId, interview), answer.id, { quote: "A team of 6 frontend engineers on the merchant dashboard." });
    expect(acceptEditedPolish(ctx, reload(db, userId, interview), second.id, "Led 6 frontend engineers.")).toBe(false);
    expect(polishCards(db, conversation.id)[1].status).toBe("dismissed");
    expect(listAnswers(db, interview.id).find((a) => a.quote.startsWith("A team of 6"))!.polished).toBeNull();
  });

  it("examples with digits are refused", async () => {
    const { ctx, interview } = setupInterview();
    const conversation = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    override = (req) => (toolRound(req) ? { content: [] } : { content: [{ type: "text", text: "How big?" }, { type: "tool_use", id: `toolu_opts_${Math.random()}`, name: "suggest_options", input: { options: ["Team of 10", "Budget"] } }] });
    await turn(ctx, conversation.id, "Let me think about it.");
    const result = requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<{ type: string; tool_use_id?: string; is_error?: boolean }>) : []))).find((b) => b.type === "tool_result" && b.tool_use_id?.startsWith("toolu_opts_"));
    expect(result).toMatchObject({ is_error: true });
  });
});
