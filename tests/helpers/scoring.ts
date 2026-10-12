import type { Assessment, AssessmentStatus, PostingAnalysis, Requirement } from "@/shared/schemas/job";
import { emptyProfile, type ProfileData, type WorkRight } from "@/shared/schemas/profile";
import { defaultPreferences, type Preferences } from "@/shared/schemas/preferences";
import type { ScoreInput } from "@/server/scoring/aggregate";

export const CV_TEXT = `Jamie Park — Senior Frontend Engineer, Sydney
Senior Frontend Engineer at Harbour Payments, 2021-03 to present
- Led the rebuild of the merchant dashboard in React and TypeScript, cutting page load time by 40%.
- Mentored 4 engineers.
Frontend Engineer at Koala Commerce, 2018-01 to 2021-02
- Built checkout flows in React used by 2 million monthly customers.`;

export function profile(overrides: Partial<ProfileData> = {}, rights: WorkRight[] = []): ProfileData {
  return {
    ...emptyProfile(),
    experience: [
      { id: "exp-1", title: "Senior Frontend Engineer", company: "Harbour Payments", industry: "fintech", location: "Sydney", country: "AU", start: "2021-03", end: null, seniority: "senior", skills: ["React", "TypeScript"], highlights: [] },
      { id: "exp-2", title: "Frontend Engineer", company: "Koala Commerce", industry: "ecommerce", location: "Sydney", country: "AU", start: "2018-01", end: "2021-02", seniority: "mid", skills: ["React"], highlights: [] },
    ],
    workRights: rights,
    ...overrides,
  };
}

export const right = (country: string, status: WorkRight["status"], option: string | null = null): WorkRight => ({ country, status, option, expires: null, note: null });

export function req(id: string, partial: Partial<Requirement> = {}): Requirement {
  return { id, postingQuote: `requirement ${id}`, kind: "must", category: "skill", gate: "none", minYears: null, normalized: id, ...partial };
}

export function analysis(requirements: Requirement[], partial: Partial<PostingAnalysis> = {}): PostingAnalysis {
  return {
    isJobPosting: true,
    postingStart: null,
    postingEnd: null,
    title: "Senior Frontend Engineer",
    company: "Acme",
    companyDomain: null,
    locationText: "Sydney NSW",
    city: "Sydney",
    region: "NSW",
    country: "AU",
    countryEvidence: "Sydney NSW",
    workplace: "hybrid",
    remoteScope: null,
    employmentType: "full_time",
    seniority: "senior",
    salary: null,
    postedText: null,
    postedDate: null,
    closesDate: null,
    language: "en",
    sponsorship: "unknown",
    sponsorshipQuote: null,
    requirements,
    droppedRequirements: 0,
    ghostSignals: [],
    ...partial,
  };
}

/** An assessment marking each requirement with the given status; "met"/"partial" get a real CV quote. */
export function assessment(statuses: Record<string, AssessmentStatus>, partial: Partial<Assessment> = {}): Assessment {
  return {
    items: Object.entries(statuses).map(([requirementId, status]) => ({
      requirementId,
      evidence: status === "met" || status === "partial" ? [{ source: "cv" as const, quote: "Led the rebuild of the merchant dashboard in React and TypeScript", factId: null }] : [],
      experienceIds: [],
      reasoning: "",
      status,
      gapType: status === "met" ? ("none" as const) : ("real_gap" as const),
      question: null,
      postingQuoteGloss: null,
    })),
    candidateSeniority: "senior",
    titleRelevance: "same",
    industryRelevance: "adjacent",
    strengths: [],
    boosters: [],
    risks: [],
    oneLine: "",
    postingSummary: "",
    ...partial,
  };
}

export function scoreInput(a: PostingAnalysis, as: Assessment, opts: { profile?: ProfileData; preferences?: Preferences; answers?: Record<string, "yes" | "no">; postedAt?: Date | null; city?: string | null; cvText?: string } = {}): ScoreInput {
  return {
    analysis: a,
    assessment: as,
    profile: { cvText: opts.cvText ?? CV_TEXT, data: opts.profile ?? profile({}, [right("AU", "permanent_resident", "au_pr")]) },
    preferences: opts.preferences ?? { ...defaultPreferences(), markets: [{ country: "AU", primary: true, cities: ["Sydney"], remoteOk: true }] },
    job: { country: a.country, city: opts.city === undefined ? a.city : opts.city, postedAt: opts.postedAt ?? null, descriptionIsFull: true },
    answers: opts.answers ?? {},
    now: new Date("2026-10-12T00:00:00Z"),
  };
}
