import { z } from "zod";
import { SENIORITY_LEVELS } from "./profile";

export const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "casual", "internship"] as const;
export const WORKPLACE_TYPES = ["onsite", "hybrid", "remote"] as const;
export const SALARY_PERIODS = ["year", "month", "day", "hour"] as const;
export const SALARY_BASES = ["base", "base_plus_super", "package"] as const;

export const marketPreferenceSchema = z.object({
  country: z.string(),
  primary: z.boolean(),
  cities: z.array(z.string()),
  /** Open to remote roles based in this country. */
  remoteOk: z.boolean(),
});
export type MarketPreference = z.infer<typeof marketPreferenceSchema>;

export const salaryFloorSchema = z.object({
  country: z.string(),
  amount: z.number().min(0),
  currency: z.string(),
  period: z.enum(SALARY_PERIODS),
  basis: z.enum(SALARY_BASES),
});

export const preferencesSchema = z.object({
  targetTitles: z.array(z.string()),
  seniority: z.array(z.enum(SENIORITY_LEVELS)),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)),
  workplace: z.array(z.enum(WORKPLACE_TYPES)),
  markets: z.array(marketPreferenceSchema),
  salaryFloors: z.array(salaryFloorSchema),
  excludedCompanies: z.array(z.string()),
  willingToRelocate: z.boolean(),
  maxPostingAgeDays: z.number().int().min(1).max(365),
  notes: z.string(),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export function defaultPreferences(): Preferences {
  return {
    targetTitles: [],
    seniority: [],
    employmentTypes: ["full_time"],
    workplace: ["onsite", "hybrid", "remote"],
    markets: [{ country: "AU", primary: true, cities: [], remoteOk: true }],
    salaryFloors: [],
    excludedCompanies: [],
    willingToRelocate: false,
    maxPostingAgeDays: 30,
    notes: "",
  };
}
