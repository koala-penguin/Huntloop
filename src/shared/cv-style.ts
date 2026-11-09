/**
 * How CV text and the interviewer's revisions should read: plain, human and short. One list of
 * phrases that make text sound machine-written, checked in code (revisions of the candidate's
 * answers) and given to the writers as a rule.
 */

export const BANNED_PHRASES_EN = [
  "spearheaded",
  "leveraged",
  "leverage",
  "synergy",
  "synergies",
  "passionate",
  "results-driven",
  "dynamic",
  "proven track record",
  "delve",
  "robust",
  "seamless",
  "seamlessly",
  "cutting-edge",
  "utilize",
  "utilized",
  "game-changer",
  "game changing",
  "drive impact",
  "unlock",
  "empower",
  "empowered",
  "elevate",
  "foster",
  "fostered",
  "orchestrated",
  "championed",
  "best-in-class",
  "world-class",
  "thought leader",
  "go-to",
  "wearing many hats",
  "hit the ground running",
  "excited to",
  "in today's",
  "fast-paced",
  "stakeholders across",
  "holistic",
  "impactful",
  "innovative solutions",
  "transformative",
  "revolutionize",
  "streamline",
  "streamlined",
  "i am a",
] as const;

export const BANNED_PHRASES_KO = ["혁신적인", "시너지", "열정적인", "주도적으로 이끌었습니다", "성공적으로 수행"] as const;

export const BANNED_PHRASES: readonly string[] = [...BANNED_PHRASES_EN, ...BANNED_PHRASES_KO];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word, case-insensitive (Korean phrases match anywhere: particles follow them). */
function phrasePresent(text: string, phrase: string): boolean {
  if (/[\p{Script=Hangul}]/u.test(phrase)) return text.includes(phrase);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escape(phrase).replace(/'/g, "['’]")}(?=$|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export type StyleViolation = string;

/**
 * Banned phrases found in `text`, plus "em_dash", "too_long" (over `maxLength`) and, with
 * `firstPerson`, "first_person" when it opens with "I".
 */
export function styleViolations(text: string, options: { maxLength?: number; firstPerson?: boolean } = {}): StyleViolation[] {
  const found: string[] = BANNED_PHRASES.filter((p) => phrasePresent(text, p));
  if (text.includes("—")) found.push("em_dash");
  if (text.length > (options.maxLength ?? 220)) found.push("too_long");
  if (options.firstPerson && /^\s*i\b/i.test(text)) found.push("first_person");
  return found;
}

/** For prompts: how revised answers and CV lines should read. */
export const STYLE_RULES = `Plain, human, concise. One idea per sentence. No em dashes. Past tense for ended roles, present for the current one. No first person in CV text. Never add a number, tool, employer, team size or adjective the candidate did not type.
Never use these words or phrases: ${BANNED_PHRASES.join(", ")}.`;
