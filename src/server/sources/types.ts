import type { SearchSource } from "@/shared/schemas/search";
import type { AtsType } from "./ats";

/** A job found by a search source, before it becomes a Huntloop job. */
export interface JobLead {
  source: SearchSource | AtsType;
  sourceId: string | null;
  url: string;
  title: string;
  company: string | null;
  location: string | null;
  /** ISO country code when known. */
  country: string | null;
  /** Description text as provided — often only a snippet. */
  text: string;
  /** True when `text` is the full posting, not a snippet. */
  full: boolean;
  postedAt: string | null;
  salaryText: string | null;
}

export class SourceQuotaError extends Error {
  constructor(public readonly source: string, public readonly window: "minute" | "day" | "month") {
    super(`${source} quota reached (${window})`);
    this.name = "SourceQuotaError";
  }
}
