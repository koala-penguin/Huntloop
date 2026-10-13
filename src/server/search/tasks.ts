import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/database";
import { searches, tasks } from "../db/schema";
import { enqueueTask } from "../tasks/runner";
import type { SearchFilters } from "@/shared/schemas/search";
import { availableSources } from "./run";

export const SEARCH_TASK = "search";

function searchTasks(db: Db, userId: number, searchId: number, statuses: string[]) {
  return db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.kind, SEARCH_TASK), inArray(tasks.status, statuses), sql`json_extract(${tasks.payload}, '$.searchId') = ${searchId}`))
    .orderBy(desc(tasks.id));
}

export function activeSearchTask(db: Db, userId: number, searchId: number): number | null {
  return searchTasks(db, userId, searchId, ["queued", "running"]).get()?.id ?? null;
}

/** The latest finished run, for "new since last run". */
export function latestSearchTask(db: Db, userId: number, searchId: number): number | null {
  return searchTasks(db, userId, searchId, ["succeeded"]).get()?.id ?? null;
}

export function createSearch(db: Db, userId: number, query: string): { searchId: number; taskId: number } {
  const search = db.insert(searches).values({ userId, query: query.trim(), sources: availableSources(db, userId) }).returning().get();
  return { searchId: search.id, taskId: enqueueTask(db, userId, SEARCH_TASK, { searchId: search.id }).id };
}

/** Runs a search again, optionally with edited filters. Returns the running task if one exists. */
export function rerunSearch(db: Db, userId: number, searchId: number, filters?: SearchFilters): number {
  const running = activeSearchTask(db, userId, searchId);
  if (running) return running;
  db.update(searches)
    .set({ ...(filters ? { filters } : {}), sources: availableSources(db, userId) })
    .where(and(eq(searches.id, searchId), eq(searches.userId, userId)))
    .run();
  return enqueueTask(db, userId, SEARCH_TASK, { searchId }).id;
}
