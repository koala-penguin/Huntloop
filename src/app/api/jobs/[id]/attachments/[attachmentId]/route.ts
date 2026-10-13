import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { getAttachment } from "@/server/repo/jobs";
import { readUpload } from "@/server/storage";

export const runtime = "nodejs";

/** A stored screenshot or PDF of a posting. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/attachments/[attachmentId]">) {
  const { id, attachmentId } = await ctx.params;
  const { db, user } = appContext();
  const attachment = getAttachment(db, user.id, Number(id), Number(attachmentId));
  if (!attachment) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const bytes = await readUpload(attachment.path);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "content-type": attachment.mime,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName ?? "attachment")}`,
    },
  });
}
