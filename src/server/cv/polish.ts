import { styleViolations } from "@/shared/cv-style";
import { TOOL_TERMS } from "@/shared/role-suggestions";
import { extractNumbers } from "./provenance";

/**
 * The check on a revised answer the interviewer offers. The candidate's answer becomes CV evidence,
 * so a revision may fix grammar and tense and cut filler, but must keep every number and name the
 * candidate typed and may add only a couple of plain words — never a number, a name, a tool or a
 * size claim. Checked in code; the candidate still has to accept it.
 */

export type PolishGateResult = { ok: true } | { ok: false; reason: "numbers" | "dropped" | "new_term" | "style" | "drift" | "length"; detail: string };

/** Words that turn a plain statement into a bigger claim. */
const FACT_LIKE_WORDS = new Set(
  [
    "large", "major", "significant", "significantly", "complex", "key", "strategic", "global", "enterprise", "senior", "multiple", "several", "many", "all", "entire",
    "critical", "successful", "successfully", "award", "first", "only", "best", "top", "record", "million", "billion", "thousand", "dozens", "hundreds",
    "largest", "biggest", "huge", "massive", "vast", "double", "doubled", "doubling", "triple", "tripled", "half", "halved",
  ].map(stem),
);
/** Size words in any form: large, larger, largest, big, bigger, biggest… */
const SIZE_WORD = /^(large|big|huge|massive|vast)(r|st|ger|gest|er|est)?$/;

/**
 * Words that commonly open a sentence. A capital letter on these says nothing, so dropping one is
 * not dropping a name.
 */
const STARTERS = new Set(
  "i a an the we my our it its this that these those there here then so and but or also in on at as by for from with after before during when while since until mostly mainly basically usually often sometimes yes no well plus currently now today recently previously".split(" "),
);

const STOPWORDS = new Set(
  "the and for with that this was were are our their they them from into over under about also have has had been being which who whom there then than very just its his her but not can per via out each some more most such when what where while both other these those will would could should was were you your".split(" "),
);

const KO_PARTICLE = /(은|는|이|가|을|를|에|에서|의|와|과|로|으로|도)$/u;
const hangul = (s: string) => /[\p{Script=Hangul}]/u.test(s);

function stem(word: string): string {
  const w = word.toLowerCase();
  const cut = w.replace(/(ing|ed|es|s|d)$/, "");
  return cut.length >= 3 ? cut : w;
}

interface Token {
  text: string;
  key: string;
  /** Starts a sentence (its capital letter may just be grammar). */
  initial: boolean;
  /** The very first word of the text. */
  first: boolean;
}

/** Word tokens with their comparison keys: stemmed English (3+ letters), Korean with particles stripped. */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}][\p{L}\p{N}'’+#]*/gu;
  for (const m of text.matchAll(re)) {
    const word = m[0].replace(/['’]s$/, "");
    const before = text.slice(0, m.index).trimEnd();
    const initial = before === "" || /[.!?:\n]$/.test(before);
    const key = hangul(word) ? word.replace(KO_PARTICLE, "") || word : stem(word);
    out.push({ text: word, key, initial, first: out.length === 0 });
  }
  return out;
}

const content = (list: Token[]) => list.filter((t) => (hangul(t.text) ? t.key.length >= 1 : t.text.length >= 3) && !STOPWORDS.has(t.text.toLowerCase()));
/** Has a capital letter somewhere (a name, an employer, a tool, an acronym). */
const firstPerson = (t: Token) => /^I(['’](ve|m|d|ll))?$/.test(t.text);
const hasCapital = (t: Token) => /\p{Lu}/u.test(t.text) && !firstPerson(t);
/** EY, AI, VP, ML, R: an acronym or a one-letter name, never just grammar. */
const acronym = (t: Token) => /^\p{Lu}[\p{Lu}\p{N}+#]*$/u.test(t.text) && !firstPerson(t);
/** A verb form that often opens a CV line ("Managed", "Planning"): rewording it is fine. */
const verbForm = (t: Token) => /^\p{Lu}\p{Ll}+(ed|ing)$/u.test(t.text);
const digitRuns = (text: string) => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).sort();
const numberKey = (n: { kind: string; value: number }) => `${n.kind}:${n.value}`;

function multiset(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

export function polishGate(raw: string, polished: string): PolishGateResult {
  const text = polished.replace(/\s+/g, " ").trim();
  const source = raw.replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "length", detail: "empty" };

  // 1. The same numbers: none added, none dropped. Digits as typed first (this also covers numbers
  // glued to a word, like 5명 or 3x), then numbers as values (so "5k" and "5,000" can't swap).
  const rawDigits = digitRuns(source);
  const newDigits = digitRuns(text);
  if (rawDigits.join(" ") !== newDigits.join(" ")) {
    const added = newDigits.find((d) => newDigits.filter((x) => x === d).length > rawDigits.filter((x) => x === d).length);
    const lost = rawDigits.find((d) => rawDigits.filter((x) => x === d).length > newDigits.filter((x) => x === d).length);
    return { ok: false, reason: "numbers", detail: added ? `adds the number "${added}"` : `drops the number "${lost}"` };
  }
  const a = multiset(extractNumbers(source).map(numberKey));
  const b = multiset(extractNumbers(text).map(numberKey));
  for (const n of extractNumbers(text)) if ((b.get(numberKey(n)) ?? 0) > (a.get(numberKey(n)) ?? 0)) return { ok: false, reason: "numbers", detail: `adds the number "${n.raw}"` };
  for (const n of extractNumbers(source)) if ((a.get(numberKey(n)) ?? 0) > (b.get(numberKey(n)) ?? 0)) return { ok: false, reason: "numbers", detail: `drops the number "${n.raw}"` };

  const rawTokens = tokens(source);
  const polishedTokens = tokens(text);
  const rawKeys = new Set(rawTokens.map((t) => t.key));
  const rawLower = new Set(rawTokens.map((t) => t.text.toLowerCase()));
  const polishedKeys = new Set(polishedTokens.map((t) => t.key));
  const polishedLower = new Set(polishedTokens.map((t) => t.text.toLowerCase()));

  // 4. Every name, tool or employer the candidate typed is still there: any word with a capital
  // letter. At the start of a sentence a capital may only be grammar, so there common opening words
  // and verb forms ("Managed", "Planning") may be reworded; anything else ("Google hired me") stays.
  const dropped = rawTokens.find((t) => {
    if (!hasCapital(t)) return false;
    if (!t.initial || acronym(t)) return !polishedLower.has(t.text.toLowerCase());
    if (STARTERS.has(t.text.toLowerCase()) || verbForm(t)) return false;
    return !polishedKeys.has(t.key);
  });
  if (dropped) return { ok: false, reason: "dropped", detail: `drops "${dropped.text}"` };

  // 3. New words may not be names, numbers, tools, size claims, or English inside a Korean answer.
  // Every word counts here, however short. A new word with a capital letter is a new name, with one
  // exception: the revision's very first word, when it is an ordinary capitalised word (the verb a CV
  // line starts with, "Led"); an acronym is refused even there.
  const koreanAnswer = (source.match(/[\p{Script=Hangul}]/gu)?.length ?? 0) > (source.match(/[A-Za-z]/g)?.length ?? 0);
  const isNew = (t: Token) => !rawKeys.has(t.key) && !rawLower.has(t.text.toLowerCase());
  for (const t of polishedTokens.filter(isNew)) {
    const lower = t.text.toLowerCase();
    const newName = hasCapital(t) && (acronym(t) || !t.first);
    if (newName || /\d/.test(t.text) || (koreanAnswer && /[A-Za-z]/.test(t.text)) || FACT_LIKE_WORDS.has(t.key) || SIZE_WORD.test(lower) || TOOL_TERMS.includes(lower)) {
      return { ok: false, reason: "new_term", detail: `adds "${t.text}"` };
    }
  }
  const fresh = content(polishedTokens).filter((t) => !rawKeys.has(t.key));

  // 6. Style: no em dash, no opening "I", and no stock phrase the candidate didn't use themselves.
  const own = new Set(styleViolations(source, { maxLength: Infinity }));
  const style = styleViolations(text, { maxLength: Infinity, firstPerson: true }).filter((v) => v === "em_dash" || v === "first_person" || !own.has(v));
  if (style.length) return { ok: false, reason: "style", detail: style.join(", ") };

  // 2. Mostly the candidate's own words.
  const total = content(polishedTokens).length;
  if (fresh.length > Math.max(2, Math.floor(total * 0.25))) return { ok: false, reason: "drift", detail: `${fresh.length} of ${total} words are new` };

  // 5. About as long as what they typed, at most three sentences.
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (text.length > Math.min(Math.max(400, source.length), source.length * 1.25 + 20) || sentences > 3) return { ok: false, reason: "length", detail: `${text.length} characters, ${sentences} sentences` };
  return { ok: true };
}

/** The tool-error text the interviewer sees when a revision is refused. */
export function polishRefusal(result: Exclude<PolishGateResult, { ok: true }>): string {
  const why: Record<typeof result.reason, string> = {
    numbers: `it ${result.detail} compared with what the candidate typed`,
    dropped: `it ${result.detail}, which the candidate typed`,
    new_term: `it ${result.detail}, which the candidate did not type`,
    style: `it breaks the style rules (${result.detail})`,
    drift: `too much of it is new wording (${result.detail})`,
    length: `it is too long (${result.detail})`,
  };
  return `Not shown: ${why[result.reason]}. Keep their original wording, or try once more with their own words.`;
}
