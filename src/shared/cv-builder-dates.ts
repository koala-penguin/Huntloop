/**
 * Dates and a few fixed words read out of what the candidate typed in the CV-builder session. Code uses
 * these to decide what a data step may keep: a date only when they typed it, "still there" only
 * when they said so, a level or status only when its word is in their message.
 */

const YEAR = "(?:19|20)\\d{2}";
const MONTH_NAMES = ["jan(?:uary)?", "feb(?:ruary)?", "mar(?:ch)?", "apr(?:il)?", "may", "june?", "july?", "aug(?:ust)?", "sep(?:t(?:ember)?)?", "oct(?:ober)?", "nov(?:ember)?", "dec(?:ember)?"];
const NAME = `(${MONTH_NAMES.join("|")})`;

/**
 * One alternative per way of writing a date, most specific first. Groups: 1-2 Korean, 3-5 year
 * first, 6-7 month name then year, 8-9 year then month name, 10-11 month first, 12 a year alone.
 */
const DATE = new RegExp(
  [
    `(?<!\\d)(${YEAR})년(?:\\s*(\\d{1,2})월)?`,
    `(?<!\\d)(${YEAR})(?:[-/.](\\d{1,2})|\\.\\s(\\d{1,2})\\.)(?!\\d)`,
    `\\b${NAME}\\.?,?\\s+(${YEAR})(?!\\d)`,
    `(?<!\\d)(${YEAR})\\s+${NAME}\\b`,
    `(?<!\\d[-/.])(?<!\\d)(\\d{1,2})[-/.](${YEAR})(?!\\d)`,
    `(?<!\\d)(${YEAR})(?!\\d)`,
  ].join("|"),
  "gi",
);

const monthNumber = (name: string) => MONTH_NAMES.findIndex((m) => new RegExp(`^${m}$`, "i").test(name)) + 1;

function withMonth(year: string, month: number | null): string {
  return month !== null && month >= 1 && month <= 12 ? `${year}-${String(month).padStart(2, "0")}` : year;
}

export interface DateMention {
  /** "YYYY-MM", or "YYYY" when no month was typed. */
  value: string;
  index: number;
}

/**
 * Every date in a text, in the order typed, each once at its most specific. A month is kept only
 * when it is 1 to 12 ("2020-21", an academic year, is 2020); a full day/month/year date gives the
 * year only, because which number is the month can't be known. Two-digit years and relative dates
 * ("last June") are left out on purpose.
 */
export function dateMentions(text: string): DateMention[] {
  const out: DateMention[] = [];
  for (const m of text.normalize("NFKC").matchAll(DATE)) {
    const index = m.index ?? 0;
    if (m[1]) out.push({ value: withMonth(m[1], m[2] ? Number(m[2]) : null), index });
    else if (m[3]) out.push({ value: withMonth(m[3], Number(m[4] ?? m[5])), index });
    else if (m[7]) out.push({ value: withMonth(m[7], monthNumber(m[6])), index });
    else if (m[8]) out.push({ value: withMonth(m[8], monthNumber(m[9])), index });
    else if (m[11]) out.push({ value: withMonth(m[11], Number(m[10])), index });
    else if (m[12]) out.push({ value: m[12], index });
  }
  return out;
}

/** "I still work there", in the words people use for it. Not bare 재직: 재직했습니다 is past tense. */
export function hasPresentWord(text: string): boolean {
  return /\b(present|current(ly)?|now|still|ongoing|to date|today)\b|현재|지금|재직\s*중|근무\s*중|다니고\s*있/i.test(plainText(text));
}

/**
 * A typed text as the word lists read it: full-width forms folded, and curly apostrophes made
 * straight (a phone types "don’t", the lists say "don't").
 */
export function plainText(text: string): string {
  return text.normalize("NFKC").replace(/[’‘ʼ]/g, "'");
}

/**
 * The words that stand for each value of a fixed list, in English and Korean. A value the model
 * proposes is kept only when one of its words is in a message the candidate typed.
 */
export const ENUM_WORDS = {
  languageLevel: {
    native: /\bnative\b|mother tongue|first language|원어민|모국어/i,
    fluent: /\bfluent(ly)?\b|유창/i,
    professional: /\bprofessional\b|\bbusiness\b|working proficiency|업무|비즈니스/i,
    conversational: /\bconversational\b|일상/i,
    basic: /\bbasic\b|\bbeginner\b|기초|초급/i,
  },
  currentStatus: {
    employed: /\b(work(ing|s)?|employed|job)\b|일하|근무|재직|다니/i,
    between_roles: /between (jobs|roles)|unemployed|out of work|laid off|made redundant|구직|실직|퇴사/i,
    studying: /\bstud(y|ying|ent)\b|학생|재학|공부/i,
    on_break: /\b(break|sabbatical|parental leave|time off)\b|쉬는|쉬고|휴직|육아/i,
    self_employed: /self[- ]employed|freelanc|contractor|my own business|프리랜서|자영업|개인사업/i,
  },
  seniority: {
    intern: /\bintern(ship)?\b|인턴/i,
    junior: /\bjunior\b|\bgraduate\b|주니어|신입/i,
    mid: /\bmid([- ]level)?\b|\bintermediate\b|중급|미드/i,
    senior: /\bsenior\b|시니어|선임/i,
    lead: /\blead\b|리드|팀장/i,
    principal: /\bprincipal\b|\bstaff\b|수석/i,
    manager: /\bmanager\b|매니저|관리자/i,
    // Not bare 이사 or 대표: they also mean "moving house" and "typical".
    director: /\bdirector\b|\bhead of\b|디렉터|이사님|등기이사|본부장/i,
    executive: /\bexecutive\b|\bc-level\b|\bchief\b|\bvp\b|vice president|임원|경영진|대표이사/i,
  },
  /** Who the candidate is, from how they describe their situation. */
  persona: {
    no_cv: /\bno (cv|resume|résumé)\b|(don'?t|do not|never) (have|had|made|written) an? (cv|resume|résumé)|without an? (cv|resume|résumé)|(이력서|cv)(가|는|도)?\s*(없|처음)/i,
    career_changer: /chang(e|ing) (my )?(career|field|industr)|career change|switch(ing)? (career|field|industr)|mov(e|ing) into (a )?(new|different)|transition(ing)? (in)?to|\bpivot|전직|이직.*다른|직무\s*전환|커리어\s*전환|업종\s*(변경|전환)|분야를?\s*바꾸|다른 분야/i,
    returning: /(?<!not )(?<!n't )return(ing)? to work|back (to|into) work|career break|after a break|time (off|out)|parental leave|maternity|raising (my )?(kids|children|family)|stay[- ]at[- ]home|복직|재취업|경력\s*단절|육아|쉬다가|쉬었/i,
    // Moving to a country or "here", never just "moved to" (a new team is not a new market).
    migrant: /new to (this country|the country|australia|new zealand|nz|singapore|the us|the usa|america|canada|the uk|korea|(the|this) (job )?market)|(just|recently) (arrived|immigrated|migrated)|moved (here|to (this country|the country|australia|new zealand|nz|singapore|the us|the usa|america|canada|the uk|korea))\b|relocated (here|to (this country|the country|australia|new zealand|nz|singapore|the us|the usa|america|canada|the uk|korea))\b|immigra|\bmigrant|이민|이주해|이주했|(으)?로 이사\s*(왔|와서|와)|해외에서 (왔|일)|한국에서 (왔|일)|새로 왔/i,
    // Recent forms only: "I graduated in 2005" is not a recent graduate, and a first job long ago or training new staff (신입사원 교육) says nothing.
    graduate: /\b(just|recently|newly) graduated\b|\b(recent|new|fresh) grad(uate)?\b|graduat(e|ing) (this|next) (year|month|semester|summer)|about to graduate|just finished (uni|university|college|school|my degree|my studies)|fresh out of|(looking for|seeking|want|need|find(ing)?) (my|a) first (real |proper )?job|막 졸업|갓 졸업|최근(에)? 졸업|올해 졸업|졸업 예정|졸업을 앞|신입(으로|입니다|이에요|이라)|첫 직장을 (구|찾)|취업 준비|취준/i,
    // Their own title, not someone else's ("I report to the director"). 이사 and 대표 only as a title they hold: alone they also mean "moving house" and "typical".
    senior_exec: /(?<!\b(?:to|with|for|by|from|under) (?:the|a|an|our|my|their) )\b(executive|director|head of)\b|\bc-level\b|\bc-suite\b|\b(ceo|cto|cfo|coo|cio|cdo)\b|\bvp\b|vice president|general manager|senior leader|임원|대표이사|이사님|등기이사|본부장|상무|전무|(이사|대표)(입니다|로 (재직|근무|일))/i,
  },
  workplace: {
    onsite: /\bon[- ]?site\b|in the office|in[- ]person|출근|사무실/i,
    hybrid: /\bhybrid\b|하이브리드/i,
    remote: /\bremote(ly)?\b|work from home|\bwfh\b|원격|재택/i,
  },
  employmentType: {
    full_time: /\bfull[- ]?time\b|\bpermanent\b|정규직|풀타임/i,
    part_time: /\bpart[- ]?time\b|파트타임|시간제/i,
    contract: /\bcontract(or|ing)?\b|\bfixed[- ]term\b|계약직/i,
    casual: /\bcasual\b|\btemp(orary)?\b|임시직|아르바이트|알바/i,
    internship: /\bintern(ship)?\b|인턴/i,
  },
} as const;

export type EnumKind = keyof typeof ENUM_WORDS;

/** Whether one of the value's words is in a message the candidate typed. */
export function enumGrounded(kind: EnumKind, value: string, messages: string[]): boolean {
  const list = ENUM_WORDS[kind] as Record<string, RegExp>;
  if (!Object.hasOwn(list, value)) return false;
  return messages.some((m) => list[value].test(plainText(m)));
}

/** The first value of a list whose word is in the text (used by the demo interviewer). */
export function enumIn<K extends EnumKind>(kind: K, text: string): keyof (typeof ENUM_WORDS)[K] | null {
  const hit = Object.entries(ENUM_WORDS[kind] as Record<string, RegExp>).find(([, words]) => words.test(plainText(text)));
  return (hit?.[0] as keyof (typeof ENUM_WORDS)[K] | undefined) ?? null;
}
