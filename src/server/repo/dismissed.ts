import { and, eq } from "drizzle-orm";
import type { Db } from "../db/database";
import { dismissedJobs, type JobRow } from "../db/schema";

/**
 * Jobs the user deleted (see `dismissedJobs` in the schema). Matched by the listing's canonical
 * link only, the same link `findJobByUrl` recognises a known job by. Not by apply link (it can be
 * a generic careers page) and not by company + title + place (a repost must show again).
 */

/** Remembers these jobs as deleted; call inside the delete's transaction. Jobs without a link aren't kept. */
export function rememberDeleted(tx: Pick<Db, "insert">, userId: number, rows: Array<Pick<JobRow, "sourceUrl" | "companyName" | "title">>): void {
  const values = rows.flatMap((r) => (r.sourceUrl ? [{ userId, sourceUrl: r.sourceUrl, title: r.title, companyName: r.companyName }] : []));
  if (values.length) tx.insert(dismissedJobs).values(values).run();
}

/** True when the user deleted a job with this canonical listing link. */
export function isDismissed(db: Pick<Db, "select">, userId: number, url: string | null): boolean {
  if (!url) return false;
  return !!db
    .select({ id: dismissedJobs.id })
    .from(dismissedJobs)
    .where(and(eq(dismissedJobs.userId, userId), eq(dismissedJobs.sourceUrl, url)))
    .get();
}

/** The user added this link again by hand: forget that they deleted it. */
export function forgetDeleted(db: Pick<Db, "delete">, userId: number, url: string): void {
  db.delete(dismissedJobs)
    .where(and(eq(dismissedJobs.userId, userId), eq(dismissedJobs.sourceUrl, url)))
    .run();
}
