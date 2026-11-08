import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { bulkDeleteJobs, isJsonContentType } from "@/server/jobs/bulk-delete";
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

/** Delete several jobs at once: { ids: number[], includeInProgress?: boolean } → { deleted, skipped }. */
export async function DELETE(request: NextRequest) {
  // JSON only: a DELETE with a JSON body always needs a CORS preflight, which this app never grants, so another
  // site cannot trigger it. Keep that true even if the method ever changes to POST.
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const { db, user } = appContext();
  try {
    const result = bulkDeleteJobs(db, user.id, body);
    if (result.status === 200 && result.body.deleted.length) revalidatePath("/", "layout");
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    return errorResponse(error);
  }
}
