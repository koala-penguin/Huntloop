"use server";

import { revalidatePath } from "next/cache";
import { searchFiltersSchema } from "@/shared/schemas/search";
import { appContext } from "@/server/context";
import { createSearch, rerunSearch } from "@/server/search/tasks";
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
