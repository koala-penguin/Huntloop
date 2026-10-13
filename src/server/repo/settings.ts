import { and, eq } from "drizzle-orm";
import type { Db } from "../db/database";
import { appSettings } from "../db/schema";
import { aiConfigSchema, aiSettingsSchema, normalizeAiConfig, type AiConfig, type AiSettings, type Connection } from "@/shared/ai-settings";
import type { ModelId } from "@/shared/models";
import { normalizeSourceSettings, sourceSettingsSchema, type SourceSettings } from "@/shared/source-settings";

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

/** Both profiles (API key, Claude subscription) and the active one. `defaultActive` applies until the user picks. */
export function getAiConfig(db: Db, userId: number, envDefaultModel?: ModelId, defaultActive?: Connection): AiConfig {
  return normalizeAiConfig(readSetting(db, userId, AI_SETTINGS_KEY), envDefaultModel, defaultActive);
}

export function saveAiConfig(db: Db, userId: number, config: AiConfig): AiConfig {
  const valid = aiConfigSchema.parse(config);
  writeSetting(db, userId, AI_SETTINGS_KEY, valid);
  return valid;
}

/** The settings in use: the active profile. */
export function getAiSettings(db: Db, userId: number, envDefaultModel?: ModelId, defaultActive?: Connection): AiSettings {
  const config = getAiConfig(db, userId, envDefaultModel, defaultActive);
  return config.profiles[config.active];
}

/** Saves one profile (the one named by `settings.connection`); the other profile and the active choice are kept. */
export function saveAiSettings(db: Db, userId: number, settings: AiSettings, defaultActive?: Connection): AiSettings {
  const valid = aiSettingsSchema.parse(settings);
  const config = getAiConfig(db, userId, undefined, defaultActive);
  saveAiConfig(db, userId, { ...config, profiles: { ...config.profiles, [valid.connection]: valid } });
  return valid;
}

const SOURCE_SETTINGS_KEY = "sources";

export function getSourceSettings(db: Db, userId: number): SourceSettings {
  return normalizeSourceSettings(readSetting(db, userId, SOURCE_SETTINGS_KEY));
}

export function saveSourceSettings(db: Db, userId: number, settings: SourceSettings): SourceSettings {
  const valid = normalizeSourceSettings(sourceSettingsSchema.parse(settings));
  writeSetting(db, userId, SOURCE_SETTINGS_KEY, valid);
  return valid;
}
