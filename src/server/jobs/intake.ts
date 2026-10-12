import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/database";
import { tasks, type JobRow } from "../db/schema";
import { UserFacingError } from "../errors";
import { canonicalizeUrl } from "../ingest/domain-policy";
import { saveUpload } from "../storage";
import { enqueueTask } from "../tasks/runner";
import { PROCESS_JOB_TASK, type ProcessJobPayload } from "../tasks/handlers/process-job";
import { addAttachments, createJob, findJobByUrl, getJob, updateJob } from "../repo/jobs";

export const MAX_FILES = 12;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT = 300_000;

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
}

type FileKind = { kind: "image" | "pdf"; mime: string };

/** Identifies screenshots and PDFs by their bytes, not by the name or browser-supplied type. */
export function detectPostingFile(bytes: Uint8Array): FileKind | null {
  const b = bytes;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: "image", mime: "image/png" };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg" };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { kind: "image", mime: "image/gif" };
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return { kind: "image", mime: "image/webp" };
  if (String.fromCharCode(...b.slice(0, 5)) === "%PDF-") return { kind: "pdf", mime: "application/pdf" };
  return null;
}

async function storeFiles(db: Db, jobId: number, files: UploadedFile[]): Promise<void> {
  const stored = [];
  for (const file of files) {
    const type = detectPostingFile(file.bytes)!;
    stored.push({ kind: type.kind, mime: type.mime, path: await saveUpload("postings", file.name, file.bytes), fileName: file.name });
  }
  addAttachments(db, jobId, stored);
}

function validate(text: string, files: UploadedFile[]): void {
  if (text.length > MAX_TEXT) throw new UserFacingError("text_too_long");
  if (files.length > MAX_FILES) throw new UserFacingError("too_many_files");
  for (const file of files) {
    if (file.bytes.byteLength > MAX_FILE_BYTES) throw new UserFacingError("file_too_large");
    if (!detectPostingFile(file.bytes)) throw new UserFacingError("unsupported_posting_file");
  }
}

function enqueue(db: Db, userId: number, payload: ProcessJobPayload): number {
  return enqueueTask(db, userId, PROCESS_JOB_TASK, payload).id;
}

/** True when the whole input is a single link. */
export function looksLikeUrl(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

export interface ImportInput {
  url?: string | null;
  text?: string | null;
  files?: UploadedFile[];
}

/**
 * "Add a job": any combination of a link, pasted text and screenshots/PDF. Returns the job and the
 * background task that reads, analyses and scores it, or the existing job when the link is known.
 */
export async function importJob(db: Db, userId: number, input: ImportInput): Promise<{ jobId: number; taskId: number | null; duplicate: boolean }> {
  let text = input.text?.trim() ?? "";
  let rawUrl = input.url?.trim() ?? "";
  if (!rawUrl && looksLikeUrl(text)) {
    rawUrl = text;
    text = "";
  }
  const files = input.files ?? [];
  if (!rawUrl && !text && !files.length) throw new UserFacingError("missing_posting");
  validate(text, files);
  if (text && !files.length && text.length < 200) throw new UserFacingError("posting_too_short");

  const url = rawUrl ? canonicalizeUrl(rawUrl) : null;
  if (rawUrl && !url) throw new UserFacingError("invalid_url");
  if (url && !text && !files.length) {
    const existing = findJobByUrl(db, userId, url);
    if (existing) return { jobId: existing.id, taskId: null, duplicate: true };
  }

  const source = files.length ? (files.every((f) => detectPostingFile(f.bytes)?.kind === "pdf") ? "pdf" : "screenshot") : text ? "paste" : "url";
  const job = createJob(db, userId, {
    source,
    sourceUrl: url,
    applyUrl: url,
    rawText: text || null,
    intakeStatus: "processing",
    intake: { noisy: true },
  });
  await storeFiles(db, job.id, files);
  return { jobId: job.id, taskId: enqueue(db, userId, { jobId: job.id, transcribe: files.length > 0 }), duplicate: false };
}

/** More content for a job Huntloop couldn't read (SEEK/LinkedIn links, blocked pages) or a failed intake. */
export async function addJobContent(db: Db, userId: number, jobId: number, input: { text?: string | null; files?: UploadedFile[] }): Promise<number> {
  const job = getJob(db, userId, jobId);
  if (!job) throw new UserFacingError("not_found");
  const text = input.text?.trim() ?? "";
  const files = input.files ?? [];
  if (!text && !files.length) throw new UserFacingError("missing_posting");
  validate(text, files);
  if (text && !files.length && text.length < 200) throw new UserFacingError("posting_too_short");
  await storeFiles(db, job.id, files);
  updateJob(db, job.id, { rawText: text || null, intakeStatus: "processing", intakeError: null, intake: { ...(job.intake ?? {}), noisy: true, partial: false, reason: undefined } });
  return enqueue(db, userId, { jobId: job.id, transcribe: files.length > 0 });
}

/** The user corrected the transcription (or posting text): re-run analysis on their text. */
export function saveJobText(db: Db, userId: number, jobId: number, text: string): number {
  const job = getJob(db, userId, jobId);
  if (!job) throw new UserFacingError("not_found");
  const trimmed = text.trim();
  if (trimmed.length < 200) throw new UserFacingError("posting_too_short");
  if (trimmed.length > MAX_TEXT) throw new UserFacingError("text_too_long");
  updateJob(db, job.id, { rawText: trimmed, intakeStatus: "processing", intakeError: null, intake: { ...(job.intake ?? {}), noisy: false, partial: false } });
  return enqueue(db, userId, { jobId: job.id });
}

export function reassessJob(db: Db, userId: number, jobId: number): number {
  const job = getJob(db, userId, jobId);
  if (!job?.analysisId) throw new UserFacingError("not_found");
  return enqueue(db, userId, { jobId: job.id, assessOnly: true });
}

/** The newest background task for a job, so a reopened page can keep showing its progress. */
export function activeJobTask(db: Db, userId: number, job: JobRow): number | null {
  const row = db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.kind, PROCESS_JOB_TASK), sql`json_extract(${tasks.payload}, '$.jobId') = ${job.id}`))
    .orderBy(desc(tasks.id))
    .get();
  return row && ["queued", "running"].includes(row.status) ? row.id : null;
}

/** Replace a search snippet with the full posting from the job's link (falls back to asking the user). */
export function readFullPosting(db: Db, userId: number, jobId: number): number {
  const job = getJob(db, userId, jobId);
  if (!job?.sourceUrl) throw new UserFacingError("not_found");
  updateJob(db, job.id, { intakeStatus: "processing", intakeError: null });
  return enqueue(db, userId, { jobId: job.id, preferUrl: true });
}
