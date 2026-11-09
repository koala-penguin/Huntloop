import { and, eq } from "drizzle-orm";
import { chatActions, conversations } from "../../db/schema";
import { getCurrentProfile, saveProfileVersion } from "../../repo/profile";
import { rescoreAllJobs } from "../../jobs/fit";
import { UserFacingError } from "../../errors";
import type { AiContext } from "../client";
import { proceedWithJob } from "../../jobs/proceed";
import { getInterview, interviewForConversation, setPolished } from "../../repo/interviews";
import { applyInterviewEdits } from "../../cv/interview-build";

/**
 * The user's answer to a card the AI proposed. Only this click changes the profile or the job;
 * the model learns the outcome through a context update on the next turn.
 */
export function resolveChatAction(ctx: AiContext, actionId: number, choice: "accept" | "dismiss"): void {
  let decision = choice;
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
      proceedWithJob(ctx.db, ctx.userId, row.conversation.jobId, "chat");
    } else if (row.action.kind === "interview_polish") {
      // The candidate takes the cleaner version of their answer. An answer edited or deleted since
      // then has nothing to take it: the card is simply closed.
      const link = interviewForConversation(ctx.db, row.conversation.id);
      const interview = link ? getInterview(ctx.db, ctx.userId, link.interviewId) : null;
      if (!interview) throw new UserFacingError("not_found");
      try {
        setPolished(ctx.db, interview, Number(payload.answerId), String(payload.text));
      } catch (error) {
        if (!(error instanceof UserFacingError) || error.code !== "not_found") throw error;
        decision = "dismiss";
      }
      if (decision === "accept" && interview.status === "completed") applyInterviewEdits(ctx.db, ctx.userId, interview);
    }
  }
  ctx.db
    .update(chatActions)
    .set({ status: decision === "accept" ? "accepted" : "dismissed", resolvedAt: new Date() })
    .where(eq(chatActions.id, actionId))
    .run();
}
