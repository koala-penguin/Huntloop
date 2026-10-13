import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/database";
import { jobSightings, searches, tasks } from "../db/schema";
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

const DAY = 86_400_000;

/** Keeps a search in the saved list, with a name and optionally a daily check. */
export function saveSearch(db: Db, userId: number, searchId: number, input: { name: string; daily: boolean }, now = new Date()): void {
  db.update(searches)
    .set({ saved: true, name: input.name.trim().slice(0, 120) || null, schedule: input.daily ? "daily" : "off", nextRunAt: input.daily ? new Date(now.getTime() + DAY) : null, scheduleNote: null })
    .where(and(eq(searches.id, searchId), eq(searches.userId, userId)))
    .run();
}

export function unsaveSearch(db: Db, userId: number, searchId: number): void {
  db.update(searches)
    .set({ saved: false, schedule: "off", nextRunAt: null, scheduleNote: null })
    .where(and(eq(searches.id, searchId), eq(searches.userId, userId)))
    .run();
}

/** Deletes the search and its sightings; the jobs it found stay in the user's list. */
export function deleteSearch(db: Db, userId: number, searchId: number): void {
  db.delete(searches)
    .where(and(eq(searches.id, searchId), eq(searches.userId, userId)))
    .run();
}

/** Jobs a search found for the first time in its latest run. */
export function newInLatestRun(db: Db, userId: number, searchId: number): number {
  const latest = latestSearchTask(db, userId, searchId);
  if (!latest) return 0;
  const rows = db
    .select({ jobId: jobSightings.jobId, taskId: jobSightings.taskId })
    .from(jobSightings)
    .where(eq(jobSightings.searchId, searchId))
    .orderBy(asc(jobSightings.id))
    .all();
  const first = new Map<number, number | null>();
  for (const r of rows) if (!first.has(r.jobId)) first.set(r.jobId, r.taskId);
  return [...first.values()].filter((t) => t === latest).length;
}
