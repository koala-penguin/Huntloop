import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { appContext } from "@/server/context";
import { isConversationBusy, runChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { ensureInterviewConversation } from "@/server/ai/chat/interview";
import { getInterview } from "@/server/repo/interviews";
import { errorCodeOf } from "@/server/errors";
import { CONVERSATION_STAGES } from "@/shared/schemas/interview";

export const runtime = "nodejs";

const bodySchema = z.object({
  text: z.string().trim().min(1).max(8000),
  stage: z.enum(CONVERSATION_STAGES),
  experienceRef: z.string().regex(/^exp-\d+$/).nullable(),
});

/** Sends a message to the CV interviewer (one conversation per step, and per role in the role chats) and streams the reply as server-sent events. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/cv-interview/[id]/chat">) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { ai } = appContext();
  const interview = getInterview(ai.db, ai.userId, Number(id));
  if (!interview || interview.status !== "in_progress") return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (parsed.data.stage === "role_deep" && !parsed.data.experienceRef) return NextResponse.json({ error: "invalid" }, { status: 400 });

  let conversationId: number;
  try {
    conversationId = ensureInterviewConversation(ai, interview.id, parsed.data.stage, parsed.data.experienceRef).id;
  } catch (error) {
    const code = errorCodeOf(error);
    if (!code) throw error;
    return NextResponse.json({ error: code }, { status: code === "not_found" ? 404 : 400 });
  }
  if (isConversationBusy(conversationId)) return NextResponse.json({ error: "chat_busy" }, { status: 409 });

  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: ChatEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          open = false;
        }
      };
      void runChatTurn(ai, conversationId, parsed.data.text, emit).finally(() => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}
