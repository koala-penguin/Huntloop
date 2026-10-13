import { z } from "zod";

/**
 * Job sources that drive a browser on the user's computer. Off until the user turns them on and
 * accepts the risk notice (both sites' terms prohibit automated access).
 */
export const BROWSER_SITES = ["seek", "linkedin"] as const;
export type BrowserSite = (typeof BROWSER_SITES)[number];

const siteSchema = z.object({
  enabled: z.boolean(),
  /** When the user accepted the risk notice (ISO date); required to enable. */
  acceptedRiskAt: z.string().nullable(),
  /** Job pages opened per site per run. */
  maxPages: z.number().int().min(1).max(50),
});

export const sourceSettingsSchema = z.object({
  seek: siteSchema,
  linkedin: siteSchema.extend({
    /** Use the user's own LinkedIn sign-in (they sign in by hand in the browser window). Guest mode otherwise. */
    useLogin: z.boolean(),
  }),
});
export type SourceSettings = z.infer<typeof sourceSettingsSchema>;

export function defaultSourceSettings(): SourceSettings {
  return {
    seek: { enabled: false, acceptedRiskAt: null, maxPages: 25 },
    linkedin: { enabled: false, acceptedRiskAt: null, maxPages: 25, useLogin: false },
  };
}

export function normalizeSourceSettings(raw: unknown): SourceSettings {
  const base = defaultSourceSettings();
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<SourceSettings>;
  const merged = { seek: { ...base.seek, ...(input.seek ?? {}) }, linkedin: { ...base.linkedin, ...(input.linkedin ?? {}) } };
  const parsed = sourceSettingsSchema.safeParse(merged);
  if (!parsed.success) return base;
  // A site can't be on without an accepted risk notice.
  for (const site of BROWSER_SITES) if (!parsed.data[site].acceptedRiskAt) parsed.data[site].enabled = false;
  return parsed.data;
}
