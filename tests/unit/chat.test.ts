import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { chatActions } from "@/server/db/schema";
import { saveProfileVersion, savePreferences, getCurrentProfile } from "@/server/repo/profile";
import { createJob, getJob } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { createJobConversation, describeStateChange, listChatActions, listChatMessages, runJobChatTurn, toApiMessages, type ChatEvent } from "@/server/ai/chat/harness";
import { resolveChatAction } from "@/server/ai/chat/actions";
import { transcript } from "@/server/ai/chat/render";
import { getFakeGenerator, registerFakeGenerator, type FakeGenerator, type FakeRequest } from "@/server/ai/fake/transport";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import "@/server/ai/fake/generators/chat";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-chat-"));
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

// Capture what the chat sends, while still answering with the demo generator (or a test override).
const requests: FakeRequest["body"][] = [];
let override: FakeGenerator | null = null;
const demoChat = getFakeGenerator("chat")!;
registerFakeGenerator("chat", (req) => {
  requests.push(JSON.parse(JSON.stringify(req.body)));
  return (override ?? demoChat)(req);
});

afterEach(() => {
  override = null;
  requests.length = 0;
});

async function setup() {
  const { db, userId } = testDb();
  const ctx = { db, userId };
  saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
  savePreferences(db, userId, defaultPreferences());
  const job = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING, intake: { noisy: false } }));
  const conversation = createJobConversation(ctx, job);
  return { db, userId, ctx, job, conversation };
}

async function turn(ctx: Parameters<typeof runJobChatTurn>[0], conversationId: number, text: string) {
  const events: ChatEvent[] = [];
  await runJobChatTurn(ctx, conversationId, text, (e) => events.push(e));
  return events;
}

describe("job chat", () => {
  it("has the demo generator available", () => {
    expect(demoChat).toBeTypeOf("function");
  });

  it("answers from the fit analysis and stores every message verbatim", async () => {
    const { ctx, conversation } = await setup();
    const events = await turn(ctx, conversation.id, "Am I a good fit?");
    expect(events[0]).toEqual({ type: "start", conversationId: conversation.id });
    expect(events.at(-1)).toEqual({ type: "done" });
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toContain("Senior Frontend Engineer");
    expect(events.some((e) => e.type === "progress")).toBe(true);

    const rows = listChatMessages(ctx, conversation.id);
    expect(rows.map((r) => r.kind)).toEqual(["context", "user", "assistant"]);
    const assistant = rows[2].content as Array<{ type: string; signature?: string }>;
    expect(assistant[0]).toMatchObject({ type: "thinking", signature: "fake-signature" });
  });

  it("each request extends the previous one byte for byte", async () => {
    const { ctx, conversation } = await setup();
    await turn(ctx, conversation.id, "Explain this posting");
    await turn(ctx, conversation.id, "What should I lead with?");
    expect(requests).toHaveLength(2);
    const [a, b] = requests;
    expect(b.system).toEqual(a.system);
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));
    const prefix = JSON.stringify(a.messages).slice(0, -1);
    expect(JSON.stringify(b.messages).startsWith(prefix)).toBe(true);
    expect(b.messages).toHaveLength(3);
  });

  it("runs client tools in a loop: saving a note", async () => {
    const { db, userId, ctx, job, conversation } = await setup();
    const events = await turn(ctx, conversation.id, "Please remember: call the recruiter on Monday");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "save_job_note" }));
    expect(getJob(db, userId, job.id)!.notes).toContain("call the recruiter on Monday");
    expect(listChatMessages(ctx, conversation.id).map((r) => r.kind)).toEqual(["context", "user", "assistant", "tool_results", "assistant"]);
    // The tool result went back to Claude before the final answer.
    const last = requests.at(-1)!.messages.at(-1) as { role: string; content: Array<{ type: string }> };
    expect(last.role).toBe("user");
    expect(last.content[0].type).toBe("tool_result");
  });

  it("profile facts need the user's click; the outcome reaches the model next turn", async () => {
    const { ctx, db, userId, conversation } = await setup();
    const events = await turn(ctx, conversation.id, "I have run accessibility audits against WCAG 2.2 for two years");
    const card = events.find((e) => e.type === "card") as { actionId: number };
    expect(card).toBeDefined();
    expect(getCurrentProfile(db, userId)!.data.facts).toHaveLength(0);

    resolveChatAction(ctx, card.actionId, "accept");
    const facts = getCurrentProfile(db, userId)!.data.facts;
    expect(facts).toEqual([expect.objectContaining({ source: "chat", text: expect.stringContaining("WCAG 2.2") })]);
    expect(listChatActions(ctx, conversation.id)[0].status).toBe("accepted");

    await turn(ctx, conversation.id, "Thanks. What next?");
    const lastUser = requests.at(-1)!.messages.at(-1) as { content: Array<{ type: string; text?: string }> };
    const update = lastUser.content.find((b) => b.text?.startsWith("<context_update>"));
    expect(update?.text).toContain("accepted the profile fact");
  });

  it("proceeding sets the job to Applying only after confirmation", async () => {
    const { ctx, db, userId, job, conversation } = await setup();
    const events = await turn(ctx, conversation.id, "Let's apply for this one");
    const card = events.find((e) => e.type === "card") as { actionId: number };
    expect(getJob(db, userId, job.id)!.status).toBe("new");
    resolveChatAction(ctx, card.actionId, "accept");
    expect(getJob(db, userId, job.id)!.status).toBe("applying");
    resolveChatAction(ctx, card.actionId, "dismiss");
    expect(db.select().from(chatActions).all()[0].status).toBe("accepted");
  });

  it("keeps nothing from a refused turn", async () => {
    const { ctx, conversation } = await setup();
    override = () => ({ content: [], stop_reason: "refusal" });
    const events = await turn(ctx, conversation.id, "Something the model declines");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "refusal" });
    expect(listChatMessages(ctx, conversation.id).map((r) => r.kind)).toEqual(["context"]);
  });

  it("answers dangling tool calls on the next turn", async () => {
    const { ctx, conversation } = await setup();
    override = () => ({ content: [{ type: "tool_use", id: "toolu_cut", name: "save_job_note", input: { note: "x" } }], stop_reason: "max_tokens" });
    const events = await turn(ctx, conversation.id, "Write a very long answer");
    expect(events).toContainEqual({ type: "error", code: "max_tokens" });
    override = null;
    await turn(ctx, conversation.id, "Shorter please");
    const lastUser = requests.at(-1)!.messages.at(-1) as { content: Array<{ type: string; tool_use_id?: string; is_error?: boolean }> };
    expect(lastUser.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_cut", is_error: true });
  });

  it("replies in Korean to a Korean question", async () => {
    const { ctx, conversation } = await setup();
    const events = await turn(ctx, conversation.id, "이 공고 나한테 맞을까?");
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toMatch(/[가-힣]/);
  });

  it("renders a transcript for the UI", async () => {
    const { ctx, conversation } = await setup();
    await turn(ctx, conversation.id, "Please note: ask about the team size");
    const items = transcript(listChatMessages(ctx, conversation.id), listChatActions(ctx, conversation.id));
    expect(items.map((i) => i.role)).toEqual(["user", "assistant"]);
    expect(items[1].activities).toEqual([{ name: "save_job_note", detail: "Please note: ask about the team size" }]);
    expect(items[1].text).toContain("I'll note that.");
  });
});

describe("chat helpers", () => {
  it("merges consecutive same-role rows into one message", () => {
    const row = (role: string, text: string) => ({ role, content: [{ type: "text", text }] }) as never;
    const merged = toApiMessages([row("user", "a"), row("user", "b"), row("assistant", "c"), row("assistant", "d"), row("user", "e")]);
    expect(merged.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect((merged[0].content as unknown[]).length).toBe(2);
  });

  it("describes what changed since the model last looked", () => {
    const before = { status: "new", tier: "good", eligibility: "verify", gates: [], statuses: { r1: "unknown" }, answers: {}, profileStale: false, researchReady: false, actions: {} };
    const after = { ...before, status: "applied", tier: "strong", eligibility: "eligible", statuses: { r1: "met" }, answers: { r1: "yes" } };
    const text = describeStateChange(before, after, [])!;
    expect(text).toContain('Job status is now "applied"');
    expect(text).toContain("Interview Chance is now strong (eligible)");
    expect(text).toContain("r1: unknown → met");
    expect(describeStateChange(before, before, [])).toBeNull();
  });
});
