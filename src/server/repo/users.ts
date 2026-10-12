import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/database";
import { users } from "../db/schema";
import { isLocale, type Locale } from "@/i18n/locales";

export type LocalUser = typeof users.$inferSelect;

/** Huntloop v1 is single-user: the first user row is "you". Created on first use. */
export function getLocalUser(db: Db): LocalUser {
  const existing = db.select().from(users).orderBy(asc(users.id)).limit(1).get();
  if (existing) return existing;
  return db.insert(users).values({ locale: "en" }).returning().get();
}

export function setUserLocale(db: Db, userId: number, locale: Locale): void {
  db.update(users).set({ locale }).where(eq(users.id, userId)).run();
}

export function userLocale(user: LocalUser): Locale {
  return isLocale(user.locale) ? user.locale : "en";
}
