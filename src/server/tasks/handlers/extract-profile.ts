import { z } from "zod";
import { detectDocumentKind, extractDocumentText, type DocumentKind } from "../../cv/extract-text";
import { extractProfile, mergeWithPrevious } from "../../ai/tasks/extract-profile";
import { getCurrentProfile, saveProfileVersion } from "../../repo/profile";
import { readUpload } from "../../storage";
import { UserFacingError } from "../../errors";
import { registerTaskHandler, type TaskContext } from "../runner";

export const EXTRACT_PROFILE_TASK = "extract-profile";

const payloadSchema = z.object({
  filePath: z.string().nullable(),
  fileName: z.string().nullable(),
  text: z.string().nullable(),
});
export type ExtractProfilePayload = z.infer<typeof payloadSchema>;

export async function runExtractProfile(ctx: TaskContext): Promise<{ version: number }> {
  const payload = payloadSchema.parse(ctx.payload);
  ctx.progress({ stage: "reading" });

  let kind: DocumentKind = "text";
  let bytes: Uint8Array | undefined;
  let text = payload.text ?? "";
  if (payload.filePath) {
    bytes = await readUpload(payload.filePath);
    const detected = detectDocumentKind(bytes);
    if (!detected) throw new UserFacingError("unsupported_file");
    kind = detected;
    text = await extractDocumentText(kind, bytes);
  }
  if (kind !== "pdf" && text.trim().length < 100) throw new UserFacingError("cv_too_short");

  ctx.progress({ stage: "analyzing" });
  const extracted = await extractProfile({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, { kind, bytes, text });
  const previous = getCurrentProfile(ctx.db, ctx.userId);
  const saved = saveProfileVersion(ctx.db, ctx.userId, {
    cvText: extracted.cvText,
    data: mergeWithPrevious(extracted.data, previous?.data ?? null),
    cvFileName: payload.fileName,
    cvFilePath: payload.filePath,
  });
  ctx.progress({ stage: "done" });
  return { version: saved.version };
}

registerTaskHandler(EXTRACT_PROFILE_TASK, { run: runExtractProfile, maxAttempts: 2 });
