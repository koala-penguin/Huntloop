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

export interface UsageRow {
  key: string;
  calls: number;
  /** Calls answered by the demo-mode simulator (not billed). */
  simulatedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
}

export interface UsageReport {
  days: Array<{ date: string; costUsd: number; calls: number }>;
  byTask: UsageRow[];
  byModel: UsageRow[];
  totalUsd: number;
  calls: number;
  simulatedCalls: number;
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Spend and token use over the last `days` days (local time): per day, per AI task and per model. */
export function usageReport(db: Db, userId: number, days = 30, now = new Date()): UsageReport {
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
  const rows = db
    .select()
    .from(usageLog)
    .where(and(eq(usageLog.userId, userId), gte(usageLog.createdAt, since)))
    .all();
  const perDay = new Map<string, { costUsd: number; calls: number }>();
  for (let i = 0; i < days; i++) {
    perDay.set(localDate(new Date(since.getFullYear(), since.getMonth(), since.getDate() + i)), { costUsd: 0, calls: 0 });
  }
  const group = (keyOf: (r: (typeof rows)[number]) => string) => {
    const map = new Map<string, UsageRow>();
    for (const r of rows) {
      const key = keyOf(r);
      const g = map.get(key) ?? { key, calls: 0, simulatedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 0 };
      g.calls++;
      if (r.simulated) g.simulatedCalls++;
      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      g.cacheReadTokens += r.cacheReadTokens;
      g.cacheWriteTokens += r.cacheWriteTokens;
      g.webSearches += r.webSearches;
      if (!r.simulated) g.costUsd += r.costUsd;
      map.set(key, g);
    }
    return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  };
  for (const r of rows) {
    const day = perDay.get(localDate(r.createdAt));
    if (!day) continue;
    day.calls++;
    if (!r.simulated) day.costUsd += r.costUsd;
  }
  return {
    days: [...perDay.entries()].map(([date, d]) => ({ date, ...d })),
    byTask: group((r) => r.task),
    byModel: group((r) => r.servedModel ?? r.model),
    totalUsd: rows.filter((r) => !r.simulated).reduce((s, r) => s + r.costUsd, 0),
    calls: rows.length,
    simulatedCalls: rows.filter((r) => r.simulated).length,
  };
}
