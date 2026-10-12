import "server-only";
import { cache } from "react";
import { getDb } from "./db/client";
import { getLocalUser } from "./repo/users";
import { getAiSettings } from "./repo/settings";
import { envDefaultModel } from "./config/env";
import type { AiContext } from "./ai/client";

/** Per-request app context for pages, route handlers and server actions. */
export const appContext = cache(() => {
  const db = getDb();
  const user = getLocalUser(db);
  const settings = getAiSettings(db, user.id, envDefaultModel());
  const ai: AiContext = { db, userId: user.id, settings };
  return { db, user, settings, ai };
});
