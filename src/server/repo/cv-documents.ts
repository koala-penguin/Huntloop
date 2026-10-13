import { and, desc, eq, isNull, max } from "drizzle-orm";
import type { Db } from "../db/database";
import { cvDocuments } from "../db/schema";
import { hashJson } from "../hash";
import type { CvChecks, CvDocument, CvEdit, CvFlag, LinkedinDocument, TailoringPlan } from "@/shared/schemas/cv";
import type { ProfileData } from "@/shared/schemas/profile";

export type CvDocumentKind = "cv" | "linkedin";

interface StoredBase {
  id: number;
  jobId: number | null;
  version: number;
  profileVersion: number;
  profileHash: string;
  analysisId: number | null;
  language: string;
  market: string | null;
  model: string;
  flags: CvFlag[];
  edits: CvEdit[];
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredCv extends StoredBase {
  kind: "cv";
  plan: TailoringPlan | null;
  content: CvDocument;
  checks: CvChecks | null;
}

export interface StoredLinkedin extends StoredBase {
  kind: "linkedin";
  content: LinkedinDocument;
}

export type StoredCvDocument = StoredCv | StoredLinkedin;

/** Everything a tailored CV or LinkedIn draft is written from: CV text, roles and highlights, facts, contacts. */
export function cvProfileHash(cvText: string, data: ProfileData): string {
  return hashJson({ cvText, data });
}

function toStored(row: typeof cvDocuments.$inferSelect): StoredCvDocument {
  const base: StoredBase = {
    id: row.id,
    jobId: row.jobId,
    version: row.version,
    profileVersion: row.profileVersion,
    profileHash: row.profileHash,
    analysisId: row.analysisId,
    language: row.language,
    market: row.market,
    model: row.model,
    flags: (row.flags ?? []) as CvFlag[],
    edits: (row.edits ?? []) as CvEdit[],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return row.kind === "linkedin"
    ? { ...base, kind: "linkedin", content: row.content as LinkedinDocument }
    : { ...base, kind: "cv", plan: (row.plan ?? null) as TailoringPlan | null, content: row.content as CvDocument, checks: (row.checks ?? null) as CvChecks | null };
}

const owner = (userId: number, kind: CvDocumentKind, jobId: number | null) =>
  and(eq(cvDocuments.userId, userId), eq(cvDocuments.kind, kind), jobId === null ? isNull(cvDocuments.jobId) : eq(cvDocuments.jobId, jobId));

export function getCvDocument(db: Db, userId: number, id: number): StoredCvDocument | null {
  const row = db
    .select()
    .from(cvDocuments)
    .where(and(eq(cvDocuments.userId, userId), eq(cvDocuments.id, id)))
    .get();
  return row ? toStored(row) : null;
}

export function latestCvDocument(db: Db, userId: number, kind: "cv", jobId: number): StoredCv | null;
export function latestCvDocument(db: Db, userId: number, kind: "linkedin", jobId: null): StoredLinkedin | null;
export function latestCvDocument(db: Db, userId: number, kind: CvDocumentKind, jobId: number | null): StoredCvDocument | null {
  const row = db.select().from(cvDocuments).where(owner(userId, kind, jobId)).orderBy(desc(cvDocuments.version)).limit(1).get();
  return row ? toStored(row) : null;
}

/** Versions, newest first (id, version, date) — for the version picker. */
export function listCvVersions(db: Db, userId: number, kind: CvDocumentKind, jobId: number | null): Array<{ id: number; version: number; createdAt: Date }> {
  return db
    .select({ id: cvDocuments.id, version: cvDocuments.version, createdAt: cvDocuments.createdAt })
    .from(cvDocuments)
    .where(owner(userId, kind, jobId))
    .orderBy(desc(cvDocuments.version))
    .all();
}

export type NewCvDocument = Omit<typeof cvDocuments.$inferInsert, "id" | "userId" | "version" | "createdAt" | "updatedAt">;

export function insertCvDocument(db: Db, userId: number, values: NewCvDocument): StoredCvDocument {
  const kind = values.kind as CvDocumentKind;
  const jobId = values.jobId ?? null;
  const current = db.select({ v: max(cvDocuments.version) }).from(cvDocuments).where(owner(userId, kind, jobId)).get();
  const row = db
    .insert(cvDocuments)
    .values({ ...values, jobId, userId, version: (current?.v ?? 0) + 1 })
    .returning()
    .get();
  return toStored(row);
}

export function updateCvDocument(
  db: Db,
  id: number,
  patch: Partial<Pick<typeof cvDocuments.$inferInsert, "content" | "flags" | "checks" | "edits" | "profileVersion" | "profileHash">>,
): StoredCvDocument {
  return toStored(db.update(cvDocuments).set({ ...patch, updatedAt: new Date() }).where(eq(cvDocuments.id, id)).returning().get());
}
