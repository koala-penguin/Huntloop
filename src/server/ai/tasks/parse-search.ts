import { searchFiltersSchema, type SearchFilters } from "@/shared/schemas/search";
import type { Preferences } from "@/shared/schemas/preferences";
import { stableStringify } from "@/shared/stable-json";
import { isCountryCode } from "@/shared/countries";
import { callStructured, type AiContext } from "../client";

export const PARSE_SEARCH_PROMPT_VERSION = 1;

const SYSTEM = `You turn a job seeker's search request (in any language) into search filters for Huntloop.

Rules:
- Start from the user's saved job preferences and change only what the request mentions or clearly implies. If the request names a place, it replaces the saved locations; if it names a role, it replaces the saved titles.
- titles: job titles in English as they would appear in postings (e.g. "프론트엔드 개발자" → "Frontend Engineer", "Frontend Developer"). At most 3.
- keywords: specific skills or technologies the user asked for. excludeKeywords: things they want to avoid.
- locations: ISO 3166-1 alpha-2 country codes, with a city when one is named (city names in English).
- postedWithinDays: e.g. "this week" → 7, "today" → 1. salaryMin: annual amount in the local currency if stated (convert "150k" → 150000).
- Leave a field empty (or null) rather than guessing.`;

/** Natural-language request → filters. An empty request uses the saved preferences as they are. */
export async function parseSearch(ctx: AiContext, query: string, defaults: SearchFilters, preferences: Preferences, now = new Date()): Promise<SearchFilters> {
  if (!query.trim()) return defaults;
  const { data } = await callStructured(ctx, "parseSearch", {
    schema: searchFiltersSchema,
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          `<saved_preferences>\n${stableStringify({ filters: defaults, willingToRelocate: preferences.willingToRelocate, notes: preferences.notes }, 1)}\n</saved_preferences>`,
          `<request>\n${query}\n</request>`,
          `Today's date: ${now.toISOString().slice(0, 10)}`,
        ].join("\n"),
      },
    ],
  });
  return cleanFilters(data);
}

export function cleanFilters(filters: SearchFilters): SearchFilters {
  const uniq = (items: string[]) => [...new Set(items.map((s) => s.trim()).filter(Boolean))];
  return {
    ...filters,
    titles: uniq(filters.titles).slice(0, 5),
    keywords: uniq(filters.keywords).slice(0, 10),
    excludeKeywords: uniq(filters.excludeKeywords).slice(0, 10),
    locations: filters.locations
      .map((l) => ({ country: l.country.trim().toUpperCase(), city: l.city?.trim() || null }))
      .filter((l) => isCountryCode(l.country))
      .slice(0, 6),
    postedWithinDays: filters.postedWithinDays && filters.postedWithinDays > 0 ? Math.min(filters.postedWithinDays, 120) : null,
    salaryMin: filters.salaryMin && filters.salaryMin > 0 ? filters.salaryMin : null,
  };
}
