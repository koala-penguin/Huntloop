import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createJob, setJobStatus } from "@/server/repo/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { listChatMessages, runChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { createCoachConversation, getCoachConversation } from "@/server/ai/chat/coach";
import { getFakeGenerator, registerFakeGenerator, type FakeGenerator, type FakeRequest } from "@/server/ai/fake/transport";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import "@/server/ai/fake/generators/coach";
import { searches, tasks } from "@/server/db/schema";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";

const original = process.env.HUNTLOOP_DATA_DIR;
beforeAll(() => {
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-coach-"));
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

const requests: FakeRequest["body"][] = [];
const demoCoach = getFakeGenerator("coach")!;
let override: FakeGenerator | null = null;
registerFakeGenerator("coach", (req) => {
  requests.push(JSON.parse(JSON.stringify(req.body)));
  return (override ?? demoCoach)(req);
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
  const a = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING }));
  const b = await processJob(ctx, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING.replace("Bright Harbour Health", "Wattle Clinics") }));
  return { db, userId, ctx, a, b };
}

async function turn(ctx: Parameters<typeof runChatTurn>[0], conversationId: number, text: string) {
  const events: ChatEvent[] = [];
  await runChatTurn(ctx, conversationId, text, (e) => events.push(e));
  return events;
}

const toolResults = (body: FakeRequest["body"]) =>
  (body.messages.at(-1)!.content as Array<{ type: string; content?: string; is_error?: boolean }>).filter((b) => b.type === "tool_result");

describe("coach", () => {
  it("starts with the profile, preferences and pipeline, and its own tools", async () => {
    const { ctx, a } = await setup();
    const conversation = createCoachConversation(ctx);
    expect(getCoachConversation(ctx)?.id).toBe(conversation.id);
    expect(conversation).toMatchObject({ kind: "coach", jobId: null });
    const names = (conversation.tools as Array<{ name?: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["compare_jobs", "get_job", "import_job_url", "list_jobs", "search_jobs", "set_job_status", "web_search"]));
    expect(names).not.toContain("save_job_note");
    const context = (listChatMessages(ctx, conversation.id)[0].content as Array<{ text: string }>).map((b) => b.text).join("\n");
    expect(context).toContain("<pipeline>");
    expect(context).toContain(`"id": ${a.id}`);
  });

  it("lists and compares jobs with its tools, and each request extends the previous one", async () => {
    const { ctx, a, b } = await setup();
    const conversation = createCoachConversation(ctx);
    const events = await turn(ctx, conversation.id, "What should I focus on this week?");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "list_jobs" }));
    expect(toolResults(requests.at(-1)!)[0].content).toContain(`"id":${a.id}`);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain(`#${a.id}`);

    await turn(ctx, conversation.id, "Compare my top two jobs");
    const compared = JSON.parse(toolResults(requests.at(-1)!)[0].content!) as Array<{ id: number; musts: { total: number } }>;
    expect(compared.map((j) => j.id).sort()).toEqual([a.id, b.id].sort());
    expect(compared[0].musts.total).toBeGreaterThan(0);

    const first = JSON.stringify(requests[0].messages).slice(0, -1);
    expect(JSON.stringify(requests.at(-1)!.messages).startsWith(first)).toBe(true);
  });

  it("starts a search only when asked, and reports it when it finishes", async () => {
    const { db, ctx } = await setup();
    const conversation = createCoachConversation(ctx);
    await turn(ctx, conversation.id, "Find me senior frontend jobs in Sydney");
    const search = db.select().from(searches).get()!;
    expect(db.select().from(tasks).all().some((t) => t.kind === "search" && (t.payload as { searchId: number }).searchId === search.id)).toBe(true);

    db.update(searches).set({ lastRunAt: new Date(), lastSummary: { sources: {}, unique: 7, known: 0, filtered: {}, screened: 5, deep: 0, stoppedBy: null } }).run();
    await turn(ctx, conversation.id, "Anything new?");
    const update = (requests.at(-1)!.messages.at(-1)!.content as Array<{ text?: string }>).find((b) => b.text?.startsWith("<context_update>"));
    expect(update?.text).toContain(`Search #${search.id} ("Find me senior frontend jobs in Sydney") finished: 7 unique jobs, 5 assessed.`);
  });

  it("hears about status changes and new jobs on the next turn", async () => {
    const { db, userId, ctx, a } = await setup();
    const conversation = createCoachConversation(ctx);
    setJobStatus(db, userId, a.id, "applied");
    createJob(db, userId, { source: "url", sourceUrl: "https://example.com/job/1", title: "Data Engineer", companyName: "Numbat" });
    await turn(ctx, conversation.id, "Hi");
    const update = (requests.at(-1)!.messages.at(-1)!.content as Array<{ text?: string }>).find((b) => b.text?.startsWith("<context_update>"))!.text!;
    expect(update).toContain(`(#${a.id}): status new → applied.`);
    expect(update).toContain("New job: Data Engineer at Numbat");
  });

  it("adds a job by link and refuses unknown job ids", async () => {
    const { ctx } = await setup();
    const conversation = createCoachConversation(ctx);
    await turn(ctx, conversation.id, "Please add https://boards.example.com/jobs/42");
    expect(toolResults(requests.at(-1)!)[0].content).toMatch(/^Added as job #\d+/);

    override = (req) =>
      toolResults(req.body).length || req.body.messages.at(-1)!.role !== "user" || typeof req.body.messages.at(-1)!.content === "string"
        ? demoCoach(req)
        : { content: [{ type: "tool_use", id: "toolu_get_missing", name: "get_job", input: { job_id: 999 } }], stop_reason: "tool_use" };
    await turn(ctx, conversation.id, "Tell me about job 999");
    expect(toolResults(requests.at(-1)!)[0]).toMatchObject({ is_error: true, content: "There is no job #999." });
  });
});
