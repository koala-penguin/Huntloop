import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import {
  CLEARANCE_STATUSES,
  LANGUAGE_LEVELS,
  SENIORITY_LEVELS,
  SKILL_CATEGORIES,
  WORK_RIGHT_STATUSES,
  type ProfileData,
  type WorkRight,
} from "@/shared/schemas/profile";
import { marketPack } from "@/shared/markets";
import { callStructured, type AiContext } from "../client";
import type { DocumentKind } from "../../cv/extract-text";

export const EXTRACT_PROFILE_PROMPT_VERSION = 1;

/** What Claude returns. Ids, option matching and merging happen in code. */
export const profileExtractionSchema = z.object({
  basics: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    headline: z.string().nullable(),
    summary: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable(),
    links: z.array(z.string()),
  }),
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      industry: z.string().nullable(),
      location: z.string().nullable(),
      country: z.string().nullable(),
      start: z.string().nullable(),
      end: z.string().nullable(),
      seniority: z.enum(SENIORITY_LEVELS).nullable(),
      skills: z.array(z.string()),
      highlights: z.array(z.string()),
    }),
  ),
  skills: z.array(z.object({ name: z.string(), category: z.enum(SKILL_CATEGORIES) })),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      country: z.string().nullable(),
      start: z.string().nullable(),
      end: z.string().nullable(),
    }),
  ),
  certifications: z.array(z.object({ name: z.string(), issuer: z.string().nullable(), year: z.string().nullable() })),
  languages: z.array(z.object({ language: z.string(), level: z.enum(LANGUAGE_LEVELS) })),
  clearances: z.array(z.object({ country: z.string(), level: z.string(), status: z.enum(CLEARANCE_STATUSES) })),
  workRights: z.array(
    z.object({ country: z.string(), status: z.enum(WORK_RIGHT_STATUSES), visa: z.string().nullable(), evidence: z.string() }),
  ),
  /** Verbatim transcription; only requested for PDFs (layouts can scramble machine-extracted text). */
  transcription: z.string().nullable(),
});
export type ProfileExtraction = z.infer<typeof profileExtractionSchema>;

const SYSTEM = `You turn a candidate's CV into a structured profile for Huntloop, a job-search assistant that later checks job requirements against this profile with quotes from the CV.

Rules:
- Use only what the CV says. Never invent or infer employers, titles, dates, degrees, certifications, numbers or skills.
- Dates: "YYYY-MM", or "YYYY" when only the year is given. "end" is null only for a current role ("Present", "현재", "Now").
- experience: one entry per role, most recent first. "highlights" are that role's bullet points copied verbatim (keep numbers and wording). "skills" are the technologies, tools, methods and domains the CV ties to that role.
- skills: every concrete skill named anywhere in the CV, once each, with a category.
- seniority: from the job title only (e.g. "Senior Engineer" → senior); null when the title doesn't say.
- Countries: ISO 3166-1 alpha-2 codes (AU, NZ, SG, US, KR, …).
- workRights: only when the CV states them (citizenship, permanent residency, "full working rights", a visa subclass). Copy the CV's words into "evidence". Otherwise return an empty list.
- languages: spoken languages with a level; "native" for the candidate's first language when stated or obvious from the CV.
- Keep text in the CV's original language. Do not translate.`;

const TRANSCRIBE = `Also set "transcription" to the complete CV text, verbatim, in reading order (for multi-column layouts read each column top to bottom), as plain text with line breaks. Do not summarize, correct or reorder anything.`;
const NO_TRANSCRIBE = `Set "transcription" to null.`;

export interface CvSource {
  kind: DocumentKind;
  bytes?: Uint8Array;
  /** Machine-extracted (or pasted) text. */
  text: string;
}

export function buildExtractionMessages(source: CvSource): Anthropic.Beta.Messages.BetaMessageParam[] {
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
  const pdf = source.kind === "pdf" && source.bytes;
  if (pdf) {
    content.push({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: Buffer.from(source.bytes!).toString("base64") },
      title: "CV",
    });
  }
  content.push({
    type: "text",
    text: [
      pdf ? "The CV is attached as a PDF. Machine-extracted text is below for reference; trust the PDF where they differ." : "The CV text is below.",
      pdf ? TRANSCRIBE : NO_TRANSCRIBE,
      "",
      "<cv_text>",
      source.text,
      "</cv_text>",
    ].join("\n"),
  });
  return [{ role: "user", content }];
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const m = /(\d{4})(?:[-/.](\d{1,2}))?/.exec(value);
  if (!m) return null;
  return m[2] ? `${m[1]}-${m[2].padStart(2, "0")}` : m[1];
}

function normalizeCountry(value: string | null): string | null {
  const v = value?.trim().toUpperCase();
  return v && /^[A-Z]{2}$/.test(v) ? v : null;
}

/** Picks the market-pack option that best matches an extracted work right. */
export function matchWorkRightOption(country: string, status: WorkRight["status"], visa: string | null): string | null {
  const options = marketPack(country).workRightOptions;
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (visa) {
    const wanted = norm(visa);
    const byVisa = options.find((o) => o.visa?.split("/").some((part) => norm(part) !== "" && wanted.includes(norm(part))));
    if (byVisa) return byVisa.id;
  }
  return options.find((o) => o.status === status)?.id ?? null;
}

/** Converts Claude's extraction into stored profile data (ids, normalized dates and countries). */
export function toProfileData(extraction: ProfileExtraction): ProfileData {
  return {
    basics: { ...extraction.basics, country: normalizeCountry(extraction.basics.country) },
    experience: extraction.experience.map((e, i) => ({
      ...e,
      id: `exp-${i + 1}`,
      country: normalizeCountry(e.country),
      start: normalizeDate(e.start),
      end: normalizeDate(e.end),
    })),
    skills: dedupeBy(extraction.skills, (s) => s.name.toLowerCase()),
    education: extraction.education.map((e, i) => ({ ...e, id: `edu-${i + 1}`, country: normalizeCountry(e.country) })),
    certifications: extraction.certifications,
    languages: extraction.languages,
    clearances: extraction.clearances
      .map((c) => ({ ...c, country: normalizeCountry(c.country) ?? "" }))
      .filter((c) => c.country),
    workRights: extraction.workRights
      .map((w) => ({ country: normalizeCountry(w.country) ?? "", status: w.status, visa: w.visa, evidence: w.evidence }))
      .filter((w) => w.country)
      .map((w) => ({
        country: w.country,
        status: w.status,
        option: matchWorkRightOption(w.country, w.status, w.visa),
        expires: null,
        note: w.evidence,
      })),
    facts: [],
  };
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface ExtractedProfile {
  cvText: string;
  data: ProfileData;
}

export async function extractProfile(ctx: AiContext, source: CvSource): Promise<ExtractedProfile> {
  const { data } = await callStructured(
    ctx,
    "extractProfile",
    { schema: profileExtractionSchema, system: SYSTEM, messages: buildExtractionMessages(source) },
    { maxTokens: 48_000 },
  );
  const transcription = data.transcription?.trim();
  return { cvText: transcription && transcription.length > 50 ? transcription : source.text, data: toProfileData(data) };
}

/**
 * When a new CV replaces an old one, keep what the user confirmed themselves: their work-rights
 * choices (per country) and facts they added. Anything the new CV states fills the gaps.
 */
export function mergeWithPrevious(next: ProfileData, previous: ProfileData | null): ProfileData {
  if (!previous) return next;
  const rights = new Map(next.workRights.map((w) => [w.country, w]));
  for (const w of previous.workRights) rights.set(w.country, w);
  return {
    ...next,
    workRights: [...rights.values()],
    facts: previous.facts.filter((f) => f.source !== "cv"),
    clearances: next.clearances.length ? next.clearances : previous.clearances,
  };
}
