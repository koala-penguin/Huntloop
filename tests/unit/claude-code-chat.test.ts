import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setCliSpawner } from "@/server/ai/claude-code/cli";
import { setClaudeCodeStatus } from "@/server/ai/claude-code/status";
import { resetSubscriptionUsage } from "@/server/ai/claude-code/limits";
import { createJobConversation, listChatActions, listChatMessages, runChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { transcript } from "@/server/ai/chat/render";
import { DEMO_SCREENSHOT_POSTING } from "@/server/ai/fake/generators/jobs";
import { processJob } from "@/server/jobs/pipeline";
import { createJob } from "@/server/repo/jobs";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { conversations, usageLog } from "@/server/db/schema";
import { defaultAiSettings } from "@/shared/ai-settings";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";
import { cliAssistant, cliResult, cliToolResult, fakeCli, mcp, mcpServer, type McpServerEntry } from "../helpers/fake-cli";

const env = { ai: process.env.HUNTLOOP_AI, data: process.env.HUNTLOOP_DATA_DIR };
beforeAll(() => {
  // No API key: the API connection is the demo simulator; the subscription is the (fake) Claude Code CLI.
  process.env.HUNTLOOP_AI = "";
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-cc-chat-"));
  setClaudeCodeStatus({ found: true, version: "2.1.296", loggedIn: true, authMethod: "claude.ai", checkedAt: new Date(), error: null });
});
afterAll(() => {
  process.env.HUNTLOOP_AI = env.ai;
  process.env.HUNTLOOP_DATA_DIR = env.data;
  setClaudeCodeStatus(null);
});
afterEach(() => setCliSpawner(null));

async function setup() {
  const { db, userId } = testDb();
  saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
  savePreferences(db, userId, defaultPreferences());
  const job = await processJob({ db, userId, settings: defaultAiSettings(undefined, "api") }, createJob(db, userId, { source: "paste", rawText: DEMO_SCREENSHOT_POSTING }));
  const ctx = { db, userId, settings: defaultAiSettings(undefined, "subscription") };
  return { db, userId, ctx, job, conversation: createJobConversation(ctx, job) };
}

async function turn(ctx: Parameters<typeof runChatTurn>[0], conversationId: number, text: string) {
  const events: ChatEvent[] = [];
  await runChatTurn(ctx, conversationId, text, (e) => events.push(e));
  return events;
}

describe("job chat on the Claude subscription", () => {
  it("runs the turn in Claude Code, serves Huntloop's tools over MCP, and continues the session next turn", async () => {
    const { db, ctx, conversation } = await setup();
    expect(conversation.provider).toBe("subscription");
    let server: McpServerEntry | null = null;
    let listed: string[] = [];
    const { spawner, calls } = fakeCli(async (call) => {
      if (calls.length > 1) return [cliAssistant([{ type: "text", text: "Sure." }]), cliResult({ session_id: "sess-B" })];
      server = mcpServer(call);
      listed = ((await mcp(server, "tools/list", {})).body!.result.tools as Array<{ name: string }>).map((t) => t.name);
      call.write(cliAssistant([{ type: "tool_use", id: "toolu_fact", name: "mcp__huntloop__propose_profile_fact", input: { fact: "I ran Kubernetes in production.", why: "Kubernetes" } }]));
      const called = await mcp(server, "tools/call", { name: "propose_profile_fact", arguments: { fact: "I ran Kubernetes in production.", why: "Kubernetes" } });
      expect(called.body!.result).toMatchObject({ isError: false });
      return [
        cliToolResult("toolu_fact", String((called.body!.result.content as Array<{ text: string }>)[0].text)),
        cliAssistant([{ type: "tool_use", id: "toolu_ws", name: "WebSearch", input: { query: "Bright Harbour Health news" } }]),
        cliToolResult("toolu_ws", "Web search results", { query: "q", results: [] }),
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I've suggested adding that " } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "to your profile." } } },
        cliAssistant([{ type: "text", text: "I've suggested adding that to your profile." }]),
        cliResult({ session_id: "sess-A" }),
      ];
    });
    setCliSpawner(spawner);

    const events = await turn(ctx, conversation.id, "I have run Kubernetes in production, can you note that?");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("I've suggested adding that to your profile.");
    expect(events).toContainEqual({ type: "tool", name: "web_search", detail: "Bright Harbour Health news" });
    expect(events.some((e) => e.type === "card")).toBe(true);

    // The CLI saw the chat's client tools (not the server web tools), the thread's context and the message.
    expect(listed).toEqual(expect.arrayContaining(["save_job_note", "set_job_status", "propose_profile_fact", "propose_proceed", "start_company_research"]));
    expect(listed).not.toContain("web_search");
    const first = calls[0];
    expect(first.arg("--session-id")).toBeTruthy();
    expect(first.arg("--tools")).toBe("WebSearch,WebFetch");
    expect(first.arg("--allowedTools")).toContain("mcp__huntloop");
    expect(first.input.message.content.some((b) => b.type === "document")).toBe(true);
    expect(JSON.stringify(first.input.message.content)).toContain("I have run Kubernetes in production");

    // The card is tied to the tool_use the CLI reported, and the transcript reads like an API thread.
    const actions = listChatActions(ctx, conversation.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ toolUseId: "toolu_fact", kind: "profile_fact", status: "pending" });
    const items = transcript(listChatMessages(ctx, conversation.id), actions);
    expect(items.at(-1)).toMatchObject({ role: "assistant", text: "I've suggested adding that to your profile." });
    expect(items.at(-1)!.activities).toEqual([{ name: "web_search", detail: "Bright Harbour Health news" }]);
    expect(items.at(-1)!.actions).toHaveLength(1);
    expect(db.select().from(conversations).where(eq(conversations.id, conversation.id)).get()!.providerSession).toBe("sess-A");
    expect(db.select().from(usageLog).all().filter((r) => r.via === "claude_code")).toHaveLength(1);

    // The run's token stopped working when the turn ended; other tokens never did.
    expect((await mcp(server!, "tools/list", {})).status).toBe(401);
    expect((await mcp(server!, "tools/list", {}, `Bearer ${"f".repeat(64)}`)).status).toBe(401);
    expect(fs.existsSync(first.arg("--mcp-config")!)).toBe(false);

    // Next turn: the session is resumed as a fork, without the opening context.
    await turn(ctx, conversation.id, "Thanks");
    const second = calls[1];
    expect(second.args).toEqual(expect.arrayContaining(["--resume", "sess-A", "--fork-session"]));
    expect(second.input.message.content.some((b) => b.type === "document")).toBe(false);
    expect(db.select().from(conversations).where(eq(conversations.id, conversation.id)).get()!.providerSession).toBe("sess-B");
  });

  it("drops a failed turn and keeps the session it would have continued", async () => {
    const { db, ctx, conversation } = await setup();
    db.update(conversations).set({ providerSession: "sess-OK" }).where(eq(conversations.id, conversation.id)).run();
    const before = listChatMessages(ctx, conversation.id).length;
    setCliSpawner(fakeCli(() => [cliAssistant([{ type: "text", text: "partial" }]), cliResult({ is_error: true, result: "Claude AI usage limit reached|4102444800" })]).spawner);
    const events = await turn(ctx, conversation.id, "Hello?");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "subscription_limit" });
    expect(listChatMessages(ctx, conversation.id)).toHaveLength(before);
    expect(db.select().from(conversations).where(eq(conversations.id, conversation.id)).get()!.providerSession).toBe("sess-OK");
  });

  it("asks for a new conversation when the saved session can't be resumed", async () => {
    resetSubscriptionUsage(); // the earlier usage-limit test leaves a limit behind
    const { db, ctx, conversation } = await setup();
    db.update(conversations).set({ providerSession: "sess-old" }).where(eq(conversations.id, conversation.id)).run();
    const missing = "No conversation found with session ID: sess-old";
    const { spawner, calls } = fakeCli(() => [cliResult({ subtype: "error_during_execution", is_error: true, result: "", errors: [missing] })]);
    setCliSpawner(spawner);
    const events = await turn(ctx, conversation.id, "Still there?");
    expect(events.at(-1)).toMatchObject({ type: "error", code: "session_expired" });
    expect(calls).toHaveLength(1);
    expect(calls[0].arg("--resume")).toBe("sess-old");
    expect(db.select().from(conversations).where(eq(conversations.id, conversation.id)).get()!.providerSession).toBe("sess-old");

    // Other failures on a resumed thread stay what they were.
    setCliSpawner(fakeCli(() => [cliResult({ subtype: "error_during_execution", is_error: true, result: "", errors: ["something else broke"] })]).spawner);
    const other = await turn(ctx, conversation.id, "Still there?");
    expect(other.at(-1)).toMatchObject({ type: "error", code: "api" });
  });

  it("keeps an API thread on the API after the user switches to the subscription", async () => {
    const { db, userId, job } = await setup();
    const apiThread = createJobConversation({ db, userId, settings: defaultAiSettings(undefined, "api") }, job);
    const { spawner, calls } = fakeCli(() => [cliResult()]);
    setCliSpawner(spawner);
    // Demo simulator answers (no API key), not the CLI.
    const events = await turn({ db, userId, settings: defaultAiSettings(undefined, "subscription") }, apiThread.id, "What is this job about?");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(calls).toHaveLength(0);
  });
});
