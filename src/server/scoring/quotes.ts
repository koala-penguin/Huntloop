/**
 * Quote verification: a quote counts only if it really appears in the source text. Tolerates the
 * differences that extraction introduces (whitespace, line-break hyphenation, smart quotes, bullets,
 * ellipses), but not changed words.
 */

export function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[•·▪●◦■□►▶➤✓✔]/g, " ")
    // Quote marks around words often differ between source and quote; they never change meaning here.
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Also drops spaces and hyphens, so "e-\ncommerce", "e-commerce" and "ecommerce" all match. */
function compact(normalized: string): string {
  return normalized.replace(/[\s\-_]/g, "");
}

export interface QuoteIndex {
  normalized: string;
  compacted: string;
}

export function buildQuoteIndex(...sources: string[]): QuoteIndex {
  const normalized = normalizeForMatch(sources.join("\n"));
  return { normalized, compacted: compact(normalized) };
}

function contains(index: QuoteIndex, fragment: string): boolean {
  return index.normalized.includes(fragment) || index.compacted.includes(compact(fragment));
}

export function quoteFound(quote: string, index: QuoteIndex): boolean {
  const q = normalizeForMatch(quote);
  if (q.length < 3) return false;
  if (contains(index, q)) return true;
  // "first part … last part": every part must appear, in order.
  const parts = q.split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.length >= 3);
  if (parts.length > 1) {
    let from = 0;
    for (const part of parts) {
      const at = index.normalized.indexOf(part, from);
      if (at < 0) return false;
      from = at + part.length;
    }
    return true;
  }
  return false;
}

/** Returns the text between two verbatim anchors (inclusive), or null when either is missing. */
export function sliceBetweenAnchors(text: string, start: string | null, end: string | null): string | null {
  if (!start || !end) return null;
  const find = (needle: string, from: number) => {
    const direct = text.indexOf(needle, from);
    if (direct >= 0) return direct;
    // Retry with whitespace-tolerant matching.
    const pattern = needle
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    const m = new RegExp(pattern).exec(text.slice(from));
    return m ? from + m.index : -1;
  };
  const s = find(start, 0);
  if (s < 0) return null;
  const e = find(end, s);
  if (e < 0) return null;
  const endMatch = new RegExp(end.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")).exec(text.slice(e));
  const stop = e + (endMatch ? endMatch[0].length : end.length);
  const slice = text.slice(s, stop).trim();
  return slice.length > 0 ? slice : null;
}
