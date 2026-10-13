import { createDatabase } from "@/server/db/database";
import { getLocalUser } from "@/server/repo/users";

/** A fresh, fully migrated in-memory database with the local user created. */
export function testDb() {
  const db = createDatabase(":memory:");
  const user = getLocalUser(db);
  return { db, userId: user.id };
}
