import { describe, expect, it } from "vitest";
import { usageLog } from "@/server/db/schema";
import { usageReport } from "@/server/repo/usage";
import { testDb } from "../helpers/db";

describe("usage report", () => {
  it("adds up spend per day, task and model; demo-mode calls are counted but cost nothing", () => {
    const { db, userId } = testDb();
    const now = new Date(2026, 9, 13, 15, 0);
    const at = (daysAgo: number) => new Date(2026, 9, 13 - daysAgo, 10, 0);
    const row = (task: string, model: string, costUsd: number, daysAgo: number, extra: Partial<typeof usageLog.$inferInsert> = {}) =>
      db
        .insert(usageLog)
        .values({ userId, task, model, servedModel: model, costUsd, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, createdAt: at(daysAgo), ...extra })
        .run();
    row("assess", "claude-opus-5-5", 0.2, 0);
    row("assess", "claude-opus-5-5", 0.1, 2);
    row("chat", "claude-sonnet-5-5", 0.05, 2, { webSearches: 2 });
    row("chat", "claude-opus-5-5", 9, 0, { simulated: true });
    row("assess", "claude-opus-5-5", 5, 40); // outside the window

    const report = usageReport(db, userId, 30, now);
    expect(report.days).toHaveLength(30);
    expect(report.days.at(-1)).toEqual({ date: "2026-10-13", costUsd: 0.2, calls: 2 });
    expect(report.days.at(-3)).toMatchObject({ date: "2026-10-11", calls: 2 });
    expect(report.days.at(-3)!.costUsd).toBeCloseTo(0.15);
    expect(report.totalUsd).toBeCloseTo(0.35);
    expect(report).toMatchObject({ calls: 4, simulatedCalls: 1 });
    expect(report.byTask.map((r) => [r.key, r.calls, r.simulatedCalls, Number(r.costUsd.toFixed(2))])).toEqual([
      ["assess", 2, 0, 0.3],
      ["chat", 2, 1, 0.05],
    ]);
    expect(report.byModel.find((r) => r.key === "claude-sonnet-5-5")).toMatchObject({ calls: 1, webSearches: 2, cacheReadTokens: 3000 });
  });
});
