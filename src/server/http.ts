import { NextResponse } from "next/server";
import { errorCodeOf } from "./errors";
import type { UploadedFile } from "./jobs/intake";

export async function formFiles(form: FormData, field = "files"): Promise<UploadedFile[]> {
  const files = form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
  return Promise.all(files.map(async (f) => ({ name: f.name || "upload", bytes: new Uint8Array(await f.arrayBuffer()) })));
}

const STATUS: Record<string, number> = { not_found: 404, file_too_large: 413, text_too_long: 413, too_many_files: 413, unsupported_posting_file: 415 };

/** UserFacingError → `{ error: code }` with a fitting status; anything else is rethrown. */
export function errorResponse(error: unknown): NextResponse {
  const code = errorCodeOf(error);
  if (!code || error instanceof Error === false) throw error;
  return NextResponse.json({ error: code }, { status: STATUS[code] ?? 400 });
}
