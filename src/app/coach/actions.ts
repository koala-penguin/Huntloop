"use server";

import { revalidatePath } from "next/cache";
import { appContext } from "@/server/context";
import { isConversationBusy } from "@/server/ai/chat/harness";
import { createCoachConversation, getCoachConversation } from "@/server/ai/chat/coach";
import type { ActionResult } from "@/app/profile/actions";

/** Starts a fresh coach conversation (the old one is kept). */
export async function newCoachConversationAction(): Promise<ActionResult<null>> {
  const { ai } = appContext();
  const current = getCoachConversation(ai);
  if (current && isConversationBusy(current.id)) return { ok: false, error: "chat_busy" };
  createCoachConversation(ai);
  revalidatePath("/coach");
  return { ok: true, value: null };
}
