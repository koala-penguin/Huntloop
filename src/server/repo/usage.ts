import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/database";
import { usageLog } from "../db/schema";
import type { UsageCost } from "../ai/cost";

export interface UsageEntry extends UsageCost {
  userId: number;
  task: string;
  model: string;
  servedModel: string | null;
  simulated: boolean;
}

export function logUsage(db: Db, entry: UsageEntry): void {
  db.insert(usageLog)
    .values({
      userId: entry.userId,
      task: entry.task,
      model: entry.model,
      servedModel: entry.servedModel,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheReadTokens: entry.cacheReadTokens,
      cacheWriteTokens: entry.cacheWriteTokens,
      webSearches: entry.webSearches,
      costUsd: entry.costUsd,
      simulated: entry.simulated,
    })
    .run();
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfLocalMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function spentSince(db: Db, userId: number, since: Date): number {
  const row = db
    .select({ total: sql<number>`coalesce(sum(${usageLog.costUsd}), 0)` })
    .from(usageLog)
    .where(and(eq(usageLog.userId, userId), eq(usageLog.simulated, false), gte(usageLog.createdAt, since)))
    .get();
  return row?.total ?? 0;
}

export interface SpendSummary {
  todayUsd: number;
  monthUsd: number;
}

export function spendSummary(db: Db, userId: number, now = new Date()): SpendSummary {
  return {
    todayUsd: spentSince(db, userId, startOfLocalDay(now)),
    monthUsd: spentSince(db, userId, startOfLocalMonth(now)),
  };
}
