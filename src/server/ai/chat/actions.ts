import { and, eq } from "drizzle-orm";
import { chatActions, conversations } from "../../db/schema";
import { getCurrentProfile, saveProfileVersion } from "../../repo/profile";
import { rescoreAllJobs } from "../../jobs/fit";
import { UserFacingError } from "../../errors";
import type { AiContext } from "../client";
import { proceedWithJob } from "../../jobs/proceed";
import { getCvBuilder, cvBuilderForConversation, setPolished, type CvBuilder } from "../../repo/cv-builder";
import { applyCvBuilderEdits } from "../../cv/cv-builder-build";
import { acceptFormCard, dismissFormCard } from "./cv-builder-forms";

/**
 * The user's own edit of a cleaner version the interviewer offered (their words, so no check beyond
 * length). Like accepting it as offered: an answer edited or deleted since then has nothing to take
 * it, so the card is closed instead. Returns whether the profile was rebuilt.
 */
export function acceptEditedPolish(ctx: AiContext, builder: CvBuilder, actionId: number, text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (value.length < 2 || value.length > 4000) throw new UserFacingError("invalid");
  const action = ctx.db
    .select()
    .from(chatActions)
    .where(and(eq(chatActions.id, actionId), eq(chatActions.kind, "cv_builder_polish")))
    .get();
  if (!action || cvBuilderForConversation(ctx.db, action.conversationId)?.cvBuilderId !== builder.id) throw new UserFacingError("not_found");
  if (action.status !== "pending") return false;
  const payload = action.payload as Record<string, unknown>;
  try {
    setPolished(ctx.db, builder, Number(payload.answerId), value);
  } catch (error) {
    if (!(error instanceof UserFacingError) || error.code !== "not_found") throw error;
    ctx.db.update(chatActions).set({ status: "dismissed", resolvedAt: new Date() }).where(eq(chatActions.id, action.id)).run();
    return false;
  }
  ctx.db
    .update(chatActions)
    .set({ status: "accepted", resolvedAt: new Date(), payload: { ...payload, text: value, edited: true } })
    .where(eq(chatActions.id, action.id))
    .run();
  return applyCvBuilderEdits(ctx.db, ctx.userId, builder);
}

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

  if (row.action.kind === "cv_builder_form") {
    // A card of CV-builder session data: accepting saves it through the same checks as the card's own button
    // (never the proposed value unchecked); dismissing saves nothing.
    if (decision === "dismiss") return dismissFormCard(ctx, row.action);
    const link = cvBuilderForConversation(ctx.db, row.conversation.id);
    const builder = link ? getCvBuilder(ctx.db, ctx.userId, link.cvBuilderId) : null;
    if (!builder) throw new UserFacingError("not_found");
    if (!acceptFormCard(ctx, builder, row.action.id).ok) throw new UserFacingError("invalid");
    return;
  }

  if (decision === "accept") {
    if (row.action.kind === "profile_fact") {
      const profile = getCurrentProfile(ctx.db, ctx.userId);
      if (!profile) throw new UserFacingError("no_profile");
      const fact = { id: `fact-${Date.now().toString(36)}`, text: String(payload.fact), source: "chat" as const };
      saveProfileVersion(ctx.db, ctx.userId, { cvText: profile.cvText, data: { ...profile.data, facts: [...profile.data.facts, fact] } });
      rescoreAllJobs(ctx.db, ctx.userId);
    } else if (row.action.kind === "proceed" && row.conversation.jobId) {
      proceedWithJob(ctx.db, ctx.userId, row.conversation.jobId, "chat");
    } else if (row.action.kind === "cv_builder_polish") {
      // The candidate takes the cleaner version of their answer. An answer edited or deleted since
      // then has nothing to take it: the card is simply closed.
      const link = cvBuilderForConversation(ctx.db, row.conversation.id);
      const builder = link ? getCvBuilder(ctx.db, ctx.userId, link.cvBuilderId) : null;
      if (!builder) throw new UserFacingError("not_found");
      try {
        setPolished(ctx.db, builder, Number(payload.answerId), String(payload.text));
      } catch (error) {
        if (!(error instanceof UserFacingError) || error.code !== "not_found") throw error;
        decision = "dismiss";
      }
      if (decision === "accept" && builder.status === "completed") applyCvBuilderEdits(ctx.db, ctx.userId, builder);
    }
  }
  ctx.db
    .update(chatActions)
    .set({ status: decision === "accept" ? "accepted" : "dismissed", resolvedAt: new Date() })
    .where(eq(chatActions.id, actionId))
    .run();
}
