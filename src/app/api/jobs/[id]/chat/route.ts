import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { appContext } from "@/server/context";
import { getJob } from "@/server/repo/jobs";
import { createJobConversation, getJobConversation, isConversationBusy, runJobChatTurn, type ChatEvent } from "@/server/ai/chat/harness";

export const runtime = "nodejs";

const bodySchema = z.object({ text: z.string().trim().min(1).max(8000) });

/**
 * Sends a message in the job's chat and streams the reply as server-sent events. The turn keeps
 * running (and is saved) even if the browser disconnects.
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/chat">) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { db, user, ai } = appContext();
  const job = getJob(db, user.id, Number((await ctx.params).id));
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (job.intakeStatus !== "ready") return NextResponse.json({ error: "job_not_ready" }, { status: 409 });

  const conversation = getJobConversation(ai, job.id) ?? createJobConversation(ai, job);
  if (isConversationBusy(conversation.id)) return NextResponse.json({ error: "chat_busy" }, { status: 409 });

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
      void runJobChatTurn(ai, conversation.id, parsed.data.text, emit).finally(() => {
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
