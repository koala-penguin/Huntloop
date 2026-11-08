import type { Db } from "../db/database";
import { deleteJobs, type DeleteJobsResult } from "../repo/jobs";
import { bulkDeleteBodySchema } from "@/shared/schemas/job";

/**
 * True only when the media type itself is application/json (parameters such as charset allowed).
 * A substring test would let `text/plain; x=application/json` through, and text/plain is a type
 * a cross-site form or fetch may send without a CORS preflight. Shared with the request proxy.
 */
export { isJsonContentType } from "@/shared/request-guard";

export type BulkDeleteResponse = { status: 200; body: DeleteJobsResult } | { status: 400; body: { error: "invalid" } };

/** Validates a DELETE /api/jobs body and deletes; duplicates in `ids` collapse. */
export function bulkDeleteJobs(db: Db, userId: number, body: unknown): BulkDeleteResponse {
  const parsed = bulkDeleteBodySchema.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: "invalid" } };
  const ids = [...new Set(parsed.data.ids)];
  return { status: 200, body: deleteJobs(db, userId, ids, { includeInProgress: parsed.data.includeInProgress }) };
}
