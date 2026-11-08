import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { appContext } from "@/server/context";
import { isConversationBusy, runChatTurn, type ChatEvent } from "@/server/ai/chat/harness";
import { createCoachConversation, getCoachConversation } from "@/server/ai/chat/coach";

export const runtime = "nodejs";

const bodySchema = z.object({ text: z.string().trim().min(1).max(8000) });

/** Sends a message to the coach and streams the reply as server-sent events (the turn finishes even if the browser leaves). */
export async function POST(request: NextRequest) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { ai } = appContext();
  const conversation = getCoachConversation(ai) ?? createCoachConversation(ai);
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
      void runChatTurn(ai, conversation.id, parsed.data.text, emit).finally(() => {
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
