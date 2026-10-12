import * as cheerio from "cheerio";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { normalizeText } from "../cv/extract-text";

/** Structured hints from a page or API, passed to analysis alongside the text. */
export interface PostingHints {
  title?: string | null;
  company?: string | null;
  locationText?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  workplace?: "onsite" | "hybrid" | "remote" | null;
  employmentType?: string | null;
  postedAt?: string | null;
  closesAt?: string | null;
  salaryText?: string | null;
  applyUrl?: string | null;
}

export interface ExtractedPage {
  text: string;
  hints: PostingHints;
  /** Text came from structured data (JSON-LD / API) rather than the visible page. */
  structured: boolean;
  challenge: boolean;
  shell: boolean;
}

const BLOCK_TAGS = "p, div, li, br, h1, h2, h3, h4, h5, h6, tr, section, article, ul, ol";

/** HTML fragment → readable plain text with line breaks and bullets. */
export function htmlToText(html: string): string {
  if (!html) return "";
  // Some APIs return entity-escaped HTML ("&lt;p&gt;").
  const decoded = /&lt;\/?[a-z]/i.test(html) ? cheerio.load(`<x>${html}</x>`)("x").text() : html;
  const $ = cheerio.load(decoded);
  $("script, style, noscript").remove();
  $("li").each((_, el) => {
    $(el).prepend("• ");
  });
  $(BLOCK_TAGS).each((_, el) => {
    $(el).append("\n");
  });
  return normalizeText($.root().text().replace(/ /g, " "));
}

type Json = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined | null): T[] {
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && typeof (value as Json).name === "string") return ((value as Json).name as string).trim() || null;
  return null;
}

function isJobPosting(node: Json): boolean {
  return asArray(node["@type"] as string | string[]).some((t) => typeof t === "string" && t.toLowerCase() === "jobposting");
}

/** Finds schema.org JobPosting objects in JSON-LD script tags (handles arrays and @graph). */
export function findJsonLdJobPosting(html: string): Json | null {
  const $ = cheerio.load(html);
  const candidates: Json[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().replace(/^\s*<!--|-->\s*$/g, "").replace(/^\s*\/\/<!\[CDATA\[|\/\/\]\]>\s*$/g, "");
    try {
      const parsed = JSON.parse(raw) as unknown;
      const stack = asArray(parsed as Json | Json[]);
      while (stack.length) {
        const node = stack.shift();
        if (!node || typeof node !== "object") continue;
        if (isJobPosting(node)) candidates.push(node);
        if (Array.isArray(node["@graph"])) stack.push(...(node["@graph"] as Json[]));
      }
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  });
  return candidates.sort((a, b) => String(b.description ?? "").length - String(a.description ?? "").length)[0] ?? null;
}

export function hintsFromJsonLd(node: Json): { text: string; hints: PostingHints } {
  const location = asArray(node.jobLocation as Json | Json[])[0];
  const address = (location?.address ?? {}) as Json;
  const salary = node.baseSalary as Json | undefined;
  const salaryValue = (salary?.value ?? {}) as Json;
  const salaryText = salary
    ? [str(salary.currency), salaryValue.minValue ?? salaryValue.value, salaryValue.maxValue ? `– ${salaryValue.maxValue}` : null, str(salaryValue.unitText)]
        .filter((v) => v !== null && v !== undefined && v !== "")
        .join(" ")
    : null;
  const telecommute = asArray(node.jobLocationType as string | string[]).some((t) => /telecommute/i.test(String(t)));
  return {
    text: htmlToText(String(node.description ?? "")),
    hints: {
      title: str(node.title),
      company: str(node.hiringOrganization),
      locationText: [str(address.addressLocality), str(address.addressRegion), str(address.addressCountry)].filter(Boolean).join(", ") || null,
      city: str(address.addressLocality),
      region: str(address.addressRegion),
      country: str(address.addressCountry),
      workplace: telecommute ? "remote" : null,
      employmentType: asArray(node.employmentType as string | string[]).join(", ") || null,
      postedAt: str(node.datePosted),
      closesAt: str(node.validThrough),
      salaryText: salaryText || null,
      applyUrl: str(node.url),
    },
  };
}

/** Longest description-like string inside Next.js page data, if any. */
function fromNextData(html: string): string | null {
  const $ = cheerio.load(html);
  const raw = $("script#__NEXT_DATA__").text();
  if (!raw) return null;
  try {
    let best = "";
    const visit = (value: unknown, key: string) => {
      if (typeof value === "string") {
        if (/desc|content|body|details/i.test(key) && value.length > best.length) best = value;
      } else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, k);
    };
    visit(JSON.parse(raw), "");
    return best.length > 300 ? htmlToText(best) : null;
  } catch {
    return null;
  }
}

const CHALLENGE = /just a moment|attention required|cf-chl|captcha|verify you are (a )?human|are you a robot|access denied|enable javascript and cookies|px-captcha|datadome|unusual traffic/i;

export function extractFromHtml(html: string): ExtractedPage {
  const $ = cheerio.load(html);
  const title = $("title").first().text();
  const ld = findJsonLdJobPosting(html);
  if (ld) {
    const { text, hints } = hintsFromJsonLd(ld);
    if (text.length > 200) return { text, hints, structured: true, challenge: false, shell: false };
  }
  const nextText = fromNextData(html);
  let readable = "";
  try {
    const { document } = parseHTML(html);
    readable = normalizeText(new Readability(document as unknown as Document).parse()?.textContent ?? "");
  } catch {
    readable = "";
  }
  if (!readable) {
    $("script, style, noscript, nav, footer, header").remove();
    readable = normalizeText($("body").text());
  }
  const text = nextText && nextText.length > readable.length / 2 ? nextText : readable;
  const shortPage = text.length < 300;
  const challenge = CHALLENGE.test(title) || (shortPage && CHALLENGE.test(html.slice(0, 20_000)));
  return {
    text,
    hints: ld ? hintsFromJsonLd(ld).hints : { title: title || null },
    structured: false,
    challenge,
    shell: !challenge && shortPage,
  };
}
