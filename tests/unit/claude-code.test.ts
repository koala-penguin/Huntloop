import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiError, callStructured, modeFor } from "@/server/ai/client";
import { runSubmitLoop } from "@/server/ai/agent-loop";
import { webTools } from "@/server/ai/request";
import { buildCliArgs, runClaudeCode, setCliSpawner, type CliRunOptions } from "@/server/ai/claude-code/cli";
import { cliEnv, setClaudeCodeStatus } from "@/server/ai/claude-code/status";
import { resetSubscriptionUsage, subscriptionLimitedUntil, subscriptionNearLimit, subscriptionUsage } from "@/server/ai/claude-code/limits";
import { restrictedDomains } from "@/server/ingest/domain-policy";
import { spendSummary, usageReport } from "@/server/repo/usage";
import { usageLog } from "@/server/db/schema";
import { defaultAiSettings } from "@/shared/ai-settings";
import { testDb } from "../helpers/db";
import { cliAssistant, cliResult, cliToolResult, fakeCli } from "../helpers/fake-cli";

const env = { ai: process.env.HUNTLOOP_AI, data: process.env.HUNTLOOP_DATA_DIR };
beforeAll(() => {
  process.env.HUNTLOOP_AI = "claude-code";
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-cc-test-"));
});
afterAll(() => {
  process.env.HUNTLOOP_AI = env.ai;
  process.env.HUNTLOOP_DATA_DIR = env.data;
});
afterEach(() => {
  setCliSpawner(null);
  setClaudeCodeStatus(null);
  resetSubscriptionUsage();
});

function subscriptionCtx() {
  const { db, userId } = testDb();
  return { db, userId, settings: defaultAiSettings(undefined, "subscription") };
}

const schema = z.object({ title: z.string(), city: z.string().nullable() });

describe("Claude Code CLI (subscription connection)", () => {
  it("runs isolated: own working directory, no settings or MCP servers, no permission prompts", () => {
    const args = buildCliArgs({ model: "claude-opus-5-5", effort: "low", systemPrompt: "s", input: [], tools: [] }, { systemPrompt: "/tmp/s.txt", mcpConfig: null });
    expect(args.slice(0, 6)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json"]);
    for (const flag of ["--strict-mcp-config", "--no-session-persistence"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");

    const resumed = buildCliArgs({ model: "m", effort: "low", systemPrompt: "", input: [], tools: [], session: { mode: "resume", id: "abc" } }, { systemPrompt: "/s", mcpConfig: "/m.json" });
    expect(resumed).toEqual(expect.arrayContaining(["--resume", "abc", "--fork-session", "--mcp-config", "/m.json"]));
    expect(resumed).not.toContain("--no-session-persistence");
  });

  it("uses the user's own sign-in: Huntloop's API key and the parent session never reach the CLI", () => {
    const child = cliEnv({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_AUTH_TOKEN: "t", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x", HOME: "/home/u" } as unknown as NodeJS.ProcessEnv);
    expect(child).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  it("answers structured tasks through `claude -p --json-schema` and logs them as unbilled subscription use", async () => {
    const { spawner, calls } = fakeCli(() => [
      { type: "system", subtype: "init", session_id: "sess-1" },
      cliAssistant([{ type: "tool_use", id: "t1", name: "StructuredOutput", input: { title: "Data Analyst", city: "Perth" } }]),
      { type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1_900_000_000, unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1_900_000_000 }, seven_day: { utilization: 0.4, resetsAt: 1_900_500_000 } } } },
      cliResult({ structured_output: { title: "Data Analyst", city: "Perth" } }),
    ]);
    setCliSpawner(spawner);
    const ctx = subscriptionCtx();
    const result = await callStructured(ctx, "parseSearch", {
      schema,
      system: [{ type: "text", text: "Extract the job.", cache_control: { type: "ephemeral" } }] as never,
      messages: [{ role: "user", content: [{ type: "text", text: "Data analyst in Perth", cache_control: { type: "ephemeral" } }] as never }],
    });
    expect(result.data).toEqual({ title: "Data Analyst", city: "Perth" });

    const call = calls[0];
    expect(call.arg("--model")).toBe("claude-opus-5-5");
    expect(call.arg("--effort")).toBe("low");
    expect(JSON.parse(call.arg("--json-schema")!)).toMatchObject({ type: "object", required: ["title", "city"] });
    expect(call.input.message.content).toEqual([{ type: "text", text: "Data analyst in Perth" }]);
    expect(call.env.ANTHROPIC_API_KEY).toBeUndefined();

    const rows = ctx.db.select().from(usageLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task: "parseSearch", via: "claude_code", simulated: false, inputTokens: 100, outputTokens: 50 });
    expect(rows[0].costUsd).toBeGreaterThan(0);
    // Not billed: the spending caps don't count it, the usage page shows it apart.
    expect(spendSummary(ctx.db, ctx.userId).todayUsd).toBe(0);
    const report = usageReport(ctx.db, ctx.userId);
    expect(report.totalUsd).toBe(0);
    expect(report.subscriptionCalls).toBe(1);
    expect(report.subscriptionUsd).toBeGreaterThan(0);
    // The daily chart shows it as subscription use, apart from billed spend.
    const today = report.days[report.days.length - 1];
    expect(today).toMatchObject({ calls: 0, costUsd: 0, subscriptionCalls: 1 });
    expect(today.subscriptionUsd).toBe(report.subscriptionUsd);
    // The plan's usage windows, as the CLI reported them.
    expect(subscriptionUsage()).toMatchObject({ status: "allowed", fiveHour: { utilization: 0.25 }, sevenDay: { utilization: 0.4 } });
  });

  it("rejects structured output that doesn't match the schema", async () => {
    setCliSpawner(fakeCli(() => [cliResult({ structured_output: { title: 3 } })]).spawner);
    await expect(callStructured(subscriptionCtx(), "parseSearch", { schema, messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("explains a missing sign-in", async () => {
    setCliSpawner(fakeCli(() => [cliResult({ subtype: "success", is_error: true, result: "Not logged in · Please run /login" })]).spawner);
    await expect(callStructured(subscriptionCtx(), "parseSearch", { schema, messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "cli_login" });
  });

  it("reports a missing CLI", async () => {
    // The real spawner with HUNTLOOP_CLAUDE_PATH pointing nowhere (set in vitest.config).
    await expect(callStructured(subscriptionCtx(), "parseSearch", { schema, messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ code: "cli_missing" });
  });

  it("stops background work at the plan's usage limit until it resets", async () => {
    const resets = Math.floor(Date.now() / 1000) + 3600;
    const { spawner, calls } = fakeCli(() => [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: resets } },
      cliResult({ is_error: true, result: `Claude AI usage limit reached|${resets}` }),
    ]);
    setCliSpawner(spawner);
    const ctx = subscriptionCtx();
    const error = await callStructured(ctx, "screen", { schema, messages: [{ role: "user", content: "x" }] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toMatchObject({ code: "subscription_limit", detail: { resetsAt: new Date(resets * 1000).toISOString() } });
    expect(subscriptionLimitedUntil()?.getTime()).toBe(resets * 1000);
    expect(subscriptionNearLimit(80)).toBe(true);

    // Background work doesn't even start the CLI until the reset.
    await expect(callStructured(ctx, "screen", { schema, messages: [{ role: "user", content: "x" }] }, { enforceBudget: true })).rejects.toMatchObject({ code: "subscription_limit" });
    expect(calls).toHaveLength(1);
  });

  it("is only used when the CLI is signed in (otherwise demo mode)", () => {
    process.env.HUNTLOOP_AI = "";
    try {
      setClaudeCodeStatus({ found: true, version: "2.1.296", loggedIn: false, authMethod: null, checkedAt: new Date(), error: null });
      expect(modeFor("subscription")).toBe("fake");
      setClaudeCodeStatus({ found: true, version: "2.1.296", loggedIn: true, authMethod: "claude.ai", checkedAt: new Date(), error: null });
      expect(modeFor("subscription")).toBe("claude_code");
    } finally {
      process.env.HUNTLOOP_AI = "claude-code";
    }
  });

  it("researches with Claude Code's web tools and keeps only URLs it actually saw", async () => {
    const leadSchema = z.object({ leads: z.array(z.object({ url: z.string() })) });
    const { spawner, calls } = fakeCli(() => [
      cliAssistant([{ type: "tool_use", id: "s1", name: "WebSearch", input: { query: "frontend jobs sydney" } }]),
      cliToolResult("s1", "Web search results", { query: "frontend jobs sydney", results: [{ tool_use_id: "srv", content: [{ title: "Frontend Engineer", url: "https://boards.greenhouse.io/acme/jobs/1" }] }] }),
      cliAssistant([{ type: "tool_use", id: "f1", name: "WebFetch", input: { url: "https://acme.com/careers", prompt: "jobs?" } }]),
      cliToolResult("f1", "Acme careers page", { url: "https://acme.com/careers", code: 200, result: "…" }),
      cliAssistant([{ type: "tool_use", id: "f2", name: "WebFetch", input: { url: "https://acme.com/blocked", prompt: "?" } }]),
      cliToolResult("f2", "proxy refused the connection", "Error: proxy refused the connection", true),
      { type: "system", subtype: "task_summary", detail: "Searching for frontend roles in Sydney" },
      cliResult({ structured_output: { leads: [{ url: "https://boards.greenhouse.io/acme/jobs/1" }] } }),
    ]);
    setCliSpawner(spawner);
    const notes: string[] = [];
    const ctx = subscriptionCtx();
    const ctxDb = ctx.db;
    const result = await runSubmitLoop(ctx, "searchAgent", {
      system: "Find jobs, then call report_job_leads.",
      messages: [{ role: "user", content: "frontend, Sydney" }],
      tools: webTools("claude-opus-5-5", { blockedDomains: restrictedDomains() }),
      submit: { name: "report_job_leads", description: "Report", schema: leadSchema },
      onProgress: (n) => notes.push(n),
    });
    expect(result.data.leads).toHaveLength(1);
    expect(result.sources.map((s) => s.url)).toEqual(["https://boards.greenhouse.io/acme/jobs/1", "https://acme.com/careers"]);
    expect(notes).toEqual(["Searching for frontend roles in Sydney"]);
    // Claude Code's web searches count in the usage log (and its API-equivalent value).
    expect(ctxDb.select().from(usageLog).all()[0]).toMatchObject({ via: "claude_code", webSearches: 1 });

    const call = calls[0];
    expect(call.arg("--tools")).toBe("WebSearch,WebFetch");
    expect(call.arg("--disallowedTools")).toContain("WebFetch(domain:seek.com.au)");
    expect(fs.readdirSync(call.cwd)).toEqual([]);
  });

  it("lets a run hand its slot to others while it waits for the user, without losing count", async () => {
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      return { promise, resolve };
    };
    const gates: Array<ReturnType<typeof deferred>> = [];
    const { spawner, calls } = fakeCli(async () => {
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return [cliResult()];
    });
    setCliSpawner(spawner);
    const base: CliRunOptions = { model: "claude-opus-5-5", effort: "low", systemPrompt: "s", input: [{ type: "text", text: "x" }], tools: [] };
    const spawned = (n: number) => vi.waitFor(() => expect(calls).toHaveLength(n));
    const settle = () => new Promise((r) => setTimeout(r, 20));

    // Run 1 yields its slot (as the browser agent does while the user solves a CAPTCHA).
    const userDone = deferred();
    let yielded: Promise<unknown> | null = null;
    const run1 = runClaudeCode({ ...base, onSlot: (yieldSlot) => (yielded = yieldSlot(() => userDone.promise)) });
    await spawned(1);
    const run2 = runClaudeCode(base);
    const run3 = runClaudeCode(base);
    await spawned(3);
    const run4 = runClaudeCode(base);
    await settle();
    expect(calls).toHaveLength(3); // the cap still applies to runs that didn't yield

    userDone.resolve(); // run 1 now waits to get its slot back, behind run 4
    gates[1].resolve();
    await run2;
    await spawned(4);
    gates[2].resolve();
    gates[3].resolve();
    gates[0].resolve();
    await Promise.all([run1, run3, run4, yielded]);

    // Back to exactly zero: two fresh runs go in parallel, a third waits.
    const fresh = [runClaudeCode(base), runClaudeCode(base)];
    await spawned(6);
    const third = runClaudeCode(base);
    await settle();
    expect(calls).toHaveLength(6);
    gates[4].resolve();
    await spawned(7);
    gates[5].resolve();
    gates[6].resolve();
    await Promise.all([...fresh, third]);
  });

  it("gives back a yielded slot only once when the run is cancelled", async () => {
    const gates: Array<() => void> = [];
    const { spawner, calls } = fakeCli(async () => {
      await new Promise<void>((r) => gates.push(r));
      return [cliResult()];
    });
    setCliSpawner(spawner);
    const base: CliRunOptions = { model: "claude-opus-5-5", effort: "low", systemPrompt: "s", input: [{ type: "text", text: "x" }], tools: [] };
    const controller = new AbortController();
    let releaseUser!: () => void;
    const userDone = new Promise<void>((r) => (releaseUser = r));
    let yielded: Promise<unknown> | null = null;
    const run1 = runClaudeCode({ ...base, signal: controller.signal, onSlot: (yieldSlot) => (yielded = yieldSlot(() => userDone)) });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await expect(run1).rejects.toMatchObject({ name: "AbortError" });
    releaseUser();
    await yielded;

    const both = [runClaudeCode(base), runClaudeCode(base)];
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const third = runClaudeCode(base);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(3);
    gates[1]();
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    gates[2]();
    gates[3]();
    gates[0]();
    await Promise.all([...both, third]);
  });
});
