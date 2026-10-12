"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { aiSettingsSchema, type AiSettings } from "@/shared/ai-settings";
import { MODEL_IDS, type ModelId } from "@/shared/models";
import { isLocale, LOCALE_COOKIE } from "@/i18n/locales";
import { appContext } from "@/server/context";
import { saveAiSettings } from "@/server/repo/settings";
import { setUserLocale } from "@/server/repo/users";
import { currentAiMode, getAnthropic } from "@/server/ai/client";

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) throw new Error("Unsupported language");
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  const { db, user } = appContext();
  setUserLocale(db, user.id, locale);
  revalidatePath("/", "layout");
}

export type SaveResult = { ok: true; settings: AiSettings } | { ok: false; error: string };

export async function saveAiSettingsAction(input: unknown): Promise<SaveResult> {
  const parsed = aiSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => i.message).join("; ") };
  const { db, user } = appContext();
  const settings = saveAiSettings(db, user.id, parsed.data);
  revalidatePath("/", "layout");
  return { ok: true, settings };
}

export type ModelAccessResult =
  | { ok: true; mode: "live" | "fake"; available: ModelId[] }
  | { ok: false; error: string };

/** Lists the models this API key can use (Models API) and intersects them with Huntloop's registry. */
export async function checkModelAccessAction(): Promise<ModelAccessResult> {
  try {
    const ids = new Set<string>();
    for await (const model of getAnthropic().models.list()) ids.add(model.id);
    return { ok: true, mode: currentAiMode(), available: MODEL_IDS.filter((id) => ids.has(id)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
