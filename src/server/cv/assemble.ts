import { marketPack } from "@/shared/markets";
import type { ProfileData } from "@/shared/schemas/profile";
import {
  CV_LANGUAGES,
  LINKEDIN_LIMITS,
  type CvDocument,
  type CvLanguage,
  type CvLine,
  type LineInput,
  type LineOrigin,
  type LinkedinDocument,
  type LinkedinOutput,
  type TailoredCvOutput,
  type TailoringPlan,
} from "@/shared/schemas/cv";

/**
 * Builds the stored document from the model's sentences and the profile. Everything factual about
 * the candidate — name, contacts, titles, companies, dates, education, work rights — comes from
 * the profile here; the model only chooses wording, order and emphasis.
 */

export function cvLanguageFor(postingLanguage: string | null | undefined): { language: CvLanguage; fallback: boolean } {
  const lang = (postingLanguage ?? "en").toLowerCase().slice(0, 2);
  return (CV_LANGUAGES as readonly string[]).includes(lang) ? { language: lang as CvLanguage, fallback: false } : { language: "en", fallback: true };
}

function toLine(input: LineInput, id: string, origin: LineOrigin): CvLine {
  return {
    id,
    text: input.text.replace(/\s+/g, " ").trim(),
    sourceRefs: input.sourceRefs.map((r) => ({ ...r, verified: false })),
    requirementIds: input.requirementIds,
    origin,
  };
}

/** A CV bullet copied as it is, sourced by itself. */
function profileLine(text: string, id: string): CvLine {
  return { id, text, sourceRefs: [{ source: "cv", quote: text, factId: null, verified: false }], requirementIds: [], origin: "profile" };
}

/** Skill names the candidate actually has, in the model's order, with the profile's spelling. */
function knownSkills(names: string[], data: ProfileData, max: number): { skills: string[]; dropped: number } {
  const known = new Map<string, string>();
  for (const s of [...data.skills.map((x) => x.name), ...data.experience.flatMap((e) => e.skills)]) {
    if (!known.has(s.toLowerCase())) known.set(s.toLowerCase(), s);
  }
  const out: string[] = [];
  let dropped = 0;
  for (const name of names) {
    const match = known.get(name.trim().toLowerCase());
    if (!match) dropped++;
    else if (!out.includes(match)) out.push(match);
  }
  return { skills: out.slice(0, max), dropped };
}

export interface AssembleCvInput {
  profile: { cvText: string; data: ProfileData };
  job: { country: string | null; postingLanguage: string | null };
  plan: TailoringPlan;
  output: TailoredCvOutput;
}

export function assembleCv({ profile, job, plan, output }: AssembleCvInput): { doc: CvDocument; dropped: number; languageFallback: boolean } {
  const { data } = profile;
  const pack = marketPack(job.country);
  const { language, fallback } = cvLanguageFor(job.postingLanguage);
  let dropped = 0;

  const known = new Set(data.experience.map((e) => e.id));
  for (const r of output.roles) if (!known.has(r.experienceId)) dropped++;
  const excluded = new Set(plan.roles.filter((r) => !r.include).map((r) => r.experienceId));
  // Never leave the CV without the current or most recent role.
  if (data.experience[0]) excluded.delete(data.experience[0].id);

  const roles = data.experience
    .filter((e) => !excluded.has(e.id))
    .map((e) => {
      const written = output.roles.find((r) => r.experienceId === e.id)?.bullets.filter((b) => b.text.trim()) ?? [];
      const bullets = written.length ? written.map((b, i) => toLine(b, `${e.id}-b${i}`, "ai")) : e.highlights.map((h, i) => profileLine(h, `${e.id}-b${i}`));
      return { experienceId: e.id, title: e.title, company: e.company, location: e.location, start: e.start, end: e.end, bullets };
    });

  const skills = knownSkills(output.skills, data, 24);
  dropped += skills.dropped;

  const right = job.country ? data.workRights.find((w) => w.country === job.country) : undefined;
  const workRight =
    pack.cv.workRightsLine && right && ["citizen", "permanent_resident", "unrestricted_visa"].includes(right.status) ? { status: right.status, country: right.country } : null;

  const latest = data.experience[0];
  const doc: CvDocument = {
    language,
    locale: language === "ko" ? "ko-KR" : pack.cv.spelling,
    market: pack.country,
    paper: pack.cv.paper,
    pages: pack.cv.pages,
    header: {
      name: data.basics.name,
      headline: data.basics.headline ?? latest?.title ?? null,
      email: data.basics.email,
      phone: data.basics.phone,
      city: data.basics.city,
      country: data.basics.country,
      links: data.basics.links,
    },
    summary: output.summary.filter((l) => l.text.trim()).map((l, i) => toLine(l, `summary-${i}`, "ai")),
    skills: skills.skills.length ? skills.skills : data.skills.map((s) => s.name).slice(0, 24),
    roles,
    education: data.education.map(({ institution, degree, field, start, end }) => ({ institution, degree, field, start, end })),
    certifications: data.certifications,
    languages: data.languages,
    clearances: data.clearances.filter((c) => !job.country || c.country === job.country).map(({ level, status }) => ({ level, status })),
    workRight,
    referees: pack.cv.referees,
  };
  return { doc, dropped, languageFallback: fallback };
}

export function assembleLinkedin(profile: { data: ProfileData }, output: LinkedinOutput, language: CvLanguage): { doc: LinkedinDocument; dropped: number } {
  const { data } = profile;
  const known = new Set(data.experience.map((e) => e.id));
  let dropped = output.positions.filter((p) => !known.has(p.experienceId)).length;
  const skills = knownSkills(output.topSkills, data, LINKEDIN_LIMITS.topSkills);
  dropped += skills.dropped;
  return {
    doc: {
      language,
      headline: toLine(output.headline, "headline", "ai"),
      about: output.about.filter((l) => l.text.trim()).map((l, i) => toLine(l, `about-${i}`, "ai")),
      positions: data.experience.map((e) => {
        const written = output.positions.find((p) => p.experienceId === e.id)?.bullets.filter((b) => b.text.trim()) ?? [];
        return {
          experienceId: e.id,
          title: e.title,
          company: e.company,
          bullets: written.length ? written.map((b, i) => toLine(b, `${e.id}-b${i}`, "ai")) : e.highlights.map((h, i) => profileLine(h, `${e.id}-b${i}`)),
        };
      }),
      topSkills: skills.skills,
    },
    dropped,
  };
}

/** The CV's words without headings — for the ATS keyword match and the page estimate. */
export function cvContentText(doc: CvDocument): string {
  const h = doc.header;
  return [
    h.name,
    h.headline,
    ...doc.summary.map((l) => l.text),
    doc.skills.join(", "),
    ...doc.roles.flatMap((r) => [`${r.title} ${r.company} ${r.location ?? ""} ${r.start ?? ""} ${r.end ?? ""}`, ...r.bullets.map((b) => b.text)]),
    ...doc.education.map((e) => [e.degree, e.field, e.institution, e.end].filter(Boolean).join(" ")),
    ...doc.certifications.map((c) => [c.name, c.issuer, c.year].filter(Boolean).join(" ")),
    ...doc.languages.map((l) => `${l.language} ${l.level}`),
    ...doc.clearances.map((c) => c.level),
  ]
    .filter(Boolean)
    .join("\n");
}
