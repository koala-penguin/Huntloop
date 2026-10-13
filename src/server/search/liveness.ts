import { domainPolicy } from "../ingest/domain-policy";
import { extractFromHtml, htmlToText, type PostingHints } from "../ingest/html";
import { FetchBlockedError, safeFetch, type Resolver } from "../ingest/safe-fetch";
import { detectAtsUrl, fetchAtsPosting, type JsonFetcher } from "../sources/ats";

/**
 * Search results (especially from web search) often point at postings that have since closed.
 * Before a lead is kept it is opened: gone pages (404/410), "this vacancy has expired" notices and
 * past closing dates are dropped. When the page can't be read the lead is kept, unconfirmed.
 */
export type Liveness =
  | { status: "open"; text: string; hints: PostingHints }
  | { status: "closed"; reason: "gone" | "notice" | "past_closing_date" }
  | { status: "unknown" };

const CLOSED_NOTICES = [
  /\b(this|the) (?:job |vacancy |position |role )?(job|vacancy|position|role|posting|advert(isement)?|ad|listing|opportunity) (has|is) (now )?(expired|closed|been filled|been removed|no longer (available|open|active|accepting applications))/i,
  /\bno longer (accepting|taking|receiving) applications\b/i,
  /\b(job|vacancy|position|posting|role|listing|advert(isement)?) (is )?no longer (available|open|active)\b/i,
  /\b(position|role|vacancy) has been filled\b/i,
  /\bapplications (for this (role|job|position|vacancy) )?(have|has) (now )?closed\b/i,
  /\b(this )?job (posting |advert )?(has )?expired\b/i,
  /\bthe job you('re| are) looking for (is no longer|has been|was) /i,
];

/** A closed-posting notice in the page text, if any. */
export function closedNotice(text: string): string | null {
  for (const pattern of CLOSED_NOTICES) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function pastDate(value: string | null | undefined, now: Date): boolean {
  if (!value) return false;
  const time = Date.parse(value);
  // A closing date counts through the end of that day.
  return !Number.isNaN(time) && time + 86_400_000 < now.getTime();
}

function gone(error: unknown): boolean {
  if (error instanceof FetchBlockedError) return error.reason === "http_error" && (error.status === 404 || error.status === 410);
  return error instanceof Error && (/\bHTTP (404|410)\b/.test(error.message) || /not found on this Ashby board/i.test(error.message));
}

export interface LivenessOptions {
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  fetchJson?: JsonFetcher;
  now?: Date;
}

export async function checkPostingOpen(rawUrl: string, options: LivenessOptions = {}): Promise<Liveness> {
  const now = options.now ?? new Date();
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: "unknown" };
  }
  try {
    const ats = detectAtsUrl(url);
    if (ats) {
      // Applicant-tracking APIs only list open roles.
      const posting = await fetchAtsPosting(ats, options.fetchJson);
      return { status: "open", text: posting.text, hints: posting.hints };
    }
    const page = await safeFetch(url.toString(), { fetchImpl: options.fetchImpl, resolve: options.resolve, allow: (u) => ["fetch", "api"].includes(domainPolicy(u).mode) });
    const extracted = extractFromHtml(page.body);
    if (extracted.challenge) return { status: "unknown" };
    // Expiry banners often sit outside the main content extraction keeps, and a closed job's page
    // can be little more than the banner.
    if (closedNotice(extracted.text) || closedNotice(htmlToText(page.body.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")))) return { status: "closed", reason: "notice" };
    if (extracted.shell) return { status: "unknown" };
    if (pastDate(extracted.hints.closesAt, now)) return { status: "closed", reason: "past_closing_date" };
    return { status: "open", text: extracted.text, hints: extracted.hints };
  } catch (error) {
    return gone(error) ? { status: "closed", reason: "gone" } : { status: "unknown" };
  }
}
