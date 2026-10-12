import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { importJob } from "@/server/jobs/intake";
import { errorResponse, formFiles } from "@/server/http";

export const runtime = "nodejs";

/** Add a job from a link, pasted text, screenshots or a PDF (any combination). */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const { db, user } = appContext();
  try {
    const result = await importJob(db, user.id, {
      url: typeof form.get("url") === "string" ? (form.get("url") as string) : null,
      text: typeof form.get("text") === "string" ? (form.get("text") as string) : null,
      files: await formFiles(form),
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
