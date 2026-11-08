import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { addJobContent } from "@/server/jobs/intake";
import { errorResponse, formFiles } from "@/server/http";

export const runtime = "nodejs";

/** Pasted text or screenshots for a job Huntloop couldn't read by itself. */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/content">) {
  const form = await request.formData();
  const { db, user } = appContext();
  try {
    const taskId = await addJobContent(db, user.id, Number((await ctx.params).id), {
      text: typeof form.get("text") === "string" ? (form.get("text") as string) : null,
      files: await formFiles(form),
    });
    return NextResponse.json({ taskId }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
