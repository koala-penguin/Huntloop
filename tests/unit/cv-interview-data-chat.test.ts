import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatActions, chatMessages, conversations } from "@/server/db/schema";
import { listChatMessages, runChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { INTERVIEW_TOOLSET_VERSION, conversationOpening, ensureInterviewConversation, interviewOpening, interviewTools } from "@/server/ai/chat/interview";
import { acceptFormCard, continueBlockers, continueDataStage, saveOnFile } from "@/server/ai/chat/interview-forms";
import { resolveChatAction } from "@/server/ai/chat/actions";
import { getFakeGenerator, registerFakeGenerator, type FakeGenerator, type FakeRequest } from "@/server/ai/fake/transport";
import { parseCurrent, parseEducation, parseLanguages, parseRoles, parseSetup, parseTarget, splitList } from "@/server/ai/fake/generators/interview-data";
import { createInterview, getInterview, listAnswers, saveStageForm, type Interview } from "@/server/repo/interviews";
import { interviewReadiness } from "@/server/cv/interview-build";
import { answerRole, cardValueOf, type FormCardValue } from "@/shared/schemas/interview";
import { testDb } from "../helpers/db";
import { ANSWERS, DATA_ANSWERS } from "../helpers/interview";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-interview-data-"));
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

type Db = ReturnType<typeof testDb>["db"];
type Blocks = Array<{ type: string; text?: string; name?: string; id?: string; tool_use_id?: string; content?: string; is_error?: boolean; input?: Record<string, unknown> }>;

/** The request carries tool results only (the model is called again within a turn), not a new message from the candidate. */
function toolRound(req: FakeRequest): boolean {
  const last = req.body.messages.at(-1)!;
  const blocks = Array.isArray(last.content) ? (last.content as Blocks) : [];
  return blocks.some((b) => b.type === "tool_result") && !blocks.some((b) => b.type === "text" && !b.text?.startsWith("<context_update>"));
}

async function turn(ctx: Parameters<typeof runChatTurn>[0], conversationId: number, text: string) {
  const events: ChatEvent[] = [];
  await runChatTurn(ctx, conversationId, text, (e) => events.push(e));
  return events;
}

let calls = 0;
/** A model that answers a typed message with one tool call, then a short question. */
const propose = (name: string, input: Record<string, unknown>): FakeGenerator => (req) =>
  toolRound(req) ? { content: [{ type: "text", text: "What came before that?" }] } : { content: [{ type: "tool_use", id: `toolu_form_${calls++}`, name, input }] };

const toolResults = () => requests.flatMap((r) => r.messages.flatMap((m) => (Array.isArray(m.content) ? (m.content as Blocks) : []))).filter((b) => b.type === "tool_result");
const lastResult = () => toolResults().at(-1)!;
const cards = (db: Db, conversationId: number) =>
  db
    .select()
    .from(chatActions)
    .where(and(eq(chatActions.conversationId, conversationId), eq(chatActions.kind, "interview_form")))
    .all()
    .map((a) => ({ ...a, payload: a.payload as { stage: string; value: unknown; inferred: string[]; unresolved: string[]; dropped: string[]; replaced?: boolean; edited?: boolean } }));
const reload = (db: Db, userId: number, interview: Interview) => getInterview(db, userId, interview.id)!;
const role = (patch: Record<string, unknown>) => ({ id: "", title: "", company: "", industry: "", location: "", start: "", end: "", current: false, employment_type: "full_time", ...patch });

/** A new interview: the target is filled from the saved search, nothing else. */
function fresh(setup: { language?: "en" | "ko" } = {}) {
  const { db, userId } = testDb();
  let interview = createInterview(db, userId, { country: "AU", language: "en", ...setup });
  interview = saveStageForm(db, interview, "target", { titles: ["Senior Frontend Engineer"] });
  return { db, userId, ctx: { db, userId }, interview };
}

/** …and with the current job on file (exp-1) and contact details. */
function started() {
  const env = fresh();
  let interview = saveStageForm(env.db, env.interview, "current", { status: "employed", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-03" });
  interview = saveStageForm(env.db, interview, "contact", { name: "Morgan Ellis", email: "morgan@example.com", phone: "0400 111 222" });
  return { ...env, interview };
}

/** Per turn: how many assistant texts and example lists were sent (a turn is one question, at most one set of examples). */
function turnShape(db: Db, conversationId: number) {
  const shape: Array<{ texts: number; examples: number }> = [];
  for (const row of listChatMessages({ db }, conversationId)) {
    if (row.kind === "user") shape.push({ texts: 0, examples: 0 });
    if (row.kind !== "assistant") continue;
    const blocks = row.content as Blocks;
    shape.at(-1)!.texts += blocks.filter((b) => b.type === "text" && b.text?.trim()).length;
    shape.at(-1)!.examples += blocks.filter((b) => b.type === "tool_use" && b.name === "suggest_options").length;
  }
  return shape;
}
const assistantText = (db: Db, conversationId: number) =>
  listChatMessages({ db }, conversationId)
    .filter((r) => r.kind === "assistant")
    .flatMap((r) => (r.content as Blocks).filter((b) => b.type === "text").map((b) => b.text ?? ""))
    .join("\n");

describe("data chat — the card is the only way into the form", () => {
  it("shows only what the candidate typed, saves nothing until they accept, then files the role under a new id", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    override = propose("propose_roles", { roles: [role({ title: "Frontend Engineer", company: "Acme Corp", start: "2018-01", end: "2021-02" })] });
    const events = await turn(ctx, conversation.id, "I was a Frontend Engineer from 2018-01 to 2021-02");
    const [card] = cards(db, conversation.id);
    expect(card.status).toBe("pending");
    expect((card.payload.value as FormCardValue<"roles">).roles[0]).toMatchObject({ title: "Frontend Engineer", company: "", start: "2018-01", end: "2021-02" });
    expect(card.payload.dropped).toEqual(["roles.0.company"]);
    expect(lastResult().content).toMatch(/Left out because they did not type it: employer of role 1/);
    expect(events).toContainEqual({ type: "card", actionId: card.id });
    expect(events).toContainEqual({ type: "tool", name: "propose_roles", detail: null });
    // Nothing reached the form, and the step is not marked done.
    expect(reload(db, userId, interview).form.roles.map((r) => r.id)).toEqual(["exp-1"]);
    expect(reload(db, userId, interview).stages.roles).toBeUndefined();

    expect(acceptFormCard(ctx, reload(db, userId, interview), card.id)).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.roles.map((r) => [r.id, r.title, r.company, r.end])).toEqual([
      ["exp-1", "Senior Frontend Engineer", "Harbour Payments", ""],
      ["exp-2", "Frontend Engineer", "", "2021-02"],
    ]);
    expect(cards(db, conversation.id)[0]).toMatchObject({ status: "accepted", payload: { edited: false } });
    // The interviewer hears about it on the next message.
    override = propose("propose_roles", { roles: [] });
    await turn(ctx, conversation.id, "That's everything");
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("The candidate saved the card. On file now:");
  });

  it("refuses a proposal with nothing of the candidate's in it, and one that is already on file", async () => {
    const { db, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    override = propose("propose_roles", { roles: [role({ title: "Wizard", company: "Hogwarts", start: "1997" })] });
    await turn(ctx, conversation.id, "I'd rather not go into it");
    expect(lastResult()).toMatchObject({ is_error: true });
    expect(lastResult().content).toMatch(/^Not shown: none of this is in the candidate's messages/);
    override = propose("propose_roles", { roles: [role({ id: "exp-1", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-03", current: true })] });
    await turn(ctx, conversation.id, "Senior Frontend Engineer at Harbour Payments since 2021-03, still there");
    expect(lastResult()).toMatchObject({ is_error: true, content: "That is already on file. Ask your next question." });
    expect(cards(db, conversation.id)).toEqual([]);
    // A tool the step doesn't have is refused too.
    override = propose("record_answer", { topic: "scope", quote: "I'd rather not go into it", private: false, question: "?" });
    await turn(ctx, conversation.id, "One more thing about that job");
    expect(lastResult()).toMatchObject({ is_error: true, content: "Unknown tool record_answer" });
  });

  it("a second proposal carries the first, and using the newest card closes the older one", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    override = propose("propose_roles", { roles: [role({ title: "Barista", company: "Bean There", start: "2015", end: "2016" })] });
    await turn(ctx, conversation.id, "Barista at Bean There 2015-2016");
    override = propose("propose_roles", { roles: [role({ title: "Waiter", company: "Cafe Uno", start: "2014", end: "2015" })] });
    await turn(ctx, conversation.id, "Waiter at Cafe Uno 2014-2015");
    const [first, second] = cards(db, conversation.id);
    // The tool closes nothing itself: a turn that fails after it must leave the older card as it was.
    expect([first.status, second.status]).toEqual(["pending", "pending"]);
    expect((second.payload.value as FormCardValue<"roles">).roles.map((r) => r.title)).toEqual(["Barista", "Waiter"]);

    // The older card can no longer be used: it is closed as replaced.
    expect(() => acceptFormCard(ctx, reload(db, userId, interview), first.id)).toThrow("card_replaced");
    expect(cards(db, conversation.id)[0]).toMatchObject({ status: "dismissed", payload: { replaced: true } });
    expect(reload(db, userId, interview).form.roles.length).toBe(1);

    expect(acceptFormCard(ctx, reload(db, userId, interview), second.id)).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.roles.map((r) => r.title)).toEqual(["Senior Frontend Engineer", "Barista", "Waiter"]);
  });

  it("resolving the newest card closes older ones still waiting", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    override = propose("propose_roles", { roles: [role({ title: "Barista", company: "Bean There", start: "2015", end: "2016" })] });
    await turn(ctx, conversation.id, "Barista at Bean There 2015-2016");
    override = propose("propose_roles", { roles: [role({ title: "Waiter", company: "Cafe Uno", start: "2014", end: "2015" })] });
    await turn(ctx, conversation.id, "Waiter at Cafe Uno 2014-2015");
    const [first, second] = cards(db, conversation.id);
    resolveChatAction(ctx, second.id, "accept");
    expect(cards(db, conversation.id).map((c) => [c.id, c.status, !!c.payload.replaced])).toEqual([
      [first.id, "dismissed", true],
      [second.id, "accepted", false],
    ]);
    expect(reload(db, userId, interview).form.roles.length).toBe(3);
    // A replaced card is not reported to the interviewer as a dismissal.
    override = propose("propose_roles", { roles: [] });
    await turn(ctx, conversation.id, "That's everything");
    const sent = JSON.stringify(requests.at(-1)!.messages);
    expect(sent).toContain("The candidate saved the card.");
    expect(sent).not.toContain("dismissed the card");
  });

  it("a turn that fails after a proposal leaves no card, and the card from before is still usable", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    override = propose("propose_roles", { roles: [role({ title: "Barista", company: "Bean There", start: "2015", end: "2016" })] });
    await turn(ctx, conversation.id, "Barista at Bean There 2015-2016");
    const [first] = cards(db, conversation.id);
    // The follow-up request (carrying the tool result) is refused, so the whole turn is rolled back.
    const second = propose("propose_roles", { roles: [role({ title: "Waiter", company: "Cafe Uno", start: "2014", end: "2015" })] });
    override = (req) => (toolRound(req) ? { content: [{ type: "text", text: "" }], stop_reason: "refusal" } : second(req));
    const events = await turn(ctx, conversation.id, "Waiter at Cafe Uno 2014-2015");
    expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "refusal" }));
    expect(cards(db, conversation.id).map((c) => [c.id, c.status, !!c.payload.replaced])).toEqual([[first.id, "pending", false]]);
    expect(acceptFormCard(ctx, reload(db, userId, interview), first.id)).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.roles.map((r) => r.title)).toEqual(["Senior Frontend Engineer", "Barista"]);
  });

  it("checks a card when it is accepted, whichever way the accept arrives", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    override = propose("propose_roles", { roles: [role({ title: "Barista", company: "Bean There", start: "2015", current: true })] });
    await turn(ctx, conversation.id, "Barista at Bean There from 2015");
    const [card] = cards(db, conversation.id);
    expect(card.payload.unresolved).toEqual(["roles.0.current"]);
    const value = card.payload.value as FormCardValue<"roles">;
    // Neither an end date nor "still there": refused from the card's button and from the generic one.
    expect(acceptFormCard(ctx, interview, card.id)).toEqual({ ok: false, error: "invalid", fields: ["roles.0.end"] });
    expect(() => resolveChatAction(ctx, card.id, "accept")).toThrow("invalid");
    expect(acceptFormCard(ctx, interview, card.id, { roles: [{ ...value.roles[0], end: "2021-13" }] })).toMatchObject({ ok: false, error: "invalid" });
    expect(acceptFormCard(ctx, interview, card.id, { roles: [{ ...value.roles[0], title: "", end: "2016" }] })).toEqual({ ok: false, error: "invalid", fields: ["roles.0.title"] });
    expect(acceptFormCard(ctx, interview, card.id, { roles: [{ ...value.roles[0], end: "2014" }] })).toEqual({ ok: false, error: "invalid", fields: ["roles.0.order"] });
    expect(cards(db, conversation.id)[0].status).toBe("pending");
    expect(reload(db, userId, interview).form.roles.length).toBe(1);

    // Another interview's card is not found.
    const other = started();
    expect(() => acceptFormCard(other.ctx, other.interview, card.id)).toThrow("not_found");

    // Their own edit is what gets saved.
    expect(acceptFormCard(ctx, interview, card.id, { roles: [{ ...value.roles[0], company: "Bean There Cafe", end: "2016-06", country: "NZ" }] })).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.roles[1]).toMatchObject({ id: "exp-2", company: "Bean There Cafe", end: "2016-06", country: "NZ" });
    expect(cards(db, conversation.id)[0]).toMatchObject({ status: "accepted", payload: { edited: true } });
    // Already resolved: nothing happens.
    expect(acceptFormCard(ctx, reload(db, userId, interview), card.id, { roles: [{ ...value.roles[0], end: "2019" }] })).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.roles[1].end).toBe("2016-06");
  });

  it("a card with a malformed month is refused by its shape", async () => {
    const { db, userId, ctx, interview } = fresh();
    const conversation = ensureInterviewConversation(ctx, interview.id, "current", null);
    override = propose("propose_current", { status: "employed", title: "Barista", company: "Bean There", start: "" });
    await turn(ctx, conversation.id, "I'm a Barista at Bean There");
    const [card] = cards(db, conversation.id);
    expect(acceptFormCard(ctx, interview, card.id, { ...(card.payload.value as object), start: "2021-13" })).toEqual({ ok: false, error: "invalid", fields: ["start"] });
    expect(reload(db, userId, interview).form.current.title).toBe("");
  });

  it("a language without a level typed has to be given one on the card", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "languages", null);
    override = propose("propose_languages", { languages: [{ language: "Korean", level: "native" }] });
    await turn(ctx, conversation.id, "Korean");
    const [card] = cards(db, conversation.id);
    expect(card.payload).toMatchObject({ value: { languages: [{ language: "Korean", level: "" }] }, unresolved: ["languages.0.level"] });
    expect(acceptFormCard(ctx, interview, card.id)).toEqual({ ok: false, error: "invalid", fields: ["languages.0.level"] });
    expect(acceptFormCard(ctx, interview, card.id, { languages: [{ language: "Korean", level: "fluent" }] })).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.languages).toEqual([{ language: "Korean", level: "fluent" }]);
  });

  it("dismissing a card saves nothing and the interviewer is told", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "education", null);
    override = propose("propose_education", { education: [{ institution: "Example University", degree: "BSc", field: "", start: "", end: "" }], certifications: [] });
    await turn(ctx, conversation.id, "BSc at Example University");
    const [card] = cards(db, conversation.id);
    resolveChatAction(ctx, card.id, "dismiss");
    expect(reload(db, userId, interview).form.education).toEqual([]);
    await turn(ctx, conversation.id, "It was actually a BA");
    expect(JSON.stringify(requests.at(-1)!.messages)).toContain("The candidate dismissed the card; nothing was saved.");
  });
});

describe("data chat — the candidate's situation", () => {
  it("ticks only what they said, in English or Korean; a description nobody typed is never ticked", async () => {
    const { db, userId, ctx, interview } = fresh();
    const conversation = ensureInterviewConversation(ctx, interview.id, "setup", null);
    expect((conversation.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["propose_setup", "suggest_options"]);
    // The model claims three things; the candidate said one.
    override = propose("propose_setup", { personas: ["career_changer", "senior_exec", "migrant"] });
    await turn(ctx, conversation.id, "I've been teaching for ten years and I'm changing careers into data analysis.");
    const [card] = cards(db, conversation.id);
    expect(card.payload).toMatchObject({ stage: "setup", value: { personas: ["career_changer"], language: "en", country: "AU", depth: "full" }, inferred: ["personas"] });
    expect(reload(db, userId, interview).form.setup.personas).toEqual([]);
    expect(reload(db, userId, interview).personas).toEqual([]);

    // Nothing they said: no card at all.
    override = propose("propose_setup", { personas: ["senior_exec"] });
    await turn(ctx, conversation.id, "I mostly want a steadier job.");
    expect(lastResult()).toMatchObject({ is_error: true });
    expect(cards(db, conversation.id).length).toBe(1);

    // Korean words count too, and the new card keeps what the waiting one had.
    override = propose("propose_setup", { personas: ["returning", "migrant"] });
    await turn(ctx, conversation.id, "육아로 5년 쉬다가 재취업하려고 해요. 작년에 이민 왔어요.");
    const second = cards(db, conversation.id)[1];
    expect(second.payload.value).toMatchObject({ personas: ["career_changer", "returning", "migrant"] });

    // Their own pick on the card is theirs to make: unticking one and ticking another is what gets saved.
    expect(acceptFormCard(ctx, interview, second.id, { ...(second.payload.value as object), personas: ["returning", "migrant", "no_cv"] })).toEqual({ ok: true });
    const saved = reload(db, userId, interview);
    expect(saved.form.setup).toMatchObject({ personas: ["returning", "migrant", "no_cv"], language: "en", country: "AU" });
    expect(saved.personas).toEqual(["returning", "migrant", "no_cv"]);
    expect(acceptFormCard(ctx, saved, second.id, { personas: ["wizard"] })).toEqual({ ok: true });
    // The interviews that follow are told who they are talking to.
    expect(ensureInterviewConversation(ctx, interview.id, "current", null).system).toContain("New to this market");
  });

  it("a card with something that isn't one of the descriptions is refused, and nothing ticked is fine too", async () => {
    const { db, userId, ctx, interview } = fresh();
    const conversation = ensureInterviewConversation(ctx, interview.id, "setup", null);
    await turn(ctx, conversation.id, "I just graduated and I don't have a CV.");
    const [card] = cards(db, conversation.id);
    expect(card.payload.value).toMatchObject({ personas: ["no_cv", "graduate"] });
    expect(acceptFormCard(ctx, interview, card.id, { ...(card.payload.value as object), personas: ["wizard"] })).toMatchObject({ ok: false, error: "invalid" });
    expect(acceptFormCard(ctx, interview, card.id, { ...(card.payload.value as object), personas: [] })).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.setup.personas).toEqual([]);
    // None is allowed: Continue moves on to the target job.
    expect(continueDataStage(db, reload(db, userId, interview), "setup")).toEqual({ ok: true });
    expect(reload(db, userId, interview)).toMatchObject({ stage: "target", stages: { setup: "done" } });
  });

  it("the demo interviewer reads the situation the same way every time, and takes \"none\" for an answer", async () => {
    expect(parseSetup("I'm changing careers from teaching, and I just graduated from a bootcamp.")).toEqual({ personas: ["career_changer", "graduate"] });
    expect(parseSetup("이민 와서 이 나라 취업 시장은 처음이에요. 이력서가 없어요")).toEqual({ personas: ["no_cv", "migrant"] });
    expect(parseSetup("I was a director of engineering and I'm returning to work after a break")).toEqual({ personas: ["returning", "senior_exec"] });
    expect(parseSetup("I want a steadier job")).toEqual({ personas: [] });
    const { db, ctx, interview } = fresh();
    const conversation = ensureInterviewConversation(ctx, interview.id, "setup", null);
    await turn(ctx, conversation.id, "None of these really apply");
    expect(cards(db, conversation.id)).toEqual([]);
    expect(assistantText(db, conversation.id)).toBe("Got it. That's what I need here. Press Continue when you're ready.");
    await turn(ctx, conversation.id, "Actually, I'm returning to work after a break");
    expect(cards(db, conversation.id)[0].payload.value).toMatchObject({ personas: ["returning"] });
    expect(JSON.stringify(requests)).not.toContain("<recorded_answers>");
  });
});

describe("data chat — Continue, On file and readiness", () => {
  it("Continue waits for what is required and for a waiting card", async () => {
    const { db, userId } = testDb();
    const ctx = { db, userId };
    const interview = createInterview(db, userId, { country: "AU" });
    // No roles at all.
    expect(continueDataStage(db, interview, "roles")).toEqual({ ok: false, error: "stage_incomplete", fields: ["roles.none"] });
    expect(continueDataStage(db, interview, "target")).toEqual({ ok: false, error: "stage_incomplete", fields: ["target.title"] });
    expect(reload(db, userId, interview).stages).toEqual({});

    const conversation = ensureInterviewConversation(ctx, interview.id, "target", null);
    override = propose("propose_target", { titles: ["Staff Engineer"], industries: [], cities: [], availability: "", seniority: [], workplace: [], employment_types: [] });
    await turn(ctx, conversation.id, "Staff Engineer");
    const [card] = cards(db, conversation.id);
    // The title is only on the card: still missing. Once one is saved by other means, the card itself blocks
    // (and, being a card for the whole section, its titles are what is saved when it is used).
    expect(continueDataStage(db, reload(db, userId, interview), "target")).toMatchObject({ error: "stage_incomplete" });
    expect(saveOnFile(db, interview, "target", { ...interview.form.target, titles: ["Principal Engineer"] })).toEqual({ ok: true });
    expect(continueDataStage(db, reload(db, userId, interview), "target")).toEqual({ ok: false, error: "card_pending" });
    expect(reload(db, userId, interview).stage).toBe("setup");
    resolveChatAction(ctx, card.id, "accept");
    expect(continueDataStage(db, reload(db, userId, interview), "target")).toEqual({ ok: true });
    expect(reload(db, userId, interview)).toMatchObject({ stage: "current", stages: { target: "done" }, form: { target: { titles: ["Staff Engineer"] } } });
  });

  it("the On file editor replaces the section, checks its rows, and old rows never block a new card", async () => {
    const { db, userId, ctx, interview: first } = started();
    // An old role saved with its dates the wrong way round (the earlier table allowed it).
    const interview = saveStageForm(db, first, "roles", [...first.form.roles, { id: "new-1", title: "Barista", company: "Bean There", start: "2016", end: "2015" }]);
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    override = propose("propose_roles", { roles: [role({ title: "Waiter", company: "Cafe Uno", start: "2014", end: "2015" })] });
    await turn(ctx, conversation.id, "Waiter at Cafe Uno 2014-2015");
    expect(acceptFormCard(ctx, interview, cards(db, conversation.id)[0].id)).toEqual({ ok: true });
    let now = reload(db, userId, interview);
    expect(now.form.roles.map((r) => r.id)).toEqual(["exp-1", "exp-2", "exp-3"]);

    const rows = cardValueOf(now.form, "roles").roles;
    expect(saveOnFile(db, now, "roles", { roles: [rows[0], { ...rows[2], title: " " }] })).toEqual({ ok: false, error: "invalid", fields: ["roles.1.title"] });
    expect(saveOnFile(db, now, "roles", { roles: rows })).toEqual({ ok: false, error: "invalid", fields: ["roles.1.order"] });
    // Removing the bad row sticks.
    expect(saveOnFile(db, now, "roles", { roles: [rows[0], rows[2]] })).toEqual({ ok: true });
    now = reload(db, userId, interview);
    expect(now.form.roles.map((r) => r.id)).toEqual(["exp-1", "exp-3"]);
    expect(saveOnFile(db, now, "languages", { languages: [{ language: "English", level: "" }] })).toEqual({ ok: false, error: "invalid", fields: ["languages.0.level"] });
  });

  it("a finished interview without an email can be generated again; one in progress cannot", () => {
    const { db, interview: first } = started();
    const interview = saveStageForm(db, first, "contact", { name: "Morgan Ellis" });
    const stages = { "role:exp-1": "done" as const };
    expect(interviewReadiness({ ...interview, stages, status: "in_progress" })).toEqual({ ok: false, missing: ["contact"] });
    expect(interviewReadiness({ ...interview, stages, status: "completed" })).toEqual({ ok: true });
  });
});

describe("data chat — conversations and what they are sent", () => {
  it("keeps a chat started with the previous interviewer, and starts data steps with the new one", () => {
    const { db, ctx, interview } = started();
    const current = ensureInterviewConversation(ctx, interview.id, "current", null);
    const role1 = ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1");
    db.update(conversations).set({ toolsetVersion: 2 }).run();
    expect(ensureInterviewConversation(ctx, interview.id, "current", null).id).toBe(current.id);
    expect(ensureInterviewConversation(ctx, interview.id, "role_deep", "exp-1").id).toBe(role1.id);
    db.update(conversations).set({ toolsetVersion: 1 }).run();
    expect(ensureInterviewConversation(ctx, interview.id, "current", null).id).not.toBe(current.id);

    const roles = ensureInterviewConversation(ctx, interview.id, "roles", null);
    expect(roles.toolsetVersion).toBe(INTERVIEW_TOOLSET_VERSION);
    expect(INTERVIEW_TOOLSET_VERSION).toBe(3);
    db.update(conversations).set({ toolsetVersion: 2 }).where(eq(conversations.id, roles.id)).run();
    expect(ensureInterviewConversation(ctx, interview.id, "roles", null).id).not.toBe(roles.id);
  });

  it("gives each step only its own tools; the job on file means no intake", () => {
    const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);
    expect(names(interviewTools("roles"))).toEqual(["propose_roles", "suggest_options"]);
    expect(names(interviewTools("target"))).toEqual(["propose_target", "suggest_options"]);
    expect(names(interviewTools("current"))).not.toContain("propose_current");
    expect(names(interviewTools("current", { intake: true }))).toContain("propose_current");
    expect(names(interviewTools("role_deep", { intake: true }))).toEqual(names(interviewTools("current")));
    const { ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "current", null);
    expect(names(conversation.tools as Array<{ name: string }>)).toEqual(names(interviewTools("current")));
    expect(conversation.system).not.toContain("propose_current");
    expect(JSON.parse(conversation.stateDigest!)).not.toHaveProperty("cards");
  });

  it("never sends the candidate's contact details to the interviewer", async () => {
    const { ctx, interview } = started();
    for (const stage of ["target", "roles", "education", "languages"] as const) {
      const conversation = ensureInterviewConversation(ctx, interview.id, stage, null);
      await turn(ctx, conversation.id, DATA_ANSWERS[stage === "roles" ? "role" : stage]);
    }
    expect(requests.length).toBeGreaterThanOrEqual(8);
    const sent = JSON.stringify(requests);
    for (const secret of ["Morgan Ellis", "morgan@example.com", "0400 111 222"]) expect(sent).not.toContain(secret);
    expect(sent).toContain("<interview_form>");
    expect(sent).not.toContain("<recorded_answers>");
  });

  it("a chat whose stored state predates cards is not told about them", async () => {
    const { db, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "current", null);
    const digest = JSON.parse(conversation.stateDigest!) as Record<string, unknown>;
    expect(Object.keys(digest).sort()).toEqual(["answers", "covered", "day", "form", "status"]);
    await turn(ctx, conversation.id, ANSWERS.week);
    await turn(ctx, conversation.id, ANSWERS.scope);
    const updates = JSON.stringify(requests).match(/<context_update>[^<]*/g) ?? [];
    expect(updates.join(" ")).not.toMatch(/required|card/i);
    expect(Object.keys(JSON.parse(db.select().from(conversations).where(eq(conversations.id, conversation.id)).get()!.stateDigest!) as object).sort()).toEqual(["answers", "covered", "day", "form", "status"]);
  });
});

describe("demo interviewer — reading what was typed", () => {
  it("splits lists and reads the sample answers", () => {
    expect(splitList("Sydney, Melbourne or remote")).toEqual(["Sydney", "Melbourne", "remote"]);
    expect(parseTarget(DATA_ANSWERS.target, 0).titles).toEqual(["Senior Frontend Engineer"]);
    expect(parseTarget("Now I'm looking for Staff Engineer and Principal Engineer", 0).titles).toEqual(["Staff Engineer", "Principal Engineer"]);
    expect(parseTarget(DATA_ANSWERS.cities, 1)).toMatchObject({ titles: [], cities: ["Sydney", "Melbourne"], workplace: ["remote"] });
    expect(parseCurrent(DATA_ANSWERS.current)).toEqual({ status: "employed", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-03" });
    expect(parseCurrent("I'm between jobs. My last job was Frontend Engineer at Koala")).toEqual({ status: "between_roles", title: "Frontend Engineer", company: "Koala", start: "" });
    expect(parseCurrent("I'm studying")).toMatchObject({ status: "studying", title: "" });
    expect(parseCurrent(DATA_ANSWERS.koreanRole)).toEqual({ status: "employed", title: "데이터 분석가", company: "카카오", start: "2021-03" });
    expect(parseRoles(DATA_ANSWERS.role)).toEqual([role({ title: "Frontend Engineer", company: "Koala Commerce", start: "2018-01", end: "2021-02" })]);
    expect(parseRoles(DATA_ANSWERS.earlierRole)).toEqual([role({ title: "Junior Developer", company: "Wattle Web", start: "2016", end: "2017" })]);
    expect(parseRoles(DATA_ANSWERS.koreanRole)).toEqual([role({ title: "데이터 분석가", company: "카카오", start: "2021-03", current: true })]);
    expect(parseRoles("Barista at Bean There (2015-2016); Waiter at Cafe Uno, 2014 to now").map((r) => [r.title, r.company, r.start, r.end, r.current])).toEqual([
      ["Barista", "Bean There", "2015", "2016", false],
      ["Waiter", "Cafe Uno", "2014", "", true],
    ]);
    expect(parseEducation(DATA_ANSWERS.education)).toEqual({ education: [{ institution: "Example University", degree: "BSc", field: "", start: "", end: "" }], certifications: [] });
    expect(parseEducation("Bachelor's degree in Physics at Example University, 2012 to 2015; cert: AWS Solutions Architect, 2020")).toEqual({
      education: [{ institution: "Example University", degree: "Bachelor's degree", field: "Physics", start: "2012", end: "2015" }],
      certifications: [{ name: "AWS Solutions Architect", issuer: "", year: "2020" }],
    });
    expect(parseEducation(DATA_ANSWERS.koreanEducation).education).toEqual([{ institution: "서울대학교", degree: "컴퓨터공학과 학사", field: "", start: "", end: "2015" }]);
    expect(parseLanguages(DATA_ANSWERS.languages)).toEqual([{ language: "English", level: "native" }]);
    expect(parseLanguages("English, native")).toEqual([{ language: "English", level: "native" }]);
    expect(parseLanguages("한국어 원어민, 영어 유창")).toEqual([{ language: "한국어", level: "native" }, { language: "영어", level: "fluent" }]);
    expect(parseLanguages("Korean")).toEqual([{ language: "Korean", level: "professional" }]);
  });

  it("runs the roles step: a card per reply, one question a turn, skip and a short reply handled", async () => {
    const { db, userId, ctx, interview } = started();
    const conversation = ensureInterviewConversation(ctx, interview.id, "roles", null);
    await turn(ctx, conversation.id, "Ok");
    expect(cards(db, conversation.id)).toEqual([]);
    expect(assistantText(db, conversation.id)).toMatch(/^Could you say a bit more\? I have Senior Frontend Engineer at Harbour Payments since 2021-03\./);

    await turn(ctx, conversation.id, DATA_ANSWERS.role);
    const [first] = cards(db, conversation.id);
    expect((first.payload.value as FormCardValue<"roles">).roles[0]).toMatchObject({ title: "Frontend Engineer", company: "Koala Commerce", start: "2018-01", end: "2021-02", current: false });
    expect(assistantText(db, conversation.id)).toMatch(/You mentioned "Frontend Engineer at Koala Commerce, 2018-01 to 2021-02": it's on a card below for you to check\. Any job before that\?/);
    expect(acceptFormCard(ctx, reload(db, userId, interview), first.id)).toEqual({ ok: true });

    await turn(ctx, conversation.id, DATA_ANSWERS.earlierRole);
    const second = cards(db, conversation.id)[1];
    expect((second.payload.value as FormCardValue<"roles">).roles.map((r) => r.title)).toEqual(["Junior Developer"]);
    expect(acceptFormCard(ctx, reload(db, userId, interview), second.id)).toEqual({ ok: true });
    expect(reload(db, userId, interview).form.roles.map((r) => [r.id, r.title])).toEqual([["exp-1", "Senior Frontend Engineer"], ["exp-2", "Frontend Engineer"], ["exp-3", "Junior Developer"]]);

    await turn(ctx, conversation.id, "Skip this question");
    expect(cards(db, conversation.id).length).toBe(2);
    expect(assistantText(db, conversation.id)).toMatch(/Sure, let's move on\. That's what I need here\. Check the card, then press Continue\.$/);
    // Every turn: exactly one question (or closing line), and at most one set of examples.
    expect(turnShape(db, conversation.id)).toEqual([
      { texts: 1, examples: 1 },
      { texts: 1, examples: 0 },
      { texts: 1, examples: 0 },
      { texts: 1, examples: 0 },
    ]);
    expect(continueDataStage(db, reload(db, userId, interview), "roles")).toEqual({ ok: true });
  });

  it("moves on without a card when the reply has nothing to save, and makes one from a short or Korean reply", async () => {
    const { db, ctx, interview } = started();
    const target = ensureInterviewConversation(ctx, interview.id, "target", null);
    await turn(ctx, target.id, "Yes, that's still it");
    expect(cards(db, target.id)).toEqual([]);
    expect(assistantText(db, target.id)).toBe("Got it. Where do you want to work? Cities, or remote.");
    await turn(ctx, target.id, DATA_ANSWERS.cities);
    expect(cards(db, target.id)[0].payload).toMatchObject({ value: { titles: ["Senior Frontend Engineer"], cities: ["Sydney", "Melbourne"], workplace: ["remote"] }, inferred: ["workplace"] });

    const roles = ensureInterviewConversation(ctx, interview.id, "roles", null);
    await turn(ctx, roles.id, "That's my only job so far");
    expect(cards(db, roles.id)).toEqual([]);
    expect(assistantText(db, roles.id)).toBe("Got it. That's what I need here. Press Continue when you're ready.");
    await turn(ctx, roles.id, DATA_ANSWERS.koreanRole);
    expect((cards(db, roles.id)[0].payload.value as FormCardValue<"roles">).roles[0]).toMatchObject({ title: "데이터 분석가", company: "카카오", start: "2021-03", current: true });

    const languages = ensureInterviewConversation(ctx, interview.id, "languages", null);
    await turn(ctx, languages.id, DATA_ANSWERS.languages);
    expect(cards(db, languages.id)[0].payload).toMatchObject({ value: { languages: [{ language: "English", level: "native" }] }, unresolved: [] });

    const education = ensureInterviewConversation(ctx, interview.id, "education", null);
    await turn(ctx, education.id, DATA_ANSWERS.koreanEducation);
    expect((cards(db, education.id)[0].payload.value as FormCardValue<"education">).education[0]).toMatchObject({ institution: "서울대학교", degree: "컴퓨터공학과 학사", end: "2015" });
  });
});

describe("demo interviewer — the intake of the current-situation chat", () => {
  it("asks what they do, puts it on a card without recording it, then asks about that job", async () => {
    const { db, userId, ctx, interview } = fresh();
    const conversation = ensureInterviewConversation(ctx, interview.id, "current", null);
    expect((conversation.tools as Array<{ name: string }>).map((t) => t.name)).toContain("propose_current");
    expect(conversation.system).toContain("First find out what they do now");
    const intake = interviewOpening(interview, "current", null);
    expect(intake.text).toMatch(/^What are you doing right now/);

    // "That's all" can't finish the part with no job on file.
    await turn(ctx, conversation.id, "That's all");
    expect(toolResults().find((r) => r.is_error)?.content).toMatch(/^Not finished: their job title is not on file yet/);
    expect(reload(db, userId, interview).stages.current).toBeUndefined();
    expect(assistantText(db, conversation.id)).toContain(intake.text);

    await turn(ctx, conversation.id, DATA_ANSWERS.current);
    expect(listAnswers(db, interview.id, { includePrivate: true })).toEqual([]);
    const [card] = cards(db, conversation.id);
    expect(card.payload).toMatchObject({ stage: "current", value: { status: "employed", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-03" } });
    expect(assistantText(db, conversation.id)).toContain("While you check that card: You're Senior Frontend Engineer at Harbour Payments right now. What does a normal week look like?");
    expect(reload(db, userId, interview).form.current.title).toBe("");
    // A waiting card blocks Continue, and "That's all".
    expect(continueBlockers(db, reload(db, userId, interview), "current")).toEqual({ ok: false, error: "stage_incomplete", fields: ["current.title"] });

    resolveChatAction(ctx, card.id, "accept");
    const saved = reload(db, userId, interview);
    expect(saved.form.roles.map((r) => [r.id, r.title, r.company, r.start])).toEqual([["exp-1", "Senior Frontend Engineer", "Harbour Payments", "2021-03"]]);
    expect(continueBlockers(db, saved, "current")).toEqual({ ok: true });
    // The first bubble stays the question that was asked, though a new chat would now open differently.
    expect(conversationOpening(db, conversation.id)).toEqual(intake);
    expect(interviewOpening(saved, "current", null).text).toMatch(/^You're Senior Frontend Engineer at Harbour Payments right now/);

    // The story answers that follow are recorded and filed under the new current role.
    await turn(ctx, conversation.id, ANSWERS.week);
    const answers = listAnswers(db, interview.id, { includePrivate: true });
    expect(answers.map((a) => [a.topic, a.quote])).toEqual([["context", ANSWERS.week]]);
    expect(answerRole(reload(db, userId, interview).form, answers[0])).toBe("exp-1");
    expect(assistantText(db, conversation.id)).toMatch(/Who do you work with and report to/);
    expect(JSON.stringify(requests)).toContain("The candidate saved the card. On file now:");
    // (The first turn, a refused "That's all", reads back and then asks again.)
    expect(turnShape(db, conversation.id).slice(1).every((t) => t.texts <= 1 && t.examples <= 1)).toBe(true);
  });

  it("a status alone makes a card, and accepting it lets them continue", async () => {
    const { db, userId, ctx, interview } = fresh();
    const conversation = ensureInterviewConversation(ctx, interview.id, "current", null);
    await turn(ctx, conversation.id, "I'm studying");
    const [card] = cards(db, conversation.id);
    expect(card.payload).toMatchObject({ value: { status: "studying", title: "" }, inferred: ["status"] });
    resolveChatAction(ctx, card.id, "accept");
    expect(reload(db, userId, interview).form.current.status).toBe("studying");
    expect(continueBlockers(db, reload(db, userId, interview), "current")).toEqual({ ok: true });
    expect(db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversation.id)).all().length).toBeGreaterThan(2);
  });
});
