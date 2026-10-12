import { and, eq } from "drizzle-orm";
import type { Db } from "../db/database";
import { appSettings } from "../db/schema";
import { aiSettingsSchema, normalizeAiSettings, type AiSettings } from "@/shared/ai-settings";
import type { ModelId } from "@/shared/models";

const AI_SETTINGS_KEY = "ai";

function readSetting(db: Db, userId: number, key: string): unknown {
  const row = db
    .select()
    .from(appSettings)
    .where(and(eq(appSettings.userId, userId), eq(appSettings.key, key)))
    .get();
  return row?.value;
}

function writeSetting(db: Db, userId: number, key: string, value: unknown): void {
  const updatedAt = new Date();
  db.insert(appSettings)
    .values({ userId, key, value, updatedAt })
    .onConflictDoUpdate({ target: [appSettings.userId, appSettings.key], set: { value, updatedAt } })
    .run();
}

export function getAiSettings(db: Db, userId: number, envDefaultModel?: ModelId): AiSettings {
  return normalizeAiSettings(readSetting(db, userId, AI_SETTINGS_KEY), envDefaultModel);
}

export function saveAiSettings(db: Db, userId: number, settings: AiSettings): AiSettings {
  const valid = aiSettingsSchema.parse(settings);
  writeSetting(db, userId, AI_SETTINGS_KEY, valid);
  return valid;
}
