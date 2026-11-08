import { z } from "zod";
import { SENIORITY_LEVELS } from "./profile";
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES, type Preferences } from "./preferences";

export const SEARCH_SOURCES = ["adzuna", "web_agent", "seek", "linkedin", "browser_agent"] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number];

/** What a search looks for. Shown as editable chips; also the output of the parse-search task. */
export const searchFiltersSchema = z.object({
  /** Job titles or role names, e.g. "Frontend Engineer". */
  titles: z.array(z.string()),
  /** Skills or words the job should mention, e.g. "React". */
  keywords: z.array(z.string()),
  /** Where: ISO country code, optional city. */
  locations: z.array(z.object({ country: z.string(), city: z.string().nullable() })),
  workplace: z.array(z.enum(WORKPLACE_TYPES)),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)),
  seniority: z.array(z.enum(SENIORITY_LEVELS)),
  /** Minimum annual salary in the local currency. */
  salaryMin: z.number().nullable(),
  postedWithinDays: z.number().int().nullable(),
  /** Words that rule a job out, e.g. "unpaid", "graduate". */
  excludeKeywords: z.array(z.string()),
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;

/** A search built from the user's job preferences, used when they don't type anything. */
export function filtersFromPreferences(preferences: Preferences): SearchFilters {
  const locations = preferences.markets.flatMap((m): SearchFilters["locations"] =>
    m.cities.length ? m.cities.map((city) => ({ country: m.country, city })) : [{ country: m.country, city: null }],
  );
  const annual = preferences.salaryFloors.find((f) => f.period === "year" && preferences.markets.some((m) => m.primary && m.country === f.country));
  return {
    titles: preferences.targetTitles,
    keywords: [],
    locations,
    workplace: preferences.workplace,
    employmentTypes: preferences.employmentTypes,
    seniority: preferences.seniority,
    salaryMin: annual?.amount ?? null,
    postedWithinDays: preferences.maxPostingAgeDays,
    excludeKeywords: [],
  };
}

/** Why a SEEK/LinkedIn search found no jobs. */
export type SourceDetail = "blocked_skipped" | "no_job_links" | "pages_unreadable";

/** Why a lead was left out of a run (code checks, link checks and the agents' own drops). */
export type RejectReason = "closed" | "unseen_url" | "restricted_site" | "excluded_company" | "excluded_keyword" | "too_old" | "outside_markets" | "title_mismatch" | "previously_deleted";

/** A lead that was left out, kept so the run can be audited. */
export interface RejectedLead {
  source: string;
  url: string;
  title: string;
  company: string | null;
  reason: RejectReason;
  /** e.g. for "closed": gone | notice | past_closing_date | inactive; for the browsing agent: not_opened | blocked | too_short | over_limit. */
  detail?: string;
}

/** At most this many left-out leads are kept per run (first ones, in pipeline order). */
export const MAX_REJECTED = 200;

/** Details with their own label: what the browsing agent found on a page it opened, or how a posting closed. */
export const REJECT_DETAILS = ["not_opened", "blocked", "too_short", "over_limit", "gone", "notice", "past_closing_date", "inactive"] as const;

/** The catalog key (under `search.`) that explains a left-out lead: its detail when known, else its reason. */
export function rejectedLabelKey(r: RejectedLead): string {
  return r.detail && (REJECT_DETAILS as readonly string[]).includes(r.detail) ? `rejectDetail.${r.detail}` : `filterReason.${r.reason}`;
}

export interface SearchRunSummary {
  /** `partial: "quota"`: the source stopped early at a quota; `leads` is what it found before. */
  /** `detail`: why a browser site found nothing (older summaries don't have it). */
  sources: Partial<Record<SearchSource, { leads: number; error: string | null; partial?: "quota"; detail?: SourceDetail }>>;
  /** Leads after removing duplicates. */
  unique: number;
  /** Already in the user's jobs (found again). */
  known: number;
  /** Ruled out by the free code checks, by reason. */
  filtered: Record<string, number>;
  screened: number;
  deep: number;
  /** Background AI work stopped: the API spending cap, or the Claude subscription's usage limit. */
  stoppedBy: "budget" | "limit" | null;
  /** Every lead left out, with its reason (older summaries don't have it). */
  rejected?: RejectedLead[];
}
