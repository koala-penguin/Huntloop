import type { WorkRightStatus } from "./schemas/profile";

/**
 * Market packs: country conventions Huntloop uses for forms, gates and prompts.
 * Labels shown to the user come from messages ("markets.workRights.<id>"); the data here is
 * language-neutral. Facts that change (visa salary thresholds etc.) are deliberately not encoded —
 * the AI checks them with web search when they matter. Each pack carries an `asOf` date.
 */

export interface WorkRightOption {
  /** Message key suffix: markets.workRights.<id> */
  id: string;
  /** What the option means for applying to a typical local job. */
  status: WorkRightStatus;
  /** Visa subclass or pass name, when the option is a visa. */
  visa?: string;
}

/** How CVs are usually written in a market (used by CV tailoring and export). */
export interface CvConventions {
  paper: "A4" | "Letter";
  /** Usual length in pages [min, max]. */
  pages: [number, number];
  /** Spelling variant for English CVs (BCP 47). */
  spelling: string;
  /** Add "References available on request". */
  referees: boolean;
  /** Show the candidate's work rights in this country near the top. */
  workRightsLine: boolean;
}

export interface MarketPack {
  country: string;
  asOf: string;
  currency: string;
  salaryPeriod: "year" | "month";
  /** e.g. AU salaries are often quoted "+ super". */
  salaryBasisHint?: "base_plus_super" | "base" | "package";
  workRightOptions: WorkRightOption[];
  clearanceLevels: string[];
  suggestedCities: string[];
  /** Adzuna API country code, when Adzuna covers the market. */
  adzunaCountry?: string;
  /** Notes for prompts (English; not shown in the UI). */
  promptNotes: string;
  /** CV conventions. No market pack asks for a photo, date of birth or marital status. */
  cv: CvConventions;
}

const generic: Omit<MarketPack, "country"> = {
  asOf: "2026-10",
  currency: "USD",
  salaryPeriod: "year",
  workRightOptions: [
    { id: "citizen", status: "citizen" },
    { id: "permanent_resident", status: "permanent_resident" },
    { id: "open_work_permit", status: "unrestricted_visa" },
    { id: "restricted_permit", status: "restricted_visa" },
    { id: "employer_tied_visa", status: "needs_sponsorship" },
    { id: "needs_sponsorship", status: "needs_sponsorship" },
  ],
  clearanceLevels: [],
  suggestedCities: [],
  cv: { paper: "A4", pages: [1, 2], spelling: "en-GB", referees: false, workRightsLine: false },
  promptNotes:
    "No Huntloop market pack for this country: apply your own knowledge of its hiring conventions, work-authorization rules and salary norms, and say when something should be verified.",
};

export const MARKET_PACKS: Record<string, MarketPack> = {
  AU: {
    country: "AU",
    cv: { paper: "A4", pages: [2, 3], spelling: "en-AU", referees: true, workRightsLine: true },
    asOf: "2026-10",
    currency: "AUD",
    salaryPeriod: "year",
    salaryBasisHint: "base_plus_super",
    workRightOptions: [
      { id: "au_citizen", status: "citizen" },
      { id: "au_pr", status: "permanent_resident" },
      { id: "au_nz_citizen", status: "unrestricted_visa", visa: "444" },
      { id: "au_partner", status: "unrestricted_visa", visa: "820/801" },
      { id: "au_485", status: "unrestricted_visa", visa: "485" },
      { id: "au_whv", status: "restricted_visa", visa: "417/462" },
      { id: "au_student", status: "restricted_visa", visa: "500" },
      { id: "au_482", status: "needs_sponsorship", visa: "482" },
      { id: "au_needs_sponsorship", status: "needs_sponsorship" },
    ],
    clearanceLevels: ["Baseline", "NV1", "NV2", "PV"],
    suggestedCities: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Canberra", "Hobart", "Darwin", "Gold Coast", "Newcastle"],
    adzunaCountry: "au",
    promptNotes: [
      "Australia. Salaries are usually annual in AUD and often quoted '+ super' (employer superannuation on top) or 'package'/'incl. super'.",
      "'Full working rights' / 'must have the right to work in Australia' excludes candidates who need sponsorship.",
      "Government and defence roles often require Australian citizenship and a security clearance (Baseline, NV1, NV2, PV).",
      "Working holiday visas (417/462) limit work to 6 months per employer; student visas (500) limit hours.",
      "NZ citizens hold a 444 visa with full work rights. Temporary Graduate (485) holders have full work rights until expiry.",
      "Contract roles are often quoted as a daily rate. APS roles use selection criteria.",
    ].join(" "),
  },
  NZ: {
    country: "NZ",
    cv: { paper: "A4", pages: [2, 3], spelling: "en-NZ", referees: true, workRightsLine: true },
    asOf: "2026-10",
    currency: "NZD",
    salaryPeriod: "year",
    workRightOptions: [
      { id: "nz_citizen", status: "citizen" },
      { id: "nz_resident", status: "permanent_resident" },
      { id: "nz_au_citizen", status: "unrestricted_visa" },
      { id: "nz_open_work_visa", status: "unrestricted_visa" },
      { id: "nz_whv", status: "restricted_visa" },
      { id: "nz_aewv", status: "needs_sponsorship", visa: "AEWV" },
      { id: "nz_needs_sponsorship", status: "needs_sponsorship" },
    ],
    clearanceLevels: ["Confidential", "Secret", "Top Secret"],
    suggestedCities: ["Auckland", "Wellington", "Christchurch", "Hamilton", "Tauranga", "Dunedin"],
    adzunaCountry: "nz",
    promptNotes:
      "New Zealand. Salaries annual in NZD; KiwiSaver employer contributions are on top. Australian citizens can live and work in NZ. Employer-tied visas (AEWV) require an accredited employer.",
  },
  SG: {
    country: "SG",
    cv: { paper: "A4", pages: [1, 2], spelling: "en-SG", referees: false, workRightsLine: true },
    asOf: "2026-10",
    currency: "SGD",
    salaryPeriod: "month",
    workRightOptions: [
      { id: "sg_citizen", status: "citizen" },
      { id: "sg_pr", status: "permanent_resident" },
      { id: "sg_dependant_loc", status: "restricted_visa" },
      { id: "sg_needs_pass", status: "needs_sponsorship", visa: "EP/S Pass" },
    ],
    clearanceLevels: [],
    suggestedCities: ["Singapore"],
    adzunaCountry: "sg",
    promptNotes:
      "Singapore. Salaries are usually monthly in SGD, often with a 13th-month bonus (AWS). Foreigners need an Employment Pass or S Pass sponsored by the employer (COMPASS points framework, qualifying salaries that change over time — verify current figures). Some roles are open to Singaporeans/PRs only.",
  },
  US: {
    country: "US",
    cv: { paper: "Letter", pages: [1, 2], spelling: "en-US", referees: false, workRightsLine: false },
    asOf: "2026-10",
    currency: "USD",
    salaryPeriod: "year",
    workRightOptions: [
      { id: "us_citizen", status: "citizen" },
      { id: "us_green_card", status: "permanent_resident" },
      { id: "us_ead", status: "unrestricted_visa", visa: "EAD" },
      { id: "us_h1b", status: "needs_sponsorship", visa: "H-1B" },
      { id: "us_needs_sponsorship", status: "needs_sponsorship" },
    ],
    clearanceLevels: ["Public Trust", "Secret", "Top Secret", "TS/SCI"],
    suggestedCities: ["New York", "San Francisco", "Seattle", "Austin", "Boston", "Los Angeles", "Chicago"],
    adzunaCountry: "us",
    promptNotes:
      "United States. Salaries annual in USD; several states require pay ranges in postings. 'No sponsorship' / 'must be authorized to work without sponsorship' excludes H-1B candidates; 'US person' or ITAR roles require citizenship or permanent residence. Résumés are usually 1–2 pages.",
  },
};

export function marketPack(country: string | null | undefined): MarketPack {
  const code = (country ?? "").toUpperCase();
  return MARKET_PACKS[code] ?? { ...generic, country: code || "ZZ" };
}

export function hasMarketPack(country: string | null | undefined): boolean {
  return !!country && country.toUpperCase() in MARKET_PACKS;
}

/** Every work-right option id that has a label, for the i18n completeness test. */
export function allWorkRightOptionIds(): string[] {
  const ids = new Set(generic.workRightOptions.map((o) => o.id));
  for (const pack of Object.values(MARKET_PACKS)) for (const o of pack.workRightOptions) ids.add(o.id);
  return [...ids];
}
