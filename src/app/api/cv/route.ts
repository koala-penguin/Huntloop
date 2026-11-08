import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { saveUpload } from "@/server/storage";
import { enqueueTask } from "@/server/tasks/runner";
import { EXTRACT_PROFILE_TASK, type ExtractProfilePayload } from "@/server/tasks/handlers/extract-profile";
import { detectDocumentKind } from "@/server/cv/extract-text";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 200_000;

/** Upload a CV file (PDF/DOCX/TXT) or pasted CV text; starts background extraction. */
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const file = form.get("file");
  const pasted = form.get("text");
  const { db, user } = appContext();

  let payload: ExtractProfilePayload;
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!detectDocumentKind(bytes)) return NextResponse.json({ error: "unsupported_file" }, { status: 415 });
    const filePath = await saveUpload("cv", file.name, bytes);
    payload = { filePath, fileName: file.name, text: null };
  } else if (typeof pasted === "string" && pasted.trim().length > 0) {
    if (pasted.length > MAX_TEXT) return NextResponse.json({ error: "text_too_long" }, { status: 413 });
    if (pasted.trim().length < 100) return NextResponse.json({ error: "cv_too_short" }, { status: 400 });
    payload = { filePath: null, fileName: null, text: pasted };
  } else {
    return NextResponse.json({ error: "missing_input" }, { status: 400 });
  }

  const task = enqueueTask(db, user.id, EXTRACT_PROFILE_TASK, payload);
  return NextResponse.json({ taskId: task.id }, { status: 202 });
}
