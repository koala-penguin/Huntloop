import { z } from "zod";

export const REPORT_SECTIONS = ["business", "activities", "growth", "leadership", "hiring", "culture", "tech", "sponsorship", "red_flags"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const OWNERSHIP = ["public", "private", "startup", "subsidiary", "government", "nonprofit", "unknown"] as const;
export const CONFIDENCE = ["high", "medium", "low"] as const;

/** What Claude submits after researching an employer. Every claim names the page it came from. */
export const companyReportSchema = z.object({
  summary: z.string(),
  facts: z.object({
    website: z.string().nullable(),
    headquarters: z.string().nullable(),
    founded: z.string().nullable(),
    size: z.string().nullable(),
    ownership: z.enum(OWNERSHIP),
    industry: z.string().nullable(),
  }),
  sections: z.array(
    z.object({
      key: z.enum(REPORT_SECTIONS),
      confidence: z.enum(CONFIDENCE),
      claims: z.array(
        z.object({
          text: z.string(),
          sourceUrl: z.string(),
          /** Date of the source or event, YYYY-MM-DD or YYYY-MM; null if unknown. */
          date: z.string().nullable(),
        }),
      ),
    }),
  ),
  forYou: z.object({
    talkingPoints: z.array(z.string()),
    cvAngles: z.array(z.string()),
    questionsToAsk: z.array(z.string()),
    referralAngles: z.array(z.string()),
  }),
});
export type CompanyReportInput = z.infer<typeof companyReportSchema>;

export interface HiringActivity {
  /** Open roles on the employer's own job board (Greenhouse/Lever/Ashby), counted in code. */
  ats: { type: string; board: string; total: number; byDepartment: Array<{ name: string; count: number }>; byLocation: Array<{ name: string; count: number }> } | null;
  /** Jobs at this employer the user has added to Huntloop. */
  trackedJobs: number;
}

export interface CompanyReport extends CompanyReportInput {
  asOf: string;
  language: string;
  droppedClaims: number;
  sources: Array<{ url: string; title: string | null; pageAge: string | null }>;
  hiring: HiringActivity;
}
