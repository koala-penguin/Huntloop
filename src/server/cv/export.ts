import type { Db } from "../db/database";
import { jobEvents } from "../db/schema";
import { getCvDocument } from "../repo/cv-documents";
import { getJob } from "../repo/jobs";
import { htmlToPdf } from "../browser/pdf";
import { UserFacingError } from "../errors";
import { blockingFlags } from "@/shared/schemas/cv";
import { cvTranslator } from "./i18n";
import { renderCvHtml } from "./render";
import { buildCvDocx } from "./render-docx";

export type CvExportFormat = "docx" | "pdf";

const MIME: Record<CvExportFormat, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

const filePart = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/**
 * A tailored CV as a Word or PDF file. Refused while any line still has a blocking flag — nothing
 * unverified leaves Huntloop without the user having dealt with it.
 */
export async function exportCv(db: Db, userId: number, docId: number, format: CvExportFormat): Promise<{ bytes: Buffer; mime: string; fileName: string }> {
  const doc = getCvDocument(db, userId, docId);
  if (!doc || doc.kind !== "cv") throw new UserFacingError("not_found");
  if (blockingFlags(doc.flags).length) throw new UserFacingError("unresolved_flags");
  const t = cvTranslator(doc.content.language);
  const bytes = format === "docx" ? await buildCvDocx(doc.content, t) : await htmlToPdf(renderCvHtml(doc.content, t), doc.content.paper);
  const job = doc.jobId ? getJob(db, userId, doc.jobId) : undefined;
  if (job) db.insert(jobEvents).values({ jobId: job.id, type: "cv_exported", toValue: format, note: `v${doc.version}` }).run();
  const name = [filePart(doc.content.header.name) || "CV", "CV", filePart(job?.companyName)].filter(Boolean).join("-");
  return { bytes, mime: MIME[format], fileName: `${name}.${format}` };
}
