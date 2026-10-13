import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/database";
import { preferences, profileVersions } from "../db/schema";
import { emptyProfile, profileDataSchema, type ProfileData } from "@/shared/schemas/profile";
import { defaultPreferences, preferencesSchema, type Preferences } from "@/shared/schemas/preferences";

export interface ProfileVersion {
  id: number;
  version: number;
  cvFileName: string | null;
  cvFilePath: string | null;
  cvText: string;
  data: ProfileData;
  createdAt: Date;
}

function toProfile(row: typeof profileVersions.$inferSelect): ProfileVersion {
  const parsed = profileDataSchema.safeParse(row.data);
  return {
    id: row.id,
    version: row.version,
    cvFileName: row.cvFileName,
    cvFilePath: row.cvFilePath,
    cvText: row.cvText,
    data: parsed.success ? parsed.data : { ...emptyProfile(), ...(row.data as Partial<ProfileData>) },
    createdAt: row.createdAt,
  };
}

export function getCurrentProfile(db: Db, userId: number): ProfileVersion | null {
  const row = db
    .select()
    .from(profileVersions)
    .where(eq(profileVersions.userId, userId))
    .orderBy(desc(profileVersions.version))
    .limit(1)
    .get();
  return row ? toProfile(row) : null;
}

export function getProfileVersion(db: Db, userId: number, version: number): ProfileVersion | null {
  const row = db
    .select()
    .from(profileVersions)
    .where(and(eq(profileVersions.userId, userId), eq(profileVersions.version, version)))
    .get();
  return row ? toProfile(row) : null;
}

export interface NewProfileVersion {
  cvText: string;
  data: ProfileData;
  /** Keep the previous CV file unless a new one is given. */
  cvFileName?: string | null;
  cvFilePath?: string | null;
}

/** Saves a new version (never overwrites). Returns the stored version. */
export function saveProfileVersion(db: Db, userId: number, input: NewProfileVersion): ProfileVersion {
  const data = profileDataSchema.parse(input.data);
  const previous = getCurrentProfile(db, userId);
  const row = db
    .insert(profileVersions)
    .values({
      userId,
      version: (previous?.version ?? 0) + 1,
      cvFileName: input.cvFileName !== undefined ? input.cvFileName : (previous?.cvFileName ?? null),
      cvFilePath: input.cvFilePath !== undefined ? input.cvFilePath : (previous?.cvFilePath ?? null),
      cvText: input.cvText,
      data,
    })
    .returning()
    .get();
  return toProfile(row);
}

export function getPreferences(db: Db, userId: number): Preferences {
  const row = db.select().from(preferences).where(eq(preferences.userId, userId)).get();
  if (!row) return defaultPreferences();
  const parsed = preferencesSchema.safeParse({ ...defaultPreferences(), ...(row.data as object) });
  return parsed.success ? parsed.data : defaultPreferences();
}

export function savePreferences(db: Db, userId: number, value: Preferences): Preferences {
  const data = preferencesSchema.parse(value);
  const updatedAt = new Date();
  db.insert(preferences)
    .values({ userId, data, updatedAt })
    .onConflictDoUpdate({ target: preferences.userId, set: { data, updatedAt } })
    .run();
  return data;
}
