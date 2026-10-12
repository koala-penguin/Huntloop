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

export type JsonFetcher = (url: string) => Promise<unknown>;

export const defaultJsonFetcher: JsonFetcher = async (url) => JSON.parse((await safeFetch(url, { accept: "application/json" })).body);

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
      return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.id)}?pay_transparency=true`;
    case "lever":
      return `https://api${ref.eu ? ".eu" : ""}.lever.co/v0/postings/${encodeURIComponent(ref.board)}/${encodeURIComponent(ref.id)}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(ref.board)}?includeCompensation=true`;
  }
}

export async function fetchAtsPosting(ref: AtsRef, fetchJson: JsonFetcher = defaultJsonFetcher): Promise<AtsPosting> {
  const data = (await fetchJson(atsApiUrl(ref))) as Json;
  if (ref.type === "greenhouse") return greenhouse(ref, data);
  if (ref.type === "lever") return lever(ref, data);
  return ashby(ref, data);
}

/** All open roles on a board — counts by department/location for employer research. */
export async function fetchAtsBoardSummary(type: AtsType, board: string, fetchJson: JsonFetcher = defaultJsonFetcher) {
  const url =
    type === "greenhouse"
      ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs`
      : type === "lever"
        ? `https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`
        : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`;
  const data = (await fetchJson(url)) as Json | Json[];
  const list: Json[] = Array.isArray(data) ? data : ((data.jobs as Json[]) ?? []);
  const byDepartment = new Map<string, number>();
  const byLocation = new Map<string, number>();
  for (const job of list) {
    const dept =
      type === "greenhouse"
        ? (((job.departments as Json[] | undefined)?.[0]?.name as string) ?? "Other")
        : type === "lever"
          ? ((((job.categories ?? {}) as Json).team as string) ?? "Other")
          : ((job.department as string) ?? "Other");
    const loc =
      type === "greenhouse"
        ? (((job.location as Json | undefined)?.name as string) ?? "Unknown")
        : type === "lever"
          ? ((((job.categories ?? {}) as Json).location as string) ?? "Unknown")
          : ((job.location as string) ?? "Unknown");
    byDepartment.set(dept, (byDepartment.get(dept) ?? 0) + 1);
    byLocation.set(loc, (byLocation.get(loc) ?? 0) + 1);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
  return { total: list.length, byDepartment: top(byDepartment), byLocation: top(byLocation) };
}
