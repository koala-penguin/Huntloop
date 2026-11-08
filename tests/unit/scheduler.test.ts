import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { runDueWork } from "@/server/tasks/scheduler";
import { saveAiConfig } from "@/server/repo/settings";
import { logUsage } from "@/server/repo/usage";
import { searches, tasks } from "@/server/db/schema";
import { setClaudeCodeChecker, setClaudeCodeStatus, type ClaudeCodeStatus } from "@/server/ai/claude-code/status";
import { defaultAiConfig, type AiConfig } from "@/shared/ai-settings";
import { testDb } from "../helpers/db";

const NOW = new Date("2026-10-20T00:00:00Z");
const DUE = new Date(NOW.getTime() - 60_000);
const signedOut: ClaudeCodeStatus = { found: true, version: "2.1.296", loggedIn: false, authMethod: null, checkedAt: new Date(), error: null };
const signedIn: ClaudeCodeStatus = { ...signedOut, loggedIn: true, authMethod: "claude.ai" };

const env = process.env.HUNTLOOP_AI;
let checks = 0;
beforeEach(() => {
  // Not "fake": the subscription is the real (stubbed) CLI.
  process.env.HUNTLOOP_AI = "";
  checks = 0;
  setClaudeCodeChecker(async () => {
    checks++;
    return { ...signedOut, checkedAt: new Date() };
  });
});
afterEach(() => {
  process.env.HUNTLOOP_AI = env;
  setClaudeCodeChecker(null);
  setClaudeCodeStatus(null);
});

function setup(config: AiConfig) {
  const { db, userId } = testDb();
  saveAiConfig(db, userId, config);
  const search = db
    .insert(searches)
    .values({ userId, query: "frontend", sources: ["adzuna", "web_agent"], saved: true, schedule: "daily", nextRunAt: DUE })
    .returning()
    .get();
  const row = () => db.select().from(searches).where(eq(searches.id, search.id)).get()!;
  return { db, userId, search, row };
}

describe("daily searches and the Claude subscription", () => {
  it("holds a search while its subscription isn't signed in, without moving it a day", () => {
    setClaudeCodeStatus(signedOut);
    const { db, search, row } = setup(defaultAiConfig(undefined, "subscription"));
    const work = runDueWork(db, NOW);
    expect(work).toMatchObject({ searches: [], skippedSearches: [search.id] });
    expect(row().scheduleNote).toBe("cli_login");
    expect(row().nextRunAt?.getTime()).toBe(DUE.getTime());
    expect(db.select().from(tasks).all()).toEqual([]);

    setClaudeCodeStatus({ ...signedOut, found: false, version: null });
    runDueWork(db, NOW);
    expect(row().scheduleNote).toBe("cli_missing");
  });

  it("runs it once the subscription is ready", () => {
    setClaudeCodeStatus(signedIn);
    const { db, search, row } = setup(defaultAiConfig(undefined, "subscription"));
    expect(runDueWork(db, NOW).searches).toEqual([search.id]);
    expect(row().scheduleNote).toBeNull();
    expect(db.select().from(tasks).all().map((t) => t.kind)).toEqual(["search"]);
  });

  it("runs it with HUNTLOOP_AI=claude-code (assumed signed in)", () => {
    process.env.HUNTLOOP_AI = "claude-code";
    const { db, search } = setup(defaultAiConfig(undefined, "subscription"));
    expect(runDueWork(db, NOW).searches).toEqual([search.id]);
  });

  it("is held when any task of the run is on a subscription that isn't ready — before the budget check", () => {
    setClaudeCodeStatus(signedOut);
    const config = defaultAiConfig(undefined, "api");
    config.profiles.api.tasks.analyzePosting.connection = "subscription";
    config.profiles.api.budget = { dailyUsd: 1, monthlyUsd: null, warnAtPercent: 80 };
    const { db, userId, search, row } = setup(config);
    // Screening (on the API) is at the budget warning, which would skip the search for a day.
    logUsage(db, { userId, task: "screen", model: "claude-opus-5-5", servedModel: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0.9, simulated: false });
    expect(runDueWork(db, NOW).skippedSearches).toEqual([search.id]);
    expect(row().scheduleNote).toBe("cli_login");
    expect(row().nextRunAt?.getTime()).toBe(DUE.getTime());
  });

  it("only asks the CLI again once a negative answer has expired", () => {
    setClaudeCodeStatus(signedOut);
    const { db } = setup(defaultAiConfig(undefined, "subscription"));
    runDueWork(db, NOW);
    expect(checks).toBe(0);
  });
});
