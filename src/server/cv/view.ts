import type { Db } from "../db/database";
import type { JobRow } from "../db/schema";
import type { JobFit } from "../jobs/fit";
import { getCvDocument, latestCvDocument, listCvVersions, type StoredCv, type StoredLinkedin } from "../repo/cv-documents";
import { getCurrentProfile } from "../repo/profile";
import { activeTaskForJob } from "../jobs/intake";
import { TAILOR_CV_TASK } from "../tasks/handlers/tailor-cv";
import { blockingCount, blockingFlags, type CvFlag, type CvLine } from "@/shared/schemas/cv";
import type { CvDocView } from "@/components/cv/cv-workspace";
import type { FlaggedLine } from "@/components/cv/flag-card";
import { buildProvenanceContext, linkedinSectionText } from "./provenance";
import { cvTranslator } from "./i18n";
import { renderCvHtml } from "./render";
import { isCvStale } from "./tailor";

/** What the CV tab and the LinkedIn tab show, prepared on the server. */

function flagged(lines: Array<{ line: CvLine; where: string; removable: boolean }>, flags: CvFlag[]): FlaggedLine[] {
  const byLine = new Map<string, CvFlag[]>();
  for (const f of flags) if (f.lineId) byLine.set(f.lineId, [...(byLine.get(f.lineId) ?? []), f]);
  return lines
    .filter(({ line }) => byLine.has(line.id))
    .map(({ line, where, removable }) => ({
      id: line.id,
      text: line.text,
      origin: line.origin,
      where,
      sources: line.sourceRefs.map(({ source, quote, verified }) => ({ source, quote, verified })),
      flags: byLine.get(line.id)!,
      removable,
    }))
    .sort((a, b) => Number(b.flags.some((f) => f.severity === "block")) - Number(a.flags.some((f) => f.severity === "block")));
}

export function cvWorkspaceData(db: Db, userId: number, job: JobRow, fit: JobFit | null, options: { selectedId?: number; summaryLabel: string }) {
  const latest = latestCvDocument(db, userId, "cv", job.id);
  const selected = options.selectedId ? getCvDocument(db, userId, options.selectedId) : null;
  const doc: StoredCv | null = selected?.kind === "cv" && selected.jobId === job.id ? selected : latest;
  const profile = getCurrentProfile(db, userId);
  const base = {
    runningTaskId: activeTaskForJob(db, userId, TAILOR_CV_TASK, job.id),
    versions: listCvVersions(db, userId, "cv", job.id).map(({ id, version }) => ({ id, version })),
    canTailor: !!profile && !!fit?.assessment,
  };
  if (!doc) return { ...base, doc: null, previewHtml: null, doNotClaim: [] as string[] };

  const lines = [
    ...doc.content.summary.map((line) => ({ line, where: options.summaryLabel, removable: true })),
    ...doc.content.roles.flatMap((r) => r.bullets.map((line) => ({ line, where: `${r.title} — ${r.company}`, removable: true }))),
  ];
  const highlight = new Set(doc.flags.filter((f) => f.lineId).map((f) => f.lineId!));
  const reqs = new Map((fit?.analysis.requirements ?? []).map((r) => [r.id, r.normalized]));
  const allLines = lines.map((l) => l.line);
  const view: CvDocView = {
    id: doc.id,
    version: doc.version,
    createdAt: doc.createdAt.toISOString(),
    stale: isCvStale(doc, profile, job),
    pages: doc.content.pages,
    plan: doc.plan,
    checks: doc.checks,
    blocking: blockingCount(doc.flags),
    lengthWarning: doc.flags.some((f) => f.kind === "length"),
    flagged: flagged(lines, doc.flags),
    answered: doc.edits.flatMap((e) => (e.kind === "answer" ? [e.questionIndex] : [])),
    coverage: (doc.plan?.targetRequirementIds ?? [])
      .filter((id) => reqs.has(id))
      .map((id) => ({ term: reqs.get(id)!, lines: allLines.filter((l) => l.requirementIds.includes(id)).length })),
  };
  const doNotClaim = profile && fit ? buildProvenanceContext(profile, { analysis: fit.analysis, score: fit.score, plan: doc.plan }).doNotClaim : [];
  return { ...base, doc: view, previewHtml: renderCvHtml(doc.content, cvTranslator(doc.content.language), { highlight }), doNotClaim };
}

export interface LinkedinSectionView {
  key: string;
  label: string;
  text: string;
  limit: number | null;
  blocked: boolean;
}

export function linkedinPanelData(db: Db, userId: number, labels: { headline: string; about: string; skills: string }) {
  const doc: StoredLinkedin | null = latestCvDocument(db, userId, "linkedin", null);
  const profile = getCurrentProfile(db, userId);
  if (!doc) return { doc: null, sections: [] as LinkedinSectionView[], flagged: [] as FlaggedLine[], stale: false, blocking: 0 };
  const c = doc.content;
  const blockedLines = new Set(blockingFlags(doc.flags).map((f) => f.lineId));
  const blockedSection = (ids: string[], section: string, experienceId = "") =>
    ids.some((id) => blockedLines.has(id)) || doc.flags.some((f) => f.kind === "over_limit" && f.params.section === section && (f.params.experienceId ?? "") === experienceId);
  const sections: LinkedinSectionView[] = [
    { key: "headline", label: labels.headline, text: linkedinSectionText(c, "headline"), limit: 220, blocked: blockedSection([c.headline.id], "headline") },
    { key: "about", label: labels.about, text: linkedinSectionText(c, "about"), limit: 2600, blocked: blockedSection(c.about.map((l) => l.id), "about") },
    ...c.positions
      .filter((p) => p.bullets.length)
      .map((p) => ({
        key: p.experienceId,
        label: `${p.title} — ${p.company}`,
        text: linkedinSectionText(c, { experienceId: p.experienceId }),
        limit: 2000,
        blocked: blockedSection(
          p.bullets.map((b) => b.id),
          "position",
          p.experienceId,
        ),
      })),
    { key: "skills", label: labels.skills, text: c.topSkills.join(", "), limit: null, blocked: false },
  ];
  const lines = [
    { line: c.headline, where: labels.headline, removable: false },
    ...c.about.map((line) => ({ line, where: labels.about, removable: true })),
    ...c.positions.flatMap((p) => p.bullets.map((line) => ({ line, where: `${p.title} — ${p.company}`, removable: true }))),
  ];
  return {
    doc: { id: doc.id, version: doc.version, language: doc.language },
    sections,
    flagged: flagged(lines, doc.flags),
    stale: isCvStale(doc, profile),
    blocking: blockingCount(doc.flags),
  };
}
