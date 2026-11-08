"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { profileDataSchema } from "@/shared/schemas/profile";
import { preferencesSchema } from "@/shared/schemas/preferences";
import { appContext } from "@/server/context";
import { getCurrentProfile, savePreferences, saveProfileVersion } from "@/server/repo/profile";
import { rescoreAllJobs } from "@/server/jobs/fit";

const saveProfileInput = z.object({ cvText: z.string(), data: profileDataSchema });

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function saveProfileAction(input: unknown): Promise<ActionResult<{ version: number }>> {
  const parsed = saveProfileInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const { db, user } = appContext();
  if (!getCurrentProfile(db, user.id) && !parsed.data.cvText.trim()) return { ok: false, error: "cv_too_short" };
  const saved = saveProfileVersion(db, user.id, parsed.data);
  rescoreAllJobs(db, user.id);
  revalidatePath("/", "layout");
  return { ok: true, value: { version: saved.version } };
}

export async function savePreferencesAction(input: unknown): Promise<ActionResult<null>> {
  const parsed = preferencesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const { db, user } = appContext();
  savePreferences(db, user.id, parsed.data);
  rescoreAllJobs(db, user.id);
  revalidatePath("/", "layout");
  return { ok: true, value: null };
}
