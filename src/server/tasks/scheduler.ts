import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/database";
import { searches, tasks, watchedBoards } from "../db/schema";
import { resolveTaskModel } from "@/shared/ai-settings";
import { budgetStatus, modeFor, settingsFor } from "../ai/client";
import { subscriptionNearLimit } from "../ai/claude-code/limits";
import { SEARCH_TASK } from "../search/tasks";
import { enqueueTask } from "./runner";
import { WATCH_CHECK_TASK } from "./handlers/watch-check";

/**
 * Daily work while Huntloop is running: saved searches the user set to "check daily" (API sources
 * only — SEEK, LinkedIn and the browsing agent never run unattended) and watched job boards.
 * Searches are skipped while the AI budget is at its warning level or over the cap — or, on the
 * Claude subscription, while its usage limit is close or reached.
 */

const DAY = 86_400_000;
const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 60_000;

function hasActiveTask(db: Db, kind: string, key: "searchId" | "watchId", id: number): boolean {
  return !!db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.kind, kind), inArray(tasks.status, ["queued", "running", "needs_user_action"]), sql`json_extract(${tasks.payload}, ${`$.${key}`}) = ${id}`))
    .get();
}

export interface DueWork {
  searches: number[];
  skippedSearches: number[];
  watches: number[];
}

export function runDueWork(db: Db, now = new Date()): DueWork {
  const out: DueWork = { searches: [], skippedSearches: [], watches: [] };
  const next = new Date(now.getTime() + DAY);

  const dueSearches = db
    .select()
    .from(searches)
    .where(and(eq(searches.saved, true), eq(searches.schedule, "daily"), or(isNull(searches.nextRunAt), lte(searches.nextRunAt, now))))
    .all();
  for (const search of dueSearches) {
    if (hasActiveTask(db, SEARCH_TASK, "searchId", search.id)) continue;
    const ctx = { db, userId: search.userId };
    const settings = settingsFor(ctx);
    // Screening is most of a search's AI work; its connection decides which limit applies.
    const mode = modeFor(resolveTaskModel(settings, "screen").connection);
    const budget = budgetStatus({ ...ctx, settings });
    const note = mode === "claude_code" ? (subscriptionNearLimit(settings.budget.warnAtPercent, now) ? "limit" : null) : budget.exceeded || budget.warning ? "budget" : null;
    if (note) {
      db.update(searches).set({ nextRunAt: next, scheduleNote: note }).where(eq(searches.id, search.id)).run();
      out.skippedSearches.push(search.id);
      continue;
    }
    enqueueTask(db, search.userId, SEARCH_TASK, { searchId: search.id, scheduled: true });
    db.update(searches).set({ nextRunAt: next, scheduleNote: null }).where(eq(searches.id, search.id)).run();
    out.searches.push(search.id);
  }

  const dueWatches = db
    .select()
    .from(watchedBoards)
    .where(and(eq(watchedBoards.autoCheck, true), or(isNull(watchedBoards.nextCheckAt), lte(watchedBoards.nextCheckAt, now))))
    .all();
  for (const watch of dueWatches) {
    if (hasActiveTask(db, WATCH_CHECK_TASK, "watchId", watch.id)) continue;
    enqueueTask(db, watch.userId, WATCH_CHECK_TASK, { watchId: watch.id });
    db.update(watchedBoards).set({ nextCheckAt: next }).where(eq(watchedBoards.id, watch.id)).run();
    out.watches.push(watch.id);
  }
  return out;
}

interface SchedulerState {
  timer?: NodeJS.Timeout;
  first?: NodeJS.Timeout;
}

const state = ((globalThis as unknown as { huntloopScheduler?: SchedulerState }).huntloopScheduler ??= {});

export function startScheduler(db: Db): void {
  if (state.timer || process.env.HUNTLOOP_SCHEDULER === "off") return;
  const tick = () => {
    try {
      runDueWork(db);
    } catch (error) {
      console.error("[huntloop] scheduler", error);
    }
  };
  state.first = setTimeout(tick, FIRST_TICK_MS);
  state.timer = setInterval(tick, TICK_MS);
  state.first.unref?.();
  state.timer.unref?.();
}
