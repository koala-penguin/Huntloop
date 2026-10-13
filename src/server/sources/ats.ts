import { htmlToText, type PostingHints } from "../ingest/html";
import { safeFetch } from "../ingest/safe-fetch";

/**
 * Public job-board APIs of the main applicant-tracking systems (no key needed). Used for URL
 * imports now and for company watchlists later; they return the full description and apply link.
 */
export type AtsType = "greenhouse" | "lever" | "ashby";

export interface AtsRef {
  type: AtsType;
  board: string;
  id: string;
  eu: boolean;
}

export interface AtsPosting {
  ref: AtsRef;
  text: string;
  hints: PostingHints;
  sourceUrl: string;
}

export function detectAtsUrl(url: URL): AtsRef | null {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    const jobs = parts.indexOf("jobs");
    if (jobs === 1 && parts[2] && /^\d+$/.test(parts[2])) return { type: "greenhouse", board: parts[0], id: parts[2], eu: host.includes(".eu.") };
    const ghJid = url.searchParams.get("gh_jid");
    if (parts[0] && ghJid) return { type: "greenhouse", board: parts[0], id: ghJid, eu: host.includes(".eu.") };
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    return { type: "lever", board: parts[0], id: parts[1], eu: host.includes(".eu.") };
  }
  if (host === "jobs.ashbyhq.com" && parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1])) {
    return { type: "ashby", board: parts[0], id: parts[1], eu: false };
  }
  return null;
}

/** A board without a specific job: the employer's whole job board (for the watchlist). */
export function detectAtsBoard(url: URL): { type: AtsType; board: string; eu: boolean } | null {
  const job = detectAtsUrl(url);
  if (job) return { type: job.type, board: job.board, eu: job.eu };
  const host = url.hostname.toLowerCase();
  const board = url.pathname.split("/").filter(Boolean)[0];
  if (!board || !/^[\w.-]+$/.test(board)) return null;
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) return { type: "greenhouse", board, eu: host.includes(".eu.") };
  if (/^jobs(\.eu)?\.lever\.co$/.test(host)) return { type: "lever", board, eu: host.includes(".eu.") };
  if (host === "jobs.ashbyhq.com") return { type: "ashby", board, eu: false };
  return null;
}

export type JsonFetcher = (url: string) => Promise<unknown>;

/** Test hook: serve the ATS APIs from a local fixture server. Never set in normal use. */
function apiBase(): string | null {
  return process.env.HUNTLOOP_ATS_API_BASE?.replace(/\/+$/, "") || null;
}

const API_HOSTS = { greenhouse: "https://boards-api.greenhouse.io", lever: "https://api.lever.co", leverEu: "https://api.eu.lever.co", ashby: "https://api.ashbyhq.com" };

function apiHost(key: keyof typeof API_HOSTS): string {
  const base = apiBase();
  return base ? `${base}/${key}` : API_HOSTS[key];
}

export const defaultJsonFetcher: JsonFetcher = async (url) => {
  const base = apiBase();
  if (base && url.startsWith(base)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse((await safeFetch(url, { accept: "application/json" })).body);
};

const prettify = (slug: string) => slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

type Json = Record<string, unknown>;

function greenhouse(ref: AtsRef, data: Json): AtsPosting {
  const location = (data.location as Json | undefined)?.name as string | undefined;
  const pay = (data.pay_input_ranges as Json[] | undefined)?.[0];
  return {
    ref,
    sourceUrl: String(data.absolute_url ?? `https://job-boards.greenhouse.io/${ref.board}/jobs/${ref.id}`),
    text: htmlToText(String(data.content ?? "")),
    hints: {
      title: (data.title as string) ?? null,
      company: (data.company_name as string) ?? prettify(ref.board),
      locationText: location ?? null,
      postedAt: (data.first_published as string) ?? (data.updated_at as string) ?? null,
      salaryText: pay ? `${pay.currency_type ?? ""} ${Number(pay.min_cents) / 100}–${Number(pay.max_cents) / 100} ${pay.title ?? ""}`.trim() : null,
      applyUrl: (data.absolute_url as string) ?? null,
    },
  };
}

function lever(ref: AtsRef, data: Json): AtsPosting {
  const categories = (data.categories ?? {}) as Json;
  const lists = ((data.lists as Json[]) ?? []).map((l) => `${l.text}\n${htmlToText(String(l.content ?? ""))}`);
  const salary = data.salaryRange as Json | undefined;
  const workplace = String(data.workplaceType ?? "");
  return {
    ref,
    sourceUrl: String(data.hostedUrl ?? `https://jobs.lever.co/${ref.board}/${ref.id}`),
    text: [String(data.descriptionPlain ?? htmlToText(String(data.description ?? ""))), ...lists, String(data.additionalPlain ?? "")].filter(Boolean).join("\n\n").trim(),
    hints: {
      title: (data.text as string) ?? null,
      company: prettify(ref.board),
      locationText: (categories.location as string) ?? null,
      country: (data.country as string) ?? null,
      workplace: workplace === "remote" || workplace === "hybrid" || workplace === "onsite" ? workplace : null,
      employmentType: (categories.commitment as string) ?? null,
      postedAt: typeof data.createdAt === "number" ? new Date(data.createdAt).toISOString() : null,
      salaryText: salary ? `${salary.currency ?? ""} ${salary.min}–${salary.max} ${salary.interval ?? ""}`.trim() : null,
      applyUrl: (data.applyUrl as string) ?? null,
    },
  };
}

function ashby(ref: AtsRef, data: Json): AtsPosting {
  const jobs = (data.jobs as Json[]) ?? [];
  const job = jobs.find((j) => j.id === ref.id);
  if (!job) throw new Error("Job not found on this Ashby board (it may have closed)");
  const address = ((job.address as Json | undefined)?.postalAddress ?? {}) as Json;
  const workplace = String(job.workplaceType ?? "").toLowerCase();
  const compensation = job.compensation as Json | undefined;
  return {
    ref,
    sourceUrl: String(job.jobUrl ?? `https://jobs.ashbyhq.com/${ref.board}/${ref.id}`),
    text: String(job.descriptionPlain ?? htmlToText(String(job.descriptionHtml ?? ""))),
    hints: {
      title: (job.title as string) ?? null,
      company: prettify(ref.board),
      locationText: (job.location as string) ?? null,
      city: (address.addressLocality as string) ?? null,
      region: (address.addressRegion as string) ?? null,
      country: (address.addressCountry as string) ?? null,
      workplace: job.isRemote ? "remote" : workplace === "hybrid" ? "hybrid" : workplace === "onsite" ? "onsite" : null,
      employmentType: (job.employmentType as string) ?? null,
      postedAt: (job.publishedAt as string) ?? null,
      salaryText: (compensation?.compensationTierSummary as string) ?? null,
      applyUrl: (job.applyUrl as string) ?? null,
    },
  };
}

export function atsApiUrl(ref: AtsRef): string {
  switch (ref.type) {
    case "greenhouse":
      return `${apiHost("greenhouse")}/v1/boards/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.id)}?pay_transparency=true`;
    case "lever":
      return `${apiHost(ref.eu ? "leverEu" : "lever")}/v0/postings/${encodeURIComponent(ref.board)}/${encodeURIComponent(ref.id)}?mode=json`;
    case "ashby":
      return `${apiHost("ashby")}/posting-api/job-board/${encodeURIComponent(ref.board)}?includeCompensation=true`;
  }
}

/** The job's page on the ATS itself — imports through it get the full posting from the API. */
export function atsJobUrl(type: AtsType, board: string, id: string, eu = false): string {
  if (type === "greenhouse") return `https://job-boards${eu ? ".eu" : ""}.greenhouse.io/${board}/jobs/${id}`;
  if (type === "lever") return `https://jobs${eu ? ".eu" : ""}.lever.co/${board}/${id}`;
  return `https://jobs.ashbyhq.com/${board}/${id}`;
}

export async function fetchAtsPosting(ref: AtsRef, fetchJson: JsonFetcher = defaultJsonFetcher): Promise<AtsPosting> {
  const data = (await fetchJson(atsApiUrl(ref))) as Json;
  if (ref.type === "greenhouse") return greenhouse(ref, data);
  if (ref.type === "lever") return lever(ref, data);
  return ashby(ref, data);
}

/** One open role as listed on a board. */
export interface BoardJob {
  id: string;
  title: string;
  location: string | null;
  department: string | null;
  /** The job's page as the employer links it (may be their own careers site). */
  url: string;
  /** The job's page on the ATS, for importing. */
  atsUrl: string;
  postedAt: Date | null;
}

function boardListUrl(type: AtsType, board: string, eu: boolean): string {
  const b = encodeURIComponent(board);
  if (type === "greenhouse") return `${apiHost("greenhouse")}/v1/boards/${b}/jobs`;
  if (type === "lever") return `${apiHost(eu ? "leverEu" : "lever")}/v0/postings/${b}?mode=json`;
  return `${apiHost("ashby")}/posting-api/job-board/${b}`;
}

const date = (v: unknown): Date | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Every open role on an employer's Greenhouse, Lever or Ashby board (public APIs, no key). */
export async function fetchAtsBoardJobs(type: AtsType, board: string, eu = false, fetchJson: JsonFetcher = defaultJsonFetcher): Promise<BoardJob[]> {
  const data = (await fetchJson(boardListUrl(type, board, eu))) as Json | Json[];
  const list: Json[] = Array.isArray(data) ? data : ((data.jobs as Json[]) ?? []);
  return list
    .map((job): BoardJob | null => {
      const id = String(job.id ?? "");
      if (!id) return null;
      if (type === "greenhouse") {
        return {
          id,
          title: String(job.title ?? ""),
          location: ((job.location as Json | undefined)?.name as string) ?? null,
          department: ((job.departments as Json[] | undefined)?.[0]?.name as string) ?? null,
          url: String(job.absolute_url ?? atsJobUrl(type, board, id, eu)),
          atsUrl: atsJobUrl(type, board, id, eu),
          postedAt: date(job.first_published ?? job.updated_at),
        };
      }
      if (type === "lever") {
        const categories = (job.categories ?? {}) as Json;
        return {
          id,
          title: String(job.text ?? ""),
          location: (categories.location as string) ?? null,
          department: (categories.team as string) ?? null,
          url: String(job.hostedUrl ?? atsJobUrl(type, board, id, eu)),
          atsUrl: atsJobUrl(type, board, id, eu),
          postedAt: date(job.createdAt),
        };
      }
      return {
        id,
        title: String(job.title ?? ""),
        location: (job.location as string) ?? (job.isRemote ? "Remote" : null),
        department: (job.department as string) ?? null,
        url: String(job.jobUrl ?? atsJobUrl(type, board, id)),
        atsUrl: atsJobUrl(type, board, id),
        postedAt: date(job.publishedAt),
      };
    })
    .filter((j): j is BoardJob => !!j && !!j.title);
}

/** All open roles on a board — counts by department/location for employer research. */
export async function fetchAtsBoardSummary(type: AtsType, board: string, fetchJson: JsonFetcher = defaultJsonFetcher) {
  const list = await fetchAtsBoardJobs(type, board, false, fetchJson);
  const byDepartment = new Map<string, number>();
  const byLocation = new Map<string, number>();
  for (const job of list) {
    byDepartment.set(job.department ?? "Other", (byDepartment.get(job.department ?? "Other") ?? 0) + 1);
    byLocation.set(job.location ?? "Unknown", (byLocation.get(job.location ?? "Unknown") ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
  return { total: list.length, byDepartment: top(byDepartment), byLocation: top(byLocation) };
}
