"use server";

import { revalidatePath } from "next/cache";
import { searchFiltersSchema } from "@/shared/schemas/search";
import { appContext } from "@/server/context";
import { createSearch, deleteSearch, rerunSearch, saveSearch, unsaveSearch } from "@/server/search/tasks";
import { z } from "zod";
import { getSearch } from "@/server/search/run";
import { cleanFilters } from "@/server/ai/tasks/parse-search";
import type { ActionResult } from "@/app/profile/actions";

export async function createSearchAction(query: string): Promise<ActionResult<{ searchId: number }>> {
  if (typeof query !== "string" || query.length > 1000) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  const { searchId } = createSearch(db, user.id, query);
  revalidatePath("/search");
  return { ok: true, value: { searchId } };
}

/** Run a search again; with `filters`, the edited filters replace the current ones first. */
export async function rerunSearchAction(searchId: number, filters: unknown): Promise<ActionResult<{ taskId: number }>> {
  const { db, user } = appContext();
  if (!getSearch(db, user.id, searchId)) return { ok: false, error: "not_found" };
  let parsed = undefined;
  if (filters !== null && filters !== undefined) {
    const result = searchFiltersSchema.safeParse(filters);
    if (!result.success) return { ok: false, error: "invalid" };
    parsed = cleanFilters(result.data);
  }
  const taskId = rerunSearch(db, user.id, searchId, parsed);
  revalidatePath(`/search/${searchId}`);
  return { ok: true, value: { taskId } };
}

/** Keep a search in the saved list (name, optional daily check), or update those settings. */
export async function saveSearchAction(searchId: number, name: string, daily: boolean): Promise<ActionResult<null>> {
  const parsed = z.object({ name: z.string().max(120), daily: z.boolean() }).safeParse({ name, daily });
  if (!parsed.success) return { ok: false, error: "invalid" };
  const { db, user } = appContext();
  if (!getSearch(db, user.id, searchId)) return { ok: false, error: "not_found" };
  saveSearch(db, user.id, searchId, parsed.data);
  revalidatePath("/search", "layout");
  return { ok: true, value: null };
}

export async function unsaveSearchAction(searchId: number): Promise<ActionResult<null>> {
  const { db, user } = appContext();
  unsaveSearch(db, user.id, searchId);
  revalidatePath("/search", "layout");
  return { ok: true, value: null };
}

export async function deleteSearchAction(searchId: number): Promise<ActionResult<null>> {
  const { db, user } = appContext();
  deleteSearch(db, user.id, searchId);
  revalidatePath("/search", "layout");
  return { ok: true, value: null };
}
