import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db/database";
import { boardOpenings, companies, watchedBoards, type BoardOpeningRow, type WatchedBoardRow } from "../db/schema";
import { detectAtsBoard, fetchAtsBoardJobs, type AtsType, type BoardJob, type JsonFetcher } from "../sources/ats";
import type { JobLead } from "../sources/types";
import { prefilter } from "../search/run";
import { getCurrentProfile, getPreferences } from "../repo/profile";
import { importJob } from "../jobs/intake";
import { UserFacingError } from "../errors";
import { COUNTRY_CODES, countryName } from "@/shared/countries";
import { MARKET_PACKS } from "@/shared/markets";
import { filtersFromPreferences } from "@/shared/schemas/search";

/**
 * Employers' own job boards (Greenhouse, Lever, Ashby), checked for new openings. Checks use the
 * boards' free public APIs and code-only matching against the user's preferences; nothing is sent
 * to the AI until the user adds an opening to their jobs.
 */

const DAY = 86_400_000;
const NEW_FOR_DAYS = 7;

const prettify = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const AU_STATES = /\b(NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\b/;
const US_STATES = /,\s*(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\b/;

/** A best guess at the country of a board's free-text location ("Sydney, Australia", "Austin, TX"). */
export function guessCountry(location: string | null): string | null {
  if (!location) return null;
  const text = location.toLowerCase();
  for (const code of COUNTRY_CODES) {
    const name = countryName(code, "en").toLowerCase();
    if (name.length > 3 && text.includes(name)) return code;
  }
  if (/\b(usa|united states|u\.s\.)\b/.test(text)) return "US";
  if (/\b(uk|united kingdom)\b/.test(text)) return "GB";
  if (AU_STATES.test(location)) return "AU";
  if (US_STATES.test(location)) return "US";
  for (const pack of Object.values(MARKET_PACKS)) if (pack.suggestedCities.some((c) => text.includes(c.toLowerCase()))) return pack.country;
  return null;
}

/** Words that say little about which role it is ("Senior … Engineer"). */
const GENERIC_TITLE_WORDS = new Set(
  "senior junior lead principal staff head chief mid intern graduate entry level sr jr ii iii iv engineer engineering developer development manager management specialist analyst consultant officer associate assistant director coordinator architect administrator executive team"
    .split(" "),
);

const titleWords = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}+#]+/u)
    .filter((w) => w.length > 1);

/**
 * Boards list every role the employer has, so a shared generic word isn't enough: the opening's
 * title must share a distinctive word ("frontend", "data", "payroll") with one of the target titles.
 */
export function distinctiveTitleMatch(title: string, targets: string[]): boolean {
  const distinctive = new Set(targets.flatMap(titleWords).filter((w) => !GENERIC_TITLE_WORDS.has(w)));
  if (!distinctive.size) return true;
  return titleWords(title).some((w) => distinctive.has(w));
}

export interface WatchView extends WatchedBoardRow {
  openings: Array<BoardOpeningRow & { isNew: boolean }>;
  openCount: number;
  matchedCount: number;
  newMatchedCount: number;
}

export function listWatches(db: Db, userId: number, now = new Date()): WatchView[] {
  const watches = db.select().from(watchedBoards).where(eq(watchedBoards.userId, userId)).orderBy(desc(watchedBoards.id)).all();
  if (!watches.length) return [];
  const rows = db
    .select()
    .from(boardOpenings)
    .where(inArray(boardOpenings.watchId, watches.map((w) => w.id)))
    .all();
  return watches.map((w) => {
    const mine = rows.filter((o) => o.watchId === w.id && !o.closedAt);
    // "New": appeared after the first check (the baseline), within the last week.
    const baseline = Math.min(...rows.filter((o) => o.watchId === w.id).map((o) => o.firstSeenAt.getTime()));
    const openings = mine
      .map((o) => ({ ...o, isNew: o.firstSeenAt.getTime() > baseline && now.getTime() - o.firstSeenAt.getTime() < NEW_FOR_DAYS * DAY }))
      .sort((a, b) => Number(b.matched) - Number(a.matched) || Number(b.isNew) - Number(a.isNew) || (b.matchScore ?? 0) - (a.matchScore ?? 0) || a.title.localeCompare(b.title));
    return {
      ...w,
      openings,
      openCount: openings.length,
      matchedCount: openings.filter((o) => o.matched).length,
      newMatchedCount: openings.filter((o) => o.matched && o.isNew).length,
    };
  });
}

export function getWatch(db: Db, userId: number, id: number): WatchedBoardRow | undefined {
  return db
    .select()
    .from(watchedBoards)
    .where(and(eq(watchedBoards.userId, userId), eq(watchedBoards.id, id)))
    .get();
}

/** Watch a board given by a board or job link, or by a company Huntloop already knows the board of. */
export function addWatch(db: Db, userId: number, input: { url: string } | { companyId: number }, now = new Date()): WatchedBoardRow {
  let ref: { type: AtsType; board: string; eu: boolean } | null = null;
  let companyId: number | null = null;
  let name: string | null = null;
  if ("url" in input) {
    let url: URL;
    try {
      url = new URL(input.url.trim());
    } catch {
      throw new UserFacingError("invalid_url");
    }
    ref = detectAtsBoard(url);
  } else {
    const company = db
      .select()
      .from(companies)
      .where(and(eq(companies.userId, userId), eq(companies.id, input.companyId)))
      .get();
    if (company?.atsType && company.atsSlug && ["greenhouse", "lever", "ashby"].includes(company.atsType)) {
      ref = { type: company.atsType as AtsType, board: company.atsSlug, eu: false };
      companyId = company.id;
      name = company.name;
    }
  }
  if (!ref) throw new UserFacingError("unsupported_board");
  const existing = db
    .select()
    .from(watchedBoards)
    .where(and(eq(watchedBoards.userId, userId), eq(watchedBoards.atsType, ref.type), eq(watchedBoards.board, ref.board)))
    .get();
  if (existing) return existing;
  return db
    .insert(watchedBoards)
    .values({ userId, companyId, name: name ?? prettify(ref.board), atsType: ref.type, board: ref.board, eu: ref.eu, nextCheckAt: now })
    .returning()
    .get();
}

export function removeWatch(db: Db, userId: number, id: number): void {
  db.delete(watchedBoards)
    .where(and(eq(watchedBoards.userId, userId), eq(watchedBoards.id, id)))
    .run();
}

export function setAutoCheck(db: Db, userId: number, id: number, autoCheck: boolean, now = new Date()): void {
  db.update(watchedBoards)
    .set({ autoCheck, nextCheckAt: autoCheck ? now : null })
    .where(and(eq(watchedBoards.userId, userId), eq(watchedBoards.id, id)))
    .run();
}

function toLead(watch: WatchedBoardRow, job: BoardJob): JobLead {
  return {
    source: watch.atsType as AtsType,
    sourceId: job.id,
    url: job.atsUrl,
    title: job.title,
    company: watch.name,
    location: job.location,
    country: guessCountry(job.location),
    text: [job.department, job.location].filter(Boolean).join(" · "),
    full: false,
    postedAt: job.postedAt?.toISOString() ?? null,
    salaryText: null,
  };
}

export interface CheckResult {
  total: number;
  added: number;
  matched: number;
  closed: number;
}

/** Fetches the board, records new and closed roles, and marks the ones that fit the user's preferences. */
export async function checkWatch(db: Db, userId: number, watchId: number, options: { fetchJson?: JsonFetcher; now?: Date } = {}): Promise<CheckResult> {
  const now = options.now ?? new Date();
  const watch = getWatch(db, userId, watchId);
  if (!watch) throw new UserFacingError("not_found");
  let jobs: BoardJob[];
  try {
    jobs = await fetchAtsBoardJobs(watch.atsType as AtsType, watch.board, watch.eu, options.fetchJson);
  } catch (error) {
    db.update(watchedBoards)
      .set({ lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + DAY), lastError: error instanceof Error ? error.message.slice(0, 300) : String(error) })
      .where(eq(watchedBoards.id, watch.id))
      .run();
    throw new UserFacingError("board_unavailable", error instanceof Error ? error.message : String(error));
  }

  const preferences = getPreferences(db, userId);
  const profile = getCurrentProfile(db, userId);
  const filters = filtersFromPreferences(preferences);
  // Without target titles in the preferences, the candidate's recent titles stand in.
  if (!filters.titles.length) filters.titles = [...new Set(profile?.data.experience.slice(0, 2).map((e) => e.title) ?? [])];
  const checked = prefilter(
    jobs.map((j) => toLead(watch, j)),
    filters,
    preferences,
    profile?.data.skills.map((s) => s.name) ?? [],
    now,
  ).map((c) => (c.reason === null && !distinctiveTitleMatch(c.lead.title, filters.titles) ? { ...c, reason: "title_mismatch" } : c));
  const known = new Map(
    db
      .select()
      .from(boardOpenings)
      .where(eq(boardOpenings.watchId, watch.id))
      .all()
      .map((o) => [o.externalId, o]),
  );
  let added = 0;
  db.transaction((tx) => {
    jobs.forEach((job, i) => {
      const match = { matched: checked[i].reason === null, matchScore: checked[i].score, matchReason: checked[i].reason };
      const prior = known.get(job.id);
      if (prior) {
        tx.update(boardOpenings)
          .set({ title: job.title, location: job.location, department: job.department, url: job.url, atsUrl: job.atsUrl, postedAt: job.postedAt, lastSeenAt: now, closedAt: null, ...match })
          .where(eq(boardOpenings.id, prior.id))
          .run();
        known.delete(job.id);
      } else {
        added++;
        tx.insert(boardOpenings)
          .values({ watchId: watch.id, externalId: job.id, title: job.title, location: job.location, department: job.department, url: job.url, atsUrl: job.atsUrl, postedAt: job.postedAt, firstSeenAt: now, lastSeenAt: now, ...match })
          .run();
      }
    });
    // Roles no longer on the board have closed.
    for (const gone of known.values()) if (!gone.closedAt) tx.update(boardOpenings).set({ closedAt: now }).where(eq(boardOpenings.id, gone.id)).run();
    tx.update(watchedBoards)
      .set({ lastCheckedAt: now, nextCheckAt: new Date(now.getTime() + DAY), lastError: null })
      .where(eq(watchedBoards.id, watch.id))
      .run();
  });
  return { total: jobs.length, added, matched: checked.filter((c) => c.reason === null).length, closed: [...known.values()].filter((o) => !o.closedAt).length };
}

/** Adds an opening to the user's jobs; Huntloop then reads the full posting and assesses it. */
export async function importOpening(db: Db, userId: number, openingId: number): Promise<{ jobId: number; taskId: number | null }> {
  const row = db
    .select({ opening: boardOpenings, watch: watchedBoards })
    .from(boardOpenings)
    .innerJoin(watchedBoards, eq(boardOpenings.watchId, watchedBoards.id))
    .where(and(eq(boardOpenings.id, openingId), eq(watchedBoards.userId, userId)))
    .get();
  if (!row) throw new UserFacingError("not_found");
  if (row.opening.jobId) return { jobId: row.opening.jobId, taskId: null };
  const { jobId, taskId } = await importJob(db, userId, { url: row.opening.atsUrl });
  db.update(boardOpenings).set({ jobId }).where(eq(boardOpenings.id, openingId)).run();
  return { jobId, taskId };
}

/** "Assess N matches": imports the matching open roles not yet in the user's jobs, best first. */
export async function importMatches(db: Db, userId: number, watchId: number, max: number): Promise<number> {
  const watch = getWatch(db, userId, watchId);
  if (!watch) throw new UserFacingError("not_found");
  const openings = db
    .select()
    .from(boardOpenings)
    .where(and(eq(boardOpenings.watchId, watchId), eq(boardOpenings.matched, true), isNull(boardOpenings.closedAt), isNull(boardOpenings.jobId)))
    .all()
    .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0))
    .slice(0, max);
  for (const o of openings) await importOpening(db, userId, o.id);
  return openings.length;
}

/** Whether the user already watches this company's board (for "Watch this employer" on a job). */
export function watchForCompany(db: Db, userId: number, company: { atsType: string | null; atsSlug: string | null }): WatchedBoardRow | undefined {
  if (!company.atsType || !company.atsSlug) return undefined;
  return db
    .select()
    .from(watchedBoards)
    .where(and(eq(watchedBoards.userId, userId), eq(watchedBoards.atsType, company.atsType), eq(watchedBoards.board, company.atsSlug)))
    .get();
}
