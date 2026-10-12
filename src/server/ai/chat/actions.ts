import { and, eq } from "drizzle-orm";
import { chatActions, conversations } from "../../db/schema";
import { getJob, setJobStatus } from "../../repo/jobs";
import { getCurrentProfile, saveProfileVersion } from "../../repo/profile";
import { rescoreAllJobs } from "../../jobs/fit";
import { UserFacingError } from "../../errors";
import type { AiContext } from "../client";
import { companyResearchHooks } from "./research-hooks";

/**
 * The user's answer to a card the AI proposed. Only this click changes the profile or the job;
 * the model learns the outcome through a context update on the next turn.
 */
export function resolveChatAction(ctx: AiContext, actionId: number, decision: "accept" | "dismiss"): void {
  const row = ctx.db
    .select({ action: chatActions, conversation: conversations })
    .from(chatActions)
    .innerJoin(conversations, eq(chatActions.conversationId, conversations.id))
    .where(and(eq(chatActions.id, actionId), eq(conversations.userId, ctx.userId)))
    .get();
  if (!row) throw new UserFacingError("not_found");
  if (row.action.status !== "pending") return;
  const payload = row.action.payload as Record<string, unknown>;

  if (decision === "accept") {
    if (row.action.kind === "profile_fact") {
      const profile = getCurrentProfile(ctx.db, ctx.userId);
      if (!profile) throw new UserFacingError("no_profile");
      const fact = { id: `fact-${Date.now().toString(36)}`, text: String(payload.fact), source: "chat" as const };
      saveProfileVersion(ctx.db, ctx.userId, { cvText: profile.cvText, data: { ...profile.data, facts: [...profile.data.facts, fact] } });
      rescoreAllJobs(ctx.db, ctx.userId);
    } else if (row.action.kind === "proceed" && row.conversation.jobId) {
      setJobStatus(ctx.db, ctx.userId, row.conversation.jobId, "applying", "Agreed in chat");
      const job = getJob(ctx.db, ctx.userId, row.conversation.jobId);
      if (job && !companyResearchHooks.isReady(ctx, job)) companyResearchHooks.start(ctx, job);
    }
  }
  ctx.db
    .update(chatActions)
    .set({ status: decision === "accept" ? "accepted" : "dismissed", resolvedAt: new Date() })
    .where(eq(chatActions.id, actionId))
    .run();
}
