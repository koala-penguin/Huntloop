import type { Db } from "../db/database";
import { getCvDocument, cvProfileHash, updateCvDocument, type StoredCvDocument } from "../repo/cv-documents";
import { getCurrentProfile, saveProfileVersion } from "../repo/profile";
import { rescoreAllJobs } from "../jobs/fit";
import { UserFacingError } from "../errors";
import type { CvDocument, CvEdit, CvLine, LinkedinDocument } from "@/shared/schemas/cv";
import { recheckDocument } from "./tailor";

/**
 * The user's answers to flagged lines and to the plan's questions. Only these clicks change the
 * document's claims or the profile; each one re-runs the checks.
 */

export type LineAction = { kind: "remove" } | { kind: "edit"; text: string } | { kind: "confirm_fact" };

const MAX_LINE = 600;

function allLines(doc: StoredCvDocument): CvLine[] {
  if (doc.kind === "cv") return [...doc.content.summary, ...doc.content.roles.flatMap((r) => r.bullets)];
  return [doc.content.headline, ...doc.content.about, ...doc.content.positions.flatMap((p) => p.bullets)];
}

function removeLine(doc: StoredCvDocument, lineId: string): void {
  if (doc.kind === "cv") {
    const c: CvDocument = doc.content;
    c.summary = c.summary.filter((l) => l.id !== lineId);
    for (const r of c.roles) r.bullets = r.bullets.filter((l) => l.id !== lineId);
  } else {
    const c: LinkedinDocument = doc.content;
    if (c.headline.id === lineId) throw new UserFacingError("invalid");
    c.about = c.about.filter((l) => l.id !== lineId);
    for (const p of c.positions) p.bullets = p.bullets.filter((l) => l.id !== lineId);
  }
}

/** Saves a statement the user confirmed as a profile fact; returns its id and the new profile stamp. */
function addFact(db: Db, userId: number, text: string): { factId: string; version: number; hash: string } {
  const profile = getCurrentProfile(db, userId);
  if (!profile) throw new UserFacingError("no_profile");
  const factId = `fact-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const data = { ...profile.data, facts: [...profile.data.facts, { id: factId, text, source: "user" as const }] };
  const saved = saveProfileVersion(db, userId, { cvText: profile.cvText, data });
  // Interview Chance is re-tiered in code; assessments only change when the user reassesses.
  rescoreAllJobs(db, userId);
  return { factId, version: saved.version, hash: cvProfileHash(saved.cvText, saved.data) };
}

export function resolveCvLine(db: Db, userId: number, docId: number, lineId: string, action: LineAction): StoredCvDocument {
  const doc = getCvDocument(db, userId, docId);
  if (!doc) throw new UserFacingError("not_found");
  const line = allLines(doc).find((l) => l.id === lineId);
  if (!line) throw new UserFacingError("not_found");
  const at = new Date().toISOString();
  let edit: CvEdit;
  let profileUpdate: { version: number; hash: string } | undefined;

  if (action.kind === "remove") {
    removeLine(doc, lineId);
    edit = { at, kind: "remove", lineId, text: line.text };
  } else if (action.kind === "edit") {
    const text = action.text.replace(/\s+/g, " ").trim();
    if (!text || text.length > MAX_LINE) throw new UserFacingError("invalid");
    edit = { at, kind: "edit", lineId, text, previous: line.text };
    Object.assign(line, { text, origin: "user" });
  } else {
    // "This is true": the line itself becomes a confirmed fact and its source.
    const fact = addFact(db, userId, line.text);
    line.sourceRefs = [{ source: "fact", quote: line.text, factId: fact.factId, verified: false }];
    edit = { at, kind: "confirm_fact", lineId, factId: fact.factId };
    profileUpdate = { version: fact.version, hash: fact.hash };
  }
  // The line objects belong to doc.content, so the re-check stores the changed content too.
  const edits = [...doc.edits, edit];
  updateCvDocument(db, doc.id, { edits });
  return recheckDocument(db, userId, { ...doc, edits }, profileUpdate);
}

/** An answer to one of the plan's questions, in the user's words, saved as a fact for the next draft. */
export function answerCvQuestion(db: Db, userId: number, docId: number, questionIndex: number, answer: string): StoredCvDocument {
  const doc = getCvDocument(db, userId, docId);
  if (!doc || doc.kind !== "cv" || !doc.plan?.questions[questionIndex]) throw new UserFacingError("not_found");
  const text = answer.replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > 1000) throw new UserFacingError("invalid");
  const fact = addFact(db, userId, text);
  const edits: CvEdit[] = [...doc.edits, { at: new Date().toISOString(), kind: "answer", questionIndex, factId: fact.factId }];
  return updateCvDocument(db, doc.id, { edits });
}
